import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  REVIEW_BLOCKED,
  REVIEW_COVERAGE,
  REVIEW_MATCHES,
  REVIEW_OPEN,
  REVIEW_RELATED,
  REVIEW_ROOTS,
  type readyReviewRpc,
} from "../../shared/api.ts";
import { sameLabel } from "../../shared/labels.ts";
import { closed, hasLiveRun, refId, type Task, unheld } from "../../shared/model.ts";
import { prLabel } from "../delivery.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import type { MatchedBy, MergedPr } from "../tracker/merged.ts";
import { mergedCandidates, namedIds } from "../tracker/merged.ts";
import { classify } from "./candidates.ts";
import { ancestorsOf, chainsOf, type Root } from "./chains.ts";
import type { ReadContext } from "./reads.ts";
import { reconcileNext } from "./reconcile.ts";
import { resolveSpaces, resolveTaskForRead, type SpaceEntry } from "./resolve.ts";
import { alikeLines, alikeTitles, commonStems, normalLine, shared, stems, textRanking } from "./similarity.ts";
import { activityText, cut, localRun, plannedBranch, sortTasks, tasksOf } from "./view.ts";

/**
 * The review of the open cards before a start (06-god-mode.md, Ready review): what start_candidates
 * and reconcile know, put per card with what covers it already, how that is known, what is still open
 * and the next step, plus the dependency roots that hold the most cards back.
 *
 * Only the card's own facts confirm anything: a merged PR/MR tied to it and its ticked acceptance
 * lines. A similar title, a shared branch, a mention in another PR/MR's description or lines worded
 * like another card's are signals for a person to compare, and are said as such. What could not be
 * read is listed per card. Read only: it changes no status, closes no card and starts no agent; the
 * only effect is the forge reading reconcile already makes, kept in memory.
 */

type Review = RpcOutput<typeof readyReviewRpc>;
type Card = Review["tasks"][number];
type Related = Card["related"][number];
type OwnPr = Card["prs"][number] & { own: boolean };
type Coverage = (typeof REVIEW_COVERAGE)[number];

/** How long a read of one card waits for its forge (Paseo stops waiting at 30 s). */
const TASK_WAIT_MS = 20_000;
/** A reading older than this is said to be old: the tracker reads every fifteen minutes. */
const STALE_MS = 60 * 60_000;
const LINE_CHARS = 160;
/** A criterion more cards of a project carry than this is boilerplate: alike lines of it relate nothing. */
const BOILERPLATE_CARDS = 3;

/** Ties that name the card itself: enough on their own to call a PR/MR the card's. */
const NAMING: MatchedBy[] = ["id_in_title", "id_in_branch", "closes_issue"];

const TIE_WORDS: Record<MatchedBy, string> = {
  id_in_title: "its title names the card",
  id_in_branch: "its branch names the card",
  closes_issue: "it closed the card's issue",
  link: "the card links it",
  branch: "it is on the card's branch",
  id_in_description: "its description mentions the card",
};

/** What one task is compared by, worked out once per space. */
interface Compared {
  task: Task;
  loaded: LoadedEntity;
  title: Set<string>;
  branch: string;
  /** The ids its brief, notes, links and handoff name. */
  mentions: Set<string>;
  deps: Set<string>;
  /** Its ticked acceptance lines, boilerplate ones left out. */
  ticked: { text: string; stems: Set<string> }[];
}

interface SpaceFacts {
  space: SpaceEntry;
  plan: Plan;
  byProject: Map<string, Compared[]>;
  byId: Map<string, Compared>;
  /** PR/MR URL → the tasks whose run reported it, and those that link it. */
  claims: Map<string, string[]>;
  links: Map<string, string[]>;
  /** Project and branch → every task that plans or ran on it, canceled ones too. */
  branches: Map<string, string[]>;
  /** Project and criterion that so many cards carry that it says nothing about two of them. */
  boilerplate: Set<string>;
  ancestors: (id: string) => ReadonlySet<string>;
  /** How much two cards of one project share in text, for the order of related cards. */
  closeness: (project: string, a: string, b: string) => number;
}

const loadedTasks = (plan: Plan) => tasksOf(plan).map((task) => ({ task, loaded: plan.entities.get(task.id)! }));

