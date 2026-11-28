import { hasLiveRun, type Task } from "../../shared/model.ts";
import type { Dashboard } from "../dashboard.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { localHost } from "../api/view.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import type { RunRecord } from "../runner/runs.ts";
import { prKey } from "../tracker/forge.ts";
import { pendingRuns, type QaRun } from "../qa-cards.ts";
import { isApp } from "./android.ts";
import { type CardFacts, mergedSince, named, type PrFact } from "./facts.ts";
import { planHolds, qaExpected } from "./plan-gate.ts";
import { type AppFacts, afterMerge, type DeliveryStage, short, type StageHolds } from "./steps.ts";

/**
 * A hold whose agent is gone (JOBBY-515V2): the plan still says a run holds the card, but no agent of
 * this Mac works on it. The agent often finished its work, and the work was merged from a branch the
 * run never recorded (a second branch, a follow-up, a session of the owner's); the hold must not hide
 * that. What this module says comes from a reading of the forge (`CardFacts`, read-only) and the plan,
 * and every read tells the same sentence (needs, board, task, reconcile, delivery):
 *
 *  - what is merged into the target branch and is the card's own: tied by its issue's closer, its id in
 *    the branch or title, its link or a run's own report, never by a mention in a description;
 *  - what stands before the hold is released: a PR/MR still open, a draft or closed without a merge,
 *    one that names the card in its description, a merge into another branch, commits pushed after a
 *    merge, a run branch with commits no merged PR/MR holds, and anything the forge could not answer;
 *  - the one next step: a decision, QA, the stage build, the open acceptance lines, and last the
 *    release to done. Nothing here closes a card, stops or starts an agent: a merge is code, not accepted
 *    work, and starting the card again for the same work would duplicate it.
 *
 * What a step may say holds throughout: the release to done is named only when nothing stands before
 * it, only as the last action, and QA's result counts only for the code it could have tested: recorded
 * after every merge of the card, on a build known to hold them. Every check (target branch, commits
 * pushed after a merge, the stage build, app builds, QA) covers the same merges: the card's own and the
 * follow-ups that mention it (`ofCard`). A reading counts only for the stop it was made for.
 */

export interface StoppedReading {
  trunk: string;
  /** The card's own merged work in the target branch, newest first. */
  landed: PrFact[];
  /** The PR/MRs it names that are still open or drafts. */
  open: PrFact[];
  /** Merged PR/MRs that only mention the card (a follow-up): shown, never proof. */
  related: PrFact[];
  /** Whether the stage build recorded on the card holds all of these merges; undefined when not compared. */
  holds?: StageHolds;
  /** What stands before the hold is released, strongest first; empty when nothing does. */
  pending: { text: string; next: string }[];
  /** Every merge predates this run and none was reported by it: earlier work, not this run's result. */
  earlier: boolean;
  /** One line: the agent is gone, what is merged, what stands, what is left. */
  why: string;
  stage: DeliveryStage;
  next_by: string;
  next: string;
  /** The PR/MR a read of the work should show: a pending open one, else the latest landed. */
  url: string;
  sources: { label: string; url: string }[];
  /** The facts' time, ISO. */
  at: string;
  /** The recorded QA cards read open, when their run is all that waits: nothing stands before QA. */
  qa?: QaRun[];
}

/** The clock difference allowed between the forge and the claiming machine when a merge is compared with a run's start. */
const MARGIN_MS = 10 * 60_000;
const finish = "release it to done (release_task)";
const again = "do not release it to todo or start it again for the merged code";
/** The same warning while nothing of the card is merged yet: a second start would redo what the open work holds. */
const notTwice = "do not start the same work again before that";

