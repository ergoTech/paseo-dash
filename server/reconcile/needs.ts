import type { RpcOutput } from "@getpaseo/plugin";
import { closed, hasLiveRun, refId, type Task } from "../../shared/model.ts";
import type { overviewRpc } from "../../shared/overview.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { sortTasks, tasksOf } from "../api/view.ts";
import type { Dashboard } from "../dashboard.ts";
import { type CardFacts, named, type PrFact } from "./facts.ts";
import { mergeBlockers } from "./merge.ts";
import { sourceOf } from "./verdict.ts";
import type { Hold } from "./types.ts";

/**
 * What the reconciliation leaves to be done, in Needs you (06-god-mode.md, Reconcile). Two kinds, both
 * only for the projects this machine reconciles: one `merge` list of every open PR/MR in the order
 * to merge them with each one's blockers apart (CI, review, mergeability, dependencies), and
 * `reconcile` groups, the other cards the rule leaves open, cards that wait for the same thing in
 * one group, each card with the links to the evidence behind it and where the decision comes from.
 * A card that only waits (a check running, a dependency, a run at work) is not listed; one whose step
 * is an agent's (a draft to finish, a build to make) is, since no run is assigned to take it.
 */

export type Item = RpcOutput<typeof overviewRpc>["needs_you"][number];
export type NeedCardRow = NonNullable<Item["cards"]>[number];
type Shown = Omit<Item, "chat_id" | "space" | "since">;

/** Cards one item names; the rest are counted in its reason. */
const CARDS_SHOWN = 12;
const WHY_CHARS = 160;
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** What the first hold of a group is called when several cards share it. */
const GROUP_WORDS: Record<Hold["code"], string> = {
  claim: "held by a run",
  reopened: "reopened after an automatic closing",
  draft: "drafts with merged work",
  review: "in review with no run",
  released: "released back to todo",
  forge: "forge facts not read",
  no_pr: "no merged PR/MR known",
  tie: "merged, not proven to be theirs",
  open_pr: "PR/MR open",
  closed_pr: "PR/MR closed without a merge",
  base: "merged outside the target branch",
  pushed_after: "commits pushed after the merge",
  checks: "merged, checks not verified",
  scope: "scope changed after the merge",
  acceptance: "merged, acceptance open",
  decision: "an open decision",
  manual: "manual acceptance",
  qa: "merged, QA open",
  dependencies: "waiting for other cards",
  report: "verified, waiting for you to mark them done",
};

const labels = (facts: CardFacts | undefined) => (facts?.prs ?? []).map(sourceOf);

/** The first hold of a card that someone has to act on; undefined when none is, or the card only waits. */
function ownersHold(holds: Hold[]): Hold | undefined {
  const first = holds[0];
  return first && first.by !== "wait" ? first : undefined;
}

interface Entry {
  space: SpaceEntry;
  task: Task;
}

export function reconcileNeeds(dashboard: Dashboard, space: SpaceEntry): Shown[] {
  const reconciler = dashboard.reconciler;
  const plan = space.sync.plan;
  const entries: Entry[] = tasksOf(plan)
    .filter((task) => !closed(task) && reconciler.rule(space, task) && reconciler.evidence(space, task))
    .map((task) => ({ space, task }));
  if (!entries.length) return [];
  const out: Shown[] = [];

  const queue = mergeQueue(dashboard, entries);
  // The cards whose open PR/MR the list shows: their "PR/MR open" is said there, not again in a group.
  const listed = new Set(queue.flatMap((row) => [row.task, ...(row.also ?? [])]));

  const groups = new Map<string, { hold: Hold; cards: NeedCardRow[] }>();
  for (const { task } of entries) {
    // A live run's own need (server/needs.ts) already says what waits for the user.
    if (hasLiveRun(task)) continue;
    const verdict = reconciler.verdict(space, task);
    const hold = verdict ? ownersHold(verdict.holds) : undefined;
    if (!verdict || !hold || (hold.code === "open_pr" && listed.has(task.id))) continue;
    const id = `${hold.code}|${hold.group ?? hold.next}`;
    const group = groups.get(id) ?? { hold, cards: [] };
    const evidence = [...labels(reconciler.latest(space, task)), hold.source, ...(hold.extra ?? [])];
    // Every place the decision rests on, each link once.
    const links = evidence.filter((link, index) => link.url && evidence.findIndex((other) => other.url === link.url) === index);
    group.cards.push({ task: task.id, title: task.title, note: cut(hold.text, 200), source: hold.source.label, links });
    groups.set(id, group);
  }
  for (const { hold, cards } of [...groups.values()].sort((a, b) => b.cards.length - a.cards.length)) {
    const shown = cards.slice(0, CARDS_SHOWN);
    const one = cards.length === 1;
    out.push({
      kind: "reconcile",
      task: shown[0]!.task,
      title: one ? shown[0]!.title : `${cards.length} cards: ${GROUP_WORDS[hold.code]}`,
      why: one ? cut(hold.text, WHY_CHARS) : cut(`${cards.length} cards, ${GROUP_WORDS[hold.code]}: ${hold.text}`, WHY_CHARS),
      next: hold.next,
      cards: shown,
    });
  }

  if (queue.length) {
    const ready = queue.filter((card) => card.ready);
    const shown = queue.slice(0, CARDS_SHOWN);
    out.unshift({
      kind: "merge",
      task: shown[0]!.task,
      title: `${queue.length} PR/MR${queue.length === 1 ? "" : "s"} to merge`,
      why: cut(`${ready.length} of ${queue.length} can merge now${ready.length < queue.length ? `; the rest have blockers: ${queue.find((card) => !card.ready)!.blockers![0]}` : ""}`, WHY_CHARS),
      next: !ready.length
        ? "settle the blockers of the first one: nothing can merge yet"
        : `merge ${ready.map((card) => card.links[0]!.label).join(", ")}${ready.length < queue.length ? " first, in this order; each other one waits on its own blockers" : " in this order"}`,
      cards: shown,
    });
  }
  return out;
}