const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
/** A branch or a criterion belongs to one project's repository. */
const inProject = (project: string, value: string) => `${project}\n${value}`;

function spaceFacts(space: SpaceEntry): SpaceFacts {
  const plan = space.sync.plan;
  const skip = stems([plan.space?.key ?? "", ...Object.keys(plan.space?.projects ?? {})].join(" "));
  const byProject = new Map<string, Compared[]>();
  const byId = new Map<string, Compared>();
  const claims = new Map<string, string[]>();
  const links = new Map<string, string[]>();
  const branches = new Map<string, string[]>();
  const lines = new Map<string, string[]>();
  const all = loadedTasks(plan);
  for (const { task, loaded } of all) {
    if (!task.project) continue;
    for (const key of new Set(loaded.acceptance.map((line) => inProject(task.project!, normalLine(line.text))))) add(lines, key, task.id);
  }
  const boilerplate = new Set([...lines].filter(([, ids]) => ids.length > BOILERPLATE_CARDS).map(([key]) => key));
  for (const { task, loaded } of all) {
    if (task.run_pr) add(claims, task.run_pr, task.id);
    for (const link of new Set(task.links.map((link) => link.trim()))) add(links, link, task.id);
    if (!task.project) continue;
    const branch = task.run_branch ?? plannedBranch(plan, task);
    add(branches, inProject(task.project, branch), task.id);
    if (task.status === "canceled") continue;
    const item: Compared = {
      task,
      loaded,
      title: stems(task.title, skip),
      branch,
      mentions: new Set(namedIds([loaded.brief, loaded.notes, loaded.handoff?.text ?? "", ...task.links].join("\n"))),
      deps: new Set(task.depends_on.flatMap((ref) => refId(ref) ?? [])),
      ticked: loaded.acceptance.filter((a) => a.done && !boilerplate.has(inProject(task.project!, normalLine(a.text)))).map((a) => ({ text: a.text, stems: stems(a.text) })),
    };
    byId.set(task.id, item);
    byProject.set(task.project, [...(byProject.get(task.project) ?? []), item]);
  }
  // Words most titles of a project share tell nothing apart: dropped after all are read.
  for (const items of byProject.values()) {
    const common = commonStems(items.map((item) => item.title));
    for (const item of items) for (const word of common) item.title.delete(word);
  }
  // Read only for the projects whose cards have related ones.
  const rankings = new Map<string, ReturnType<typeof textRanking>>();
  const closeness = (project: string, a: string, b: string) => {
    let ranking = rankings.get(project);
    if (!ranking) {
      const texts = (byProject.get(project) ?? []).map(({ task, loaded }) => [task.id, stems([task.title, loaded.brief, ...loaded.acceptance.map((line) => line.text)].join("\n"), skip)] as const);
      ranking = textRanking(new Map(texts));
      rankings.set(project, ranking);
    }
    return ranking(a, b);
  };
  return { space, plan, byProject, byId, claims, links, branches, boilerplate, ancestors: ancestorsOf(plan), closeness };
}

/** A PR/MR another card's run reported, as this Mac knows its state. */
function recordedState(ctx: ReadContext, facts: SpaceFacts, task: Task, url: string): { state: string; sha: string } {
  const listed = ctx.dashboard.merged.listed(facts.plan.space?.key ?? "", task.project ?? "", url);
  if (listed) return { state: listed.state, sha: listed.mergeSha ?? "" };
  const seen = ctx.dashboard.prs.seen.get(task.id);
  if (seen && seen.url === url) return { state: seen.state, sha: "" };
  return { state: "recorded, state not read here", sha: "" };
}

/**
 * The card's PR/MRs: the merged ones found for it, and the one a run of it reported. A found one is
 * the card's own when its run reported it, its branch names the card or it closed the card's issue;
 * when its title names the card and no other card's run reported it; or, tied only by a link or the
 * branch, when nothing gives it to another card: no other run reported it, it names no other card,
 * and no other card links it (for a link) or shares the branch (for a branch).
 */