const label = (pr: Pick<PrFact, "label" | "mergeSha">) => `${pr.label}${pr.mergeSha ? ` (${short(pr.mergeSha)})` : ""}`;
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Whether a card's agent is gone on this Mac while its run still holds the task in progress or in
 * review: the run is stopped, or this Mac started it and has no record of its agent (a claim still on its
 * way is a start, not a lost agent). A run of another machine is not known from here, so it is no
 * stopped hold: its agent may be at work. A tracked checkout on the trunk has no PR/MR to look for.
 */
export function agentGone(task: Task, run: RunRecord | undefined, host: string, claiming: boolean): boolean {
  if (!hasLiveRun(task) || (task.status !== "in_progress" && task.status !== "review")) return false;
  if (run) return run.activity === "stopped" && !run.adopted?.trunk;
  return task.run_host === host && !claiming;
}

export interface JudgeInput {
  plan: Plan;
  task: Task;
  loaded: Pick<LoadedEntity, "acceptance" | "brief" | "clarifications">;
  facts: CardFacts;
  /** This Mac's record of the run, for what the agent reported. */
  run: RunRecord | undefined;
  app?: AppFacts;
}

/**
 * Whether a merged PR/MR is the card's work as this reading counts it: its own (ties.ts), or the exact
 * id in its title with nothing giving it to another card. A closing asks for more than a title: no
 * person looks at it. Here a person does, and the alternative is to offer the same work again.
 */
export const cardsOwn = (pr: Pick<PrFact, "own" | "ways" | "doubts">): boolean => pr.own || (pr.ways.includes("id_in_title") && !pr.doubts.length);

/** A PR/MR that only mentions the card, with nothing giving it to another card: a possible follow-up. */
export const followUp = (pr: Pick<PrFact, "own" | "ways" | "doubts" | "theirs">): boolean => !cardsOwn(pr) && !pr.theirs && !pr.doubts.length && pr.ways.includes("id_in_description");

/**
 * The card's work as every check of a gone hold covers it: what it names, what is its own and its
 * follow-ups. A PR/MR whose source is the target branch only carries it onwards (a release, a promotion).
 */
export const ofCard = (pr: PrFact, trunk: string): boolean => pr.head !== trunk && (named(pr) || cardsOwn(pr) || followUp(pr));

/** What an open PR/MR still needs before it can merge, as the forge said. */
function unready(pr: PrFact): string[] {
  const checks = pr.checks?.state;
  return [
    checks === "failing" ? `checks fail: ${pr.checks!.failing.join(", ") || "failed"}` : checks === "pending" || checks === "waiting" ? "checks are not finished" : "",
    pr.review === "changes requested" ? "a review requests changes" : "",
    pr.merge.state === "no" ? pr.merge.why || "the forge would not merge it" : "",
  ].filter(Boolean);
}