/** One open PR/MR of the list and the cards that name it. */
interface Open {
  url: string;
  cards: { entry: Entry; facts: CardFacts; pr: PrFact }[];
}

/**
 * Open, ready (not draft) PR/MRs the cards of reconciled projects name, each once, with every card that
 * names it: a PR/MR several cards share, or one whose tie is in doubt, is still the owner's to merge.
 * Dependencies first, then the ones nothing else holds back, in the board's order.
 */
function mergeQueue(dashboard: Dashboard, entries: Entry[]): NeedCardRow[] {
  const reconciler = dashboard.reconciler;
  const byCard = new Map<string, { entry: Entry; facts: CardFacts; prs: PrFact[] }>();
  for (const entry of entries) {
    const facts = reconciler.latest(entry.space, entry.task);
    const prs = (facts?.prs ?? []).filter((pr) => pr.state === "open" && named(pr));
    if (facts && prs.length) byCard.set(entry.task.id, { entry, facts, prs });
  }
  if (!byCard.size) return [];
  const plan = entries[0]!.space.sync.plan;
  const board = sortTasks([...byCard.values()].map(({ entry }) => ({ plan, task: entry.task }))).map((item) => item.task.id);
  // Each PR/MR once, in the board's order of the first card that names it; that card's own comes first.
  const open = new Map<string, Open>();
  for (const id of board) {
    const { entry, facts, prs } = byCard.get(id)!;
    for (const pr of prs) {
      const row = open.get(pr.url) ?? { url: pr.url, cards: [] };
      if (pr.own) row.cards.unshift({ entry, facts, pr });
      else row.cards.push({ entry, facts, pr });
      open.set(pr.url, row);
    }
  }
  const inQueue = new Map([...byCard].map(([id, value]) => [id, value.prs]));
  const blockersOf = (row: Open) => [
    ...new Set(
      row.cards.flatMap(({ entry, facts, pr }) =>
        mergeBlockers(entry.space.sync.plan, entry.task, facts, pr, inQueue, Boolean(reconciler.rule(entry.space, entry.task)?.no_checks_ok), (dep) => reconciler.codeMerged(entry.space, dep)),
      ),
    ),
  ];
  // The other PR/MRs of the list that this one's cards wait for.
  const waits = (row: Open) =>
    row.cards.flatMap(({ entry }) => entry.task.depends_on.flatMap((ref) => (inQueue.get(refId(ref) ?? "") ?? []).map((pr) => pr.url))).filter((url) => url !== row.url);
  const held = (row: Open) => blockersOf(row).some((b) => !b.startsWith("merge "));
  const placed: Open[] = [];
  const pending = [...open.values()];
  while (pending.length) {
    const free = pending.filter((row) => waits(row).every((url) => placed.some((done) => done.url === url)));
    const next = free.find((row) => !held(row)) ?? free[0] ?? pending[0]!;
    placed.push(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return placed.map((row, index) => {
    const [first, ...others] = row.cards;
    const blockers = blockersOf(row);
    const also = others.map(({ entry }) => entry.task.id);
    return {
      task: first!.entry.task.id,
      title: first!.entry.task.title,
      note: cut([also.length ? `also named by ${also.join(", ")}` : "", blockers.length ? blockers.join("; ") : "ready to merge"].filter(Boolean).join("; "), 200),
      source: `${first!.pr.label} open`,
      links: [{ label: first!.pr.label, url: row.url }],
      order: index + 1,
      ready: blockers.length === 0,
      blockers,
      ...(also.length ? { also } : {}),
    };
  });
}