function ownPrs(ctx: ReadContext, facts: SpaceFacts, task: Task): { prs: OwnPr[]; merged: MergedPr[] } {
  const found = ctx.dashboard.merged.shown(facts.plan, task);
  const others = (ids: string[] | undefined) => (ids ?? []).filter((id) => id !== task.id);
  const listed = (ids: string[]) => ids.slice(0, 3).join(", ");
  const prs: OwnPr[] = [];
  const merged: MergedPr[] = [];
  for (const pr of found) {
    const claimed = others(facts.claims.get(pr.url));
    const names = others(pr.names).filter((id) => facts.plan.entities.get(id)?.entity.type === "task");
    const linked = others(facts.links.get(pr.url));
    const sharing = pr.branch ? others(facts.branches.get(inProject(task.project ?? "", pr.branch))) : [];
    const unclaimed = !claimed.length && !names.length;
    const own =
      pr.url === task.run_pr ||
      pr.by.includes("id_in_branch") ||
      pr.by.includes("closes_issue") ||
      (pr.by.includes("id_in_title") && !claimed.length) ||
      (unclaimed && pr.by.includes("link") && !linked.length) ||
      (unclaimed && pr.by.includes("branch") && !sharing.length);
    const ways = pr.by.map((way) => TIE_WORDS[way]).join("; ");
    const doubts = [
      claimed.length ? `it is the PR/MR of ${listed(claimed)}` : "",
      names.length ? `it names ${listed(names)}` : "",
      linked.length && pr.by.includes("link") ? `${listed(linked)} links it too` : "",
      sharing.length && pr.by.includes("branch") ? `its branch is shared with ${listed(sharing)}` : "",
    ];
    prs.push({ pr: pr.label, url: pr.url, state: "merged", tie: own ? ways : [ways, ...doubts, "a signal, not proof"].filter(Boolean).join("; "), own });
    if (own) merged.push(pr);
  }
  const url = task.run_pr;
  if (url && !prs.some((pr) => pr.url === url)) {
    const { state, sha } = recordedState(ctx, facts, task, url);
    prs.push({ pr: prLabel(url), url, state, tie: hasLiveRun(task) ? "its run reported it" : "an earlier run of the card reported it", own: true });
    if (state === "merged") merged.push({ label: prLabel(url), url, merged_at: "", ...(sha ? { sha } : {}), by: [] });
  }
  return { prs, merged };
}

const hasWork = (ctx: ReadContext, plan: Plan, task: Task) =>
  task.status === "done" || task.status === "review" || task.status === "in_progress" || Boolean(task.run_pr) || ctx.dashboard.merged.shown(plan, task).length > 0;

/** A third card both build on: one depends on it and the other depends on it or names it. */
function sharedOrigin(plan: Plan, a: Compared, b: Compared): string | undefined {
  const from = (x: Compared, y: Compared) => [...x.deps].find((id) => id !== y.task.id && (y.deps.has(id) || y.mentions.has(id)) && plan.entities.has(id));
  return from(a, b) ?? from(b, a);
}

/** Matching lines that relate two cards with nothing else in common. */
const LINES_ALONE = 2;

/**
 * Cards of the same project that look like the same work. Cards one of which waits for the other are
 * steps of one chain, not duplicates. Any one of these relates two cards: a shared branch; an alike
 * title; two open lines worded like lines ticked on the other; for work that exists already, a shared
 * label and title word on top of a third card both build on, or a mention together with a matching
 * line.
 */