/** The step of a card whose work is merged with nothing standing before it: QA and acceptance, then the release. */
function mergedStep(input: JudgeInput, landed: PrFact[], related: PrFact[], lineOpen: number): Pick<StoppedReading, "stage" | "next_by" | "next"> {
  const { task, facts, app } = input;
  const d = task.delivery;
  const names = landed.map(label).join(", ");
  if (!qaExpected(task)) {
    const [be, them] = landed.length > 1 ? ["are", "them"] : ["is", "it"];
    const next = lineOpen ? `${names} ${be} merged: do and tick the ${lineOpen} open acceptance line(s) (a check by a person or on a device), then ${finish}` : `${names} ${be} merged: check ${them}, then ${finish}`;
    return { stage: lineOpen ? "ready_for_qa" : "ready_to_accept", next_by: "owner", next: `${next}; ${again}` };
  }
  const stage = facts.gone?.stage?.sha === d?.stage_sha ? facts.gone?.stage : undefined;
  const holds: StageHolds = stage?.holds ?? "unknown";
  // A result recorded before a merge, or on a build without it, never tested that code.
  const newest = Math.max(...[...landed, ...related].map((pr) => Date.parse(pr.mergedAt)));
  const result = d?.qa === "passed" || d?.qa === "failed" ? d.qa : undefined;
  const uncovered = Boolean(result) && (app ? app.apks.some((apk) => apk.state !== "available") : Boolean(d?.stage_sha) && holds !== "yes");
  const outdated = Boolean(result) && (!(Date.parse(d?.qa_at ?? "") >= newest) || uncovered);
  const ladder = afterMerge({
    task: outdated ? { ...task, delivery: { ...d!, qa: undefined } } : task,
    open: lineOpen,
    merge: stage?.missing ?? { label: landed[0]!.label, sha: landed[0]!.mergeSha },
    holds,
    ...(app ? { app } : {}),
    finish,
    failed: "the fix is new work: release it to todo and start it for the fix only",
  });
  // A failure of the merged code is the one case where the card is to be started again.
  if (ladder.stage === "qa_failed") return ladder;
  // A pass with every QA card settled says its own last action.
  const settled = ladder.stage === "qa_passed" && !pendingRuns(task.qa_cards).length;
  const record = ladder.stage === "qa_passed" ? "" : "record QA's result (update_task delivery qa) and ";
  const tail = settled ? "" : lineOpen ? `; then tick the ${lineOpen} open acceptance line(s) with what was seen and ${finish}` : `; then ${record}${finish}`;
  const retest = outdated ? `QA's recorded "${result}" does not cover the merged code (${names}), so it is tested again: ` : "";
  return { ...ladder, next: `${retest}${ladder.next}${tail}; ${again}` };
}