function relatedOf(ctx: ReadContext, facts: SpaceFacts, own: Compared): { related: Related[]; more: number; matched: Set<string> } {
  const { task } = own;
  const open = own.loaded.acceptance
    .filter((a) => !a.done && !facts.boilerplate.has(inProject(task.project!, normalLine(a.text))))
    .map((a) => ({ text: a.text, stems: stems(a.text) }));
  const found: (Related & { work: boolean; lines: string[]; close: number })[] = [];
  for (const other of facts.byProject.get(task.project ?? "") ?? []) {
    const id = other.task.id;
    if (id === task.id || facts.ancestors(task.id).has(id) || facts.ancestors(id).has(task.id)) continue;
    const work = hasWork(ctx, facts.plan, other.task);
    const signals: string[] = [];
    if (own.branch === other.branch) signals.push(`shares branch ${own.branch}`);
    const words = shared(own.title, other.title);
    if (alikeTitles(own.title, other.title)) signals.push("similar title");
    else if (work && words.length) {
      const label = task.labels.find((mine) => other.task.labels.some((theirs) => sameLabel(mine, theirs)));
      const origin = label ? sharedOrigin(facts.plan, own, other) : undefined;
      if (origin) signals.push(`label ${label}, a shared title word, both build on ${origin}`);
    }
    const mention = own.mentions.has(id) ? "this card mentions it" : other.mentions.has(task.id) ? "it mentions this card" : "";
    const matches: Related["matches"] = [];
    const lines: string[] = [];
    for (const line of open) {
      let best: { text: string; score: number } | undefined;
      for (const theirs of other.ticked) {
        const score = alikeLines(line, theirs);
        if (score > (best?.score ?? 0)) best = { text: theirs.text, score };
      }
      if (!best) continue;
      lines.push(line.text);
      if (matches.length < REVIEW_MATCHES) matches.push({ open: cut(line.text, LINE_CHARS), theirs: cut(best.text, LINE_CHARS) });
    }
    if (!signals.length && !(mention && lines.length) && lines.length < LINES_ALONE) continue;
    if (lines.length >= LINES_ALONE && !signals.length) signals.push("acceptance lines alike");
    if (mention) signals.push(mention);
    found.push({ id, title: other.task.title, status: other.task.status, signals, prs: [], matched: lines.length, matches, work, lines, close: facts.closeness(task.project!, task.id, id) });
  }
  // Matching lines first, then cards whose work exists, then the closest by their whole text.
  found.sort((a, b) => b.matched - a.matched || Number(b.work) - Number(a.work) || b.close - a.close || a.id.localeCompare(b.id));
  return {
    // Each listed card's own PR/MRs only: one merely found for it is not its work either.
    related: found.slice(0, REVIEW_RELATED).map(({ work: _work, lines: _lines, close: _close, ...row }) => ({
      ...row,
      prs: ownPrs(ctx, facts, facts.byId.get(row.id)!.task).prs.filter((pr) => pr.own).slice(0, 3).map(({ pr, url, state }) => ({ pr, url, state })),
    })),
    more: Math.max(0, found.length - REVIEW_RELATED),
    matched: new Set(found.flatMap((row) => row.lines)),
  };
}

/**
 * How old the card's merged PR/MR facts are: the older of its own reading and its project's list of
 * latest merges; "" without both, since a reading without the list has not looked.
 */
function readAt(ctx: ReadContext, plan: Plan, task: Task): string {
  const reading = ctx.dashboard.merged.readingOf(plan, task)?.at;
  const listed = ctx.dashboard.merged.listing(plan.space?.key ?? "", task.project ?? "")?.at;
  if (!reading || !listed) return "";
  return reading < listed ? reading : listed;
}

/** What this Mac could not read or compare about the card. `searched`: its forge was just asked for it. */
function missing(ctx: ReadContext, facts: SpaceFacts, own: Compared | undefined, task: Task, prs: OwnPr[], searched: boolean): string[] {
  const out: string[] = [];
  const { plan, space } = facts;
  if (!task.project || !plan.space?.projects[task.project]) out.push("no project of its space: no repository to look in and nothing to compare with");
  else if (!space.record.mapping[task.project]) out.push(`project ${task.project} is not mapped on this Mac: its PR/MRs are not read here`);
  else if (!mergedCandidates(plan, task)) {
    if (task.run_id) out.push(hasLiveRun(task) ? "a run holds it: merged work beyond its run's PR/MR is not looked for" : "it ran before: merged PR/MRs naming it are not looked for, only the one its run reported is shown");
    else out.push("no creation time to compare merges with: merged PR/MRs are not looked for");
  } else {
    if (!ctx.dashboard.merged.readingOf(plan, task)) out.push("its merged PR/MRs are not read yet on this Mac (or the forge did not answer)");
    const list = ctx.dashboard.merged.listing(plan.space.key, task.project);
    if (!list) out.push(`the latest merged PR/MRs of ${task.project} are not read here`);
    // A search for this card reaches past the latest merges; a pass does not.
    else if (!searched && list.since && Date.parse(list.since) > Date.parse(task.created!)) {
      out.push(`only the latest merges of ${task.project} are compared, back to ${list.since.slice(0, 10)}, after the card was created: read this card to search older ones`);
    }
    const at = readAt(ctx, plan, task);
    const now = (ctx.now ?? (() => new Date()))();
    if (!searched && at && now.getTime() - Date.parse(at) > STALE_MS) out.push(`old reading: PR/MRs were last read ${at.slice(0, 16).replace("T", " ")} UTC`);
  }
  for (const pr of prs) if (pr.state.startsWith("recorded")) out.push(`the state of ${pr.pr} is not read here`);
  if (own && !own.loaded.acceptance.length) out.push("it lists no acceptance criteria: coverage cannot be judged by them");
  for (const ref of task.depends_on) {
    const id = refId(ref);
    if (!id || !plan.entities.has(id)) out.push(`dependency ${id ?? ref} is not found`);
  }
  return out;
}

/** A handoff left by a run that no longer holds the card: the live run's own is its work in progress. */
function earlierHandoff(task: Task, loaded: LoadedEntity): LoadedEntity["handoff"] {
  return loaded.handoff && !(hasLiveRun(task) && loaded.handoff.run_id === task.run_id) ? loaded.handoff : undefined;
}

/** The next step by what covers the card; undefined when nothing does, and start_candidates' own step applies. */
function nextOf(card: { coverage: Coverage; basis: string; prs: OwnPr[]; merged: MergedPr[]; related: Related[]; task: Task; loaded: LoadedEntity }): { left: Card["left"]; next: string } | undefined {
  const { coverage, basis, merged, prs, related, task, loaded } = card;
  const total = loaded.acceptance.length;
  const done = loaded.acceptance.filter((a) => a.done).length;
  // A failed QA outweighs every tick: the work is not accepted until it is fixed.
  if (task.delivery?.qa === "failed") {
    const said = task.delivery.qa_note ? `: ${cut(task.delivery.qa_note, 120)}` : "";
    return { left: "fix", next: `QA failed${said}. Fix that only${merged.length ? "; the merged work is not redone" : ""}` };
  }
  if (merged.length) {
    const left = coverage === "confirmed" ? "accept" : total && done < total ? "qa" : "check";
    return { left, next: reconcileNext(merged, loaded.acceptance) };
  }
  if (total && done === total) {
    return { left: "check", next: "every acceptance line is ticked but no merged PR/MR of it is known here: find the work (handoff, links, branch), then mark it done or untick what is not done" };
  }
  if (done) {
    return { left: "implementation", next: `${done} of ${total} lines ticked, no merged PR/MR known here: check the earlier work (handoff, branch) first; a start does only the open lines` };
  }
  const doubtful = prs[0];
  if (doubtful) {
    return { left: "check", next: `check ${doubtful.pr} (${doubtful.state}) before starting: ${doubtful.own ? "an earlier run's work may be there" : "nothing proves it is this card's work"}` };
  }
  if (basis === "similar") {
    const ids = related.filter((row) => row.matched).map((row) => row.id).join(", ");
    return { left: "compare", next: `compare the matching lines with ${ids}; what its work already covers needs no second implementation (the owner decides), start only for the rest` };
  }
  const first = related[0];
  if (first) {
    return { left: "compare", next: `compare with ${first.id} (${first.signals.join(", ")}) before starting. Same work: cancel one as its duplicate (update_task status canceled, duplicate_of); else start it` };
  }
  if (earlierHandoff(task, loaded)) return { left: "check", next: "an earlier run left a handoff: read it (task) before starting, so its work is not done twice" };
  return undefined;
}

const REVIEW_NEXT = "the user tests and accepts its work (accept_task) or sends it back (send_back)";

/** A card with its place in the review's order. */
type Ordered = Card & { order: number };

/** What the card's chain says about it. */
interface Held {
  roots: string[];
  /** On a dependency cycle or behind one. */
  cycle: boolean;
}

const CYCLE_NEXT = "it waits on a dependency cycle that finishing no task frees: fix depends_on first (update_task)";