/** The reading of a card whose agent is gone, from the forge facts and the plan; pure. */
export function judgeStopped(input: JudgeInput): StoppedReading {
  const { plan, task, loaded, facts, run } = input;
  const trunk = facts.trunk;
  const created = task.created;
  const lineOpen = loaded.acceptance.filter((line) => !line.done).length;
  const all = facts.prs.filter((pr) => pr.state === "merged" && mergedSince(pr, created));
  // A revert that names the card undoes work rather than adds it: a person looks before anything is
  // called merged, until a later merge of the card's own into the target branch brought the work back. A
  // revert of a revert brings it back; the run's or its branch's own revert with nothing of the card
  // before it is the card's work.
  const undo = (pr: PrFact) => ofCard(pr, trunk) && /^\s*revert\b(?!\W*revert\b)/i.test(pr.title);
  const work = all.filter((pr) => ofCard(pr, trunk) && !undo(pr));
  const ownWork = (pr: PrFact) => pr.ways.some((way) => way === "run" || way === "branch") && !work.some((other) => other.mergedAt <= pr.mergedAt);
  const undone = all.filter((pr) => undo(pr) && !ownWork(pr));
  const reverts = undone.filter((pr) => !work.some((other) => cardsOwn(other) && other.base === trunk && other.mergedAt > pr.mergedAt));
  const merged = all.filter((pr) => !undone.includes(pr));
  const newestFirst = (a: PrFact, b: PrFact) => b.mergedAt.localeCompare(a.mergedAt);
  const landed = merged.filter((pr) => cardsOwn(pr) && Boolean(trunk) && pr.base === trunk).sort(newestFirst);
  const related = merged.filter((pr) => followUp(pr) && Boolean(trunk) && pr.base === trunk && pr.head !== trunk).sort(newestFirst);

  const pending: StoppedReading["pending"] = [];
  const open = facts.prs.filter((pr) => (pr.state === "open" || pr.state === "draft") && named(pr));
  const extra = facts.gone;
  for (const pr of open) {
    const blockers = unready(pr);
    const otherwise = "or close it if it is not this card's work";
    pending.push({
      text: `${pr.label} is still ${pr.state === "draft" ? "a draft" : "open"}`,
      next:
        pr.state === "draft"
          ? `${pr.label} is a draft: finish it and mark it ready (its passing checks pass no QA), ${otherwise}`
          : blockers.length
            ? `${pr.label} is not ready to merge (${cut(blockers.join("; "), 160)}): settle that and merge it, ${otherwise}`
            : `review and merge ${pr.label}, ${otherwise}`,
    });
  }
  // Closed without a merge, and tied as the run's, a link's or a branch's: part of the work may be
  // missing. Not one a later merge of the same branch replaced, unless the card links it (commits pushed
  // since are said apart); nor another card's, nor one older than the card that only its branch ties.
  const number = (pr: PrFact) => Number(pr.label.slice(1));
  for (const pr of facts.prs.filter((pr) => pr.state === "closed" && !pr.theirs && pr.ways.some((way) => way === "run" || way === "link" || way === "branch"))) {
    const linked = pr.ways.includes("link");
    if (!linked && !pr.ways.includes("run") && !(Date.parse(pr.createdAt) > Date.parse(created ?? ""))) continue;
    if (!linked && landed.some((other) => other.head === pr.head && number(other) > number(pr))) continue;
    pending.push({
      text: `${pr.label} was closed without a merge`,
      next: `check whether the work of ${pr.label} is still needed: ${linked ? "reopen it, or take its link off the card if it was replaced" : "reopen it or open a PR/MR for what is left"}`,
    });
  }
  for (const mention of facts.mentions ?? []) {
    pending.push({
      text: `${mention.label} is ${mention.draft ? "a draft" : "open"} and names the card in its description`,
      next: `check whether ${mention.label} is newer work of this card: merge or close it`,
    });
  }
  for (const pr of merged.filter((pr) => ofCard(pr, trunk) && Boolean(trunk) && pr.base !== trunk)) {
    pending.push({ text: `${pr.label} was merged into ${pr.base || "an unknown branch"}, not ${trunk}`, next: `merge the work on into ${trunk}, or check it is not part of this card` });
  }
  if (merged.some((pr) => named(pr)) && !trunk) pending.push({ text: "the project names no target branch, so where the work landed cannot be judged", next: "set the project's trunk in Paseo Dash" });
  for (const pr of reverts) {
    pending.push({ text: `${pr.label} is a revert that names the card`, next: `check whether the work ${pr.label} reverted is still in ${trunk || "the target branch"}` });
  }
  for (const push of extra?.pushed ?? []) {
    pending.push({ text: `${push.branch} has commits pushed after ${push.label} merged (${short(push.tip)})`, next: `open a PR/MR for them, or check they are not this card's work` });
  }
  if (extra?.ahead) {
    pending.push({
      text: `${extra.ahead.branch} holds commits (${short(extra.ahead.tip)}) that are not known to be in ${trunk || "the target branch"}`,
      next: `check ${extra.ahead.branch}: open a PR/MR for what it holds, or confirm it is not needed`,
    });
  }
  const unread = facts.unknown[0] ?? extra?.unknown[0];
  if (unread) {
    pending.push({ text: cut(`not all of its forge facts could be read: ${unread}`, 160), next: "check this Mac's gh or glab login and the project's checkout; the card is read again by itself" });
  }
  const [limit] = facts.limits;
  if (limit) pending.push({ text: cut(`part of its work is not read: ${limit.why}`, 160), next: limit.advice });

  // A merge from before this run, that the run did not report: earlier work, which the run may not have finished.
  const started = Date.parse(task.run_started ?? "");
  const reported = [task.run_pr, run?.reportedPr].filter((url): url is string => Boolean(url)).map(prKey);
  const earlier =
    landed.length > 0 &&
    Number.isFinite(started) &&
    landed.every((pr) => !pr.ways.includes("run") && !reported.includes(prKey(pr.url)) && Date.parse(pr.mergedAt) < started - MARGIN_MS);

  const names = landed.map(label).join(", ");
  const held = planHolds(plan, task, loaded, { asRun: true }).find((hold) => hold.code === "decision" || hold.code === "manual");
  const d = task.delivery;
  const left = lineOpen ? `${lineOpen} of ${loaded.acceptance.length} acceptance lines open` : "";
  let step: { stage: DeliveryStage; next_by: string; next: string };
  if (pending.length) {
    const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : "";
    step = { stage: landed.length || open.length ? "waiting_for_merge" : "in_work", next_by: "owner", next: `${pending[0]!.next}${more}; ${landed.length ? again : notTwice}` };
  } else if (earlier) {
    step = {
      stage: "in_work",
      next_by: "owner",
      next: `${names} merged before this run started and the run did not report it: check what the run left (its branch and handoff); ${finish} only once nothing is left, QA and acceptance included, else start it for the rest only`,
    };
  } else if (!landed.length) {
    step = { stage: "in_work", next_by: "owner", next: `no merge of its own into ${trunk || "the target branch"} is confirmed: check its branch and PR/MR, then ${finish} if it is finished, or release it to todo to start it again` };
  } else {
    step = mergedStep(input, landed, related, lineOpen);
    if (held) step = { ...step, next: `settle first: ${cut(held.text, 120)}; then ${step.next}` };
  }

  const first = open[0];
  const url = first?.url ?? landed[0]?.url ?? "";
  const gone = "its agent is gone";
  const why = [
    gone,
    landed.length ? `${names} merged into ${trunk}${earlier ? " before this run started" : ""}` : "no merge of its own into the target branch is confirmed",
    pending.length ? pending[0]!.text : "",
    left,
  ]
    .filter(Boolean)
    .join("; ");
  const sources = [...open, ...landed, ...related].map((pr) => ({ label: `${pr.label} ${pr.state}`, url: pr.url }));
  const holds = extra?.stage?.sha === d?.stage_sha ? extra?.stage?.holds : undefined;
  // QA is the wait only once the step itself is QA's: an open PR/MR, a stage build, a setup or a decision comes first.
  const qa = !held && step.stage === "ready_for_qa" && step.next_by === "QA" ? pendingRuns(task.qa_cards).filter((card) => card.status === "open") : [];
  return { trunk, landed, open, related, ...(holds ? { holds } : {}), pending, earlier, why, ...step, url, sources, at: facts.at, ...(qa.length ? { qa } : {}) };
}