function review(ctx: ReadContext, facts: SpaceFacts, task: Task, chain: Held, searched: boolean, order: number): Ordered {
  const { roots, cycle } = chain;
  const { plan, space } = facts;
  const loaded = plan.entities.get(task.id)!;
  const own = facts.byId.get(task.id);
  const total = loaded.acceptance.length;
  const done = loaded.acceptance.filter((a) => a.done).length;
  const open = loaded.acceptance.filter((a) => !a.done);
  const { prs, merged } = ownPrs(ctx, facts, task);
  const { related, more, matched } = own ? relatedOf(ctx, facts, own) : { related: [], more: 0, matched: new Set<string>() };

  const earlier = earlierHandoff(task, loaded);

  let coverage: Coverage = "none";
  let basis: Card["basis"] = "";
  if (merged.length && total && done === total && task.delivery?.qa !== "failed") [coverage, basis] = ["confirmed", "own"];
  else if (merged.length || done) [coverage, basis] = ["partial", "own"];
  else if (matched.size) [coverage, basis] = ["possible", "similar"];
  else if (prs.length || related.length || earlier) coverage = "possible";

  const evidence: string[] = [];
  for (const pr of prs) evidence.push(`${pr.pr} ${pr.state}: ${pr.tie}`);
  if (done) evidence.push(`${done} of ${total} acceptance lines ticked on this card`);
  if (task.delivery?.qa && task.delivery.qa !== "pending") evidence.push(`QA ${task.delivery.qa}${task.delivery.qa_at ? ` (${task.delivery.qa_at.slice(0, 10)})` : ""}`);
  if (matched.size) evidence.push(`${matched.size} of ${open.length} open lines read like lines ticked on another card: a text match, not proof`);
  if (earlier) evidence.push(`an earlier run left a handoff (run ${earlier.run_id})`);
  if (more) evidence.push(`${more} more related card${more === 1 ? "" : "s"} not listed`);

  const candidate = (task.status === "todo" && !hasLiveRun(task)) || unheld(task);
  const mapped = Boolean(task.project && space.record.mapping[task.project]);
  const held = candidate ? classify(ctx, plan, task, mapped, loaded.brief) : undefined;
  const waits = task.depends_on.map((ref) => refId(ref) ?? ref).filter((id) => {
    const other = plan.entities.get(id)?.entity;
    return !other || (other.status !== "done" && other.status !== "canceled");
  });
  const covered = nextOf({ coverage, basis, prs, merged, related, task, loaded });
  const left = covered?.left ?? "implementation";
  let next = covered?.next ?? held?.next ?? "follow it (task)";
  if (!covered && held?.group === "dependencies" && roots.length) next = `begin with ${roots.slice(0, 3).join(", ")}: this card waits for it`;
  if (!covered && cycle) next = CYCLE_NEXT;
  // What also holds the start, when the step above is about coverage and not about that hold.
  if (covered && held && held.group !== "agent" && held.group !== "merged") next = `${next}. Also held: ${cycle ? CYCLE_NEXT : held.reason}`;
  // Work in review or held by a run goes on as it does anywhere: the coverage above gives no other step.
  if (task.status === "review") next = REVIEW_NEXT;
  else if (hasLiveRun(task)) next = "a run holds it: follow it (task); start nothing";

  return {
    id: task.id,
    title: task.title,
    project: task.project ?? "",
    status: task.status,
    group: held?.group ?? "",
    coverage,
    basis,
    evidence,
    prs: prs.map(({ own: _own, ...pr }) => pr),
    acceptance: { done, total },
    open: open.slice(0, REVIEW_OPEN).map((a) => cut(a.text, LINE_CHARS)),
    related,
    left,
    next: cut(next, 400),
    waits_for: waits,
    roots,
    incomplete: missing(ctx, facts, own, task, prs, searched),
    read_at: readAt(ctx, plan, task),
    order,
  };
}

/** A root as listed: what to do about it, by the state it is in. */
function rootRow(ctx: ReadContext, facts: SpaceFacts, root: Root, card: () => Card): Review["roots"][number] {
  const { task } = root;
  const base = { id: root.id, blocks: root.blocked.length, direct: root.direct, blocked: root.blocked.slice(0, REVIEW_BLOCKED) };
  if (!task) {
    return { ...base, title: "(not found)", status: "missing", project: "", next: "no task has this id: fix or remove the reference (update_task depends_on)" };
  }
  let next: string;
  if (task.status === "review") next = REVIEW_NEXT;
  else if (hasLiveRun(task)) next = `under way, ${activityText(task, ctx.host, localRun(ctx.dashboard.runs, task)) || "run held"}: follow it (task); the cards wait until it is done`;
  else if (task.status === "inbox") next = "an inbox draft: the user accepts it first (update_task status todo)";
  else next = card().next;
  return { ...base, title: task.title, status: task.status, project: task.project ?? "", next: cut(next, 400) };
}

/**
 * Asks the forge about one card now, as reconcile does. `searched`: it answered with a new reading;
 * `late`: what to say when it did not; both empty for a card that is not looked up.
 */
async function readNow(ctx: ReadContext, space: SpaceEntry, task: Task): Promise<{ searched: boolean; late: string }> {
  const plan = space.sync.plan;
  if (!task.project || !space.record.mapping[task.project] || !mergedCandidates(plan, task)) return { searched: false, late: "" };
  const tracker = ctx.dashboard.merged;
  const before = tracker.seen.get(task.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TASK_WAIT_MS);
  });
  await Promise.race([tracker.check({ sync: space.sync, mapping: space.record.mapping }, task, { search: true }).catch(() => undefined), late]).finally(() => clearTimeout(timer));
  const searched = tracker.seen.get(task.id) !== before;
  return { searched, late: searched ? "" : "the forge did not answer now: this is the last reading, if any" };
}

const RANK: Record<Coverage, number> = { confirmed: 0, partial: 1, possible: 2, none: 3 };