/** The space whose plan holds the task. */
function spaceOf(dashboard: Dashboard, task: Task): SpaceEntry | undefined {
  for (const entry of dashboard.spaces.values()) if (entry.sync.plan.entities.get(task.id)?.entity.type === "task") return entry;
  return undefined;
}

/**
 * What this Mac's last reading of the forge says of a card whose agent is gone; undefined when its agent
 * is not gone here, or nothing was read for this run yet (the reads then say what they said before).
 */
export function stoppedReading(dashboard: Dashboard, task: Task, host: string = localHost()): StoppedReading | undefined {
  const space = spaceOf(dashboard, task);
  if (!space || !dashboard.reconciler.stoppedHold(space, task, host)) return undefined;
  const facts = dashboard.reconciler.stoppedFacts(space, task, host);
  const loaded = space.sync.plan.entities.get(task.id);
  if (!facts || !loaded) return undefined;
  const run = dashboard.runs?.runs.get(task.run_id ?? "");
  // An app card's QA waits for a build of each variant (android.ts), not for a stage.
  const app: AppFacts | undefined = isApp(task)
    ? {
        prs: facts.prs.filter((pr) => ofCard(pr, facts.trunk) && pr.state !== "closed").map((pr) => ({ label: pr.label, url: pr.url, state: pr.state, mergedAt: pr.mergedAt, sha: pr.mergeSha, blockers: [] })),
        apks: facts.gone?.apks ?? [],
        trunk: facts.trunk,
        unread: "",
      }
    : undefined;
  return judgeStopped({ plan: space.sync.plan, task, loaded, facts, run, ...(app ? { app } : {}) });
}