/** `TST-AB001 partial, left qa, #4, like TST-AB002`: a card in the little a spoken answer has room for. */
function summaryLine(card: Card): string {
  const prs = card.prs.map((pr) => pr.pr).slice(0, 2).join(" ");
  const like = card.related.map((row) => row.id).slice(0, 2).join(" ");
  return [`${card.id} ${card.coverage}${card.basis === "similar" ? " (text)" : ""}`, `left ${card.left}`, prs, like && `like ${like}`, card.waits_for.length ? `waits ${card.waits_for[0]}` : "", card.incomplete.length ? "data incomplete" : ""]
    .filter(Boolean)
    .join(", ");
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One card's own place in the chains: what it waits for and what it holds. */
function chainOfOne(card: Card, roots: Review["roots"]): string {
  const held = roots.find((root) => root.id === card.id);
  if (held) return `This card holds ${plural(held.blocks, "card")} back.`;
  if (card.roots.length) return `This card waits; begin with ${card.roots.slice(0, 3).join(", ")}.`;
  return card.waits_for.length ? "" : "This card waits for no other and holds none.";
}

export async function readyReview(ctx: ReadContext, input: RpcInput<typeof readyReviewRpc>): Promise<Review> {
  const fail = (error: string): Review => ({ note: "", summary: [], counts: {}, roots: [], roots_total: 0, tasks: [], total: 0, projects: [], error });
  const dashboard = ctx.dashboard;
  if (!dashboard.owner && dashboard.ownerReason) return fail(dashboard.ownerReason);

  let spaces: SpaceEntry[];
  let one: { task: Task; searched: boolean; late: string } | undefined;
  if (input.task) {
    const { found } = resolveTaskForRead([...dashboard.spaces.values()], input.task);
    if (!found.ok) return fail(found.error);
    const { entity: task, space } = found.value;
    if (closed(task)) return { ...fail(""), note: `${task.id} is ${task.status}: nothing to review before a start.` };
    spaces = [space];
    const asked = await readNow(ctx, space, task);
    // A sync during the read replaces the plan: the card is read from the plan as it is now.
    const fresh = space.sync.plan.entities.get(task.id)?.entity;
    if (fresh?.type !== "task" || closed(fresh)) return { ...fail(""), note: `${task.id} changed while its forge was asked: read again.` };
    one = { task: fresh, ...asked };
  } else {
    const resolved = resolveSpaces(dashboard, input.space);
    if (!resolved.ok) return fail(resolved.error);
    spaces = resolved.value;
  }

  const projects = [...new Set(spaces.flatMap((space) => Object.keys(space.sync.plan.space?.projects ?? {})))].sort();
  const asked = input.task ? undefined : input.project?.trim().toLowerCase();
  const project = asked ? projects.find((key) => key.toLowerCase() === asked) : undefined;
  if (asked && !project) return fail(`No project «${input.project!.trim()}» here; projects: ${projects.join(", ") || "none"}.`);

  const cards: Ordered[] = [];
  const roots: { row: Review["roots"][number]; at: number }[] = [];
  let cycles = 0;
  let order = 0;
  for (const space of spaces) {
    const facts = spaceFacts(space);
    const plan = facts.plan;
    const inScope = (task: Task) => !project || task.project === project;
    const chains = chainsOf(plan, inScope);
    const wanted = one
      ? [one.task]
      : sortTasks(
          tasksOf(plan)
            .filter((task) => inScope(task) && ((task.status === "todo" && !hasLiveRun(task)) || unheld(task)))
            .map((task) => ({ plan, task })),
        ).map((item) => item.task);
    const reviewed = new Map<string, Ordered>();
    const cardOf = (task: Task): Ordered => {
      let card = reviewed.get(task.id);
      if (!card) {
        const chain = { roots: chains.rootsOf.get(task.id) ?? [], cycle: chains.cycles.includes(task.id) };
        card = review(ctx, facts, task, chain, one?.task.id === task.id && one.searched, (order += 1));
        reviewed.set(task.id, card);
      }
      return card;
    };
    for (const task of wanted) {
      const card = cardOf(task);
      if (one?.late) card.incomplete.unshift(one.late);
      cards.push(card);
    }
    cycles += one ? Number(chains.cycles.includes(one.task.id)) : chains.cycles.length;
    const listed = one ? chains.roots.filter((root) => root.id === one!.task.id || root.blocked.includes(one!.task.id)) : chains.roots;
    for (const root of listed) {
      roots.push({ row: rootRow(ctx, facts, root, () => cardOf(root.task!)), at: roots.length });
    }
  }
  // Old readings are refreshed in the background, as reconcile does; this answer does not wait.
  if (!one) dashboard.merged.peek();

  roots.sort((a, b) => b.row.blocks - a.row.blocks || b.row.direct - a.row.direct || a.at - b.at);
  const counts: Record<string, number> = Object.fromEntries(REVIEW_COVERAGE.map((coverage) => [coverage, 0]));
  counts.incomplete = 0;
  for (const card of cards) {
    counts[card.coverage] = (counts[card.coverage] ?? 0) + 1;
    if (card.incomplete.length) counts.incomplete += 1;
  }
  cards.sort((a, b) => RANK[a.coverage] - RANK[b.coverage] || a.order - b.order);
  const note = cut(
    [
      `${cards.length} card${cards.length === 1 ? "" : "s"}${project ? ` of ${project}` : ""}: ${counts.confirmed} confirmed, ${counts.partial} partial, ${counts.possible} possible, ${counts.none} nothing found; ${counts.incomplete} with incomplete data.`,
      one ? chainOfOne(cards[0]!, roots.map(({ row }) => row)) : roots[0] ? `Next for the chain: ${roots[0].row.id} holds ${plural(roots[0].row.blocks, "card")}.` : "No open card holds others back.",
      cycles ? (one ? "It waits on a dependency cycle." : `${cycles} wait on a dependency cycle.`) : "",
      "Read only: nothing changed or started. A title or branch alike is only a signal.",
      one ? "" : "PR/MR facts are this Mac's last reading; name one task to read it now.",
    ]
      .filter(Boolean)
      .join(" "),
    500,
  );
  const page = cards.slice(0, input.limit ?? 8).map(({ order: _order, ...card }) => card);
  // The order of the keys is the order God Mode reads the answer out in, before it cuts it short.
  return {
    note,
    summary: page.map(summaryLine),
    counts,
    roots: roots.slice(0, REVIEW_ROOTS).map(({ row }) => row),
    roots_total: roots.length,
    tasks: page,
    total: cards.length,
    projects,
    error: "",
  };
}
