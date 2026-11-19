import { hasLiveRun, type Task } from "../shared/model.ts";
import type { NeedsKind, Overview } from "../shared/overview.ts";
import type { Dashboard } from "./dashboard.ts";
import type { RunRecord } from "./runner/runs.ts";
import { cut, localHost, localRun } from "./api/view.ts";
import { landedText } from "./tracker/landed.ts";

/**
 * One task's state as every read tells it (06-god-mode.md, One state in every read): what its run's
 * agent does (`overview.running[].activity`) and what waits for the user (`overview.needs_you`, and
 * `needs` and `next` of `tasks` and `task`). Each read calls these, so they cannot disagree. Three
 * facts stay apart: the task's status (the plan's), the run that holds it (the plan's claim, which
 * the autopilot's limit counts), and the agent this Mac knows for that run.
 */

export type RunActivity = Overview["running"][number]["activity"];

export interface Need {
  kind: NeedsKind;
  /** The fact, one line of at most WHY_CHARS: the agent's request or error, the PR/MR, the landed reading. */
  why: string;
  /** What the user can do about it now. */
  next: string;
  /** Since when it waits, ISO time, where known; else "". */
  since: string;
}

/** A reason as one short line: an agent's message or a provider's error can be long and multi-line. */
export const WHY_CHARS = 160;
export const flat = (text: string) => cut(text.replace(/\s+/g, " ").trim(), WHY_CHARS);

/** An agent's question, wherever a read meets one (JOBBY-RTWBY): its own words travel with the answer, not with a description. */
export const QUESTION_NEXT =
  "the user answers in the agent's chat in Paseo; with God Mode 0.15+ read_approval, then answer_questions with only the user's own choices; never answer_approval";

const NEXT = {
  permission: "answer it in the agent's chat",
  // Self-contained: tasks and task carry it without the overview's description (JOBBY-RTWBY).
  question: QUESTION_NEXT,
  failed: "read the error in the agent's chat; tell it to go on there, or release the task (to todo to start it again)",
  stopped: "check its branch and PR/MR for the work, then release it: to done if it is finished, to todo to start it again",
  sync: "fix the plan repository's access on this Mac (Paseo Dash settings show the error); the changes then push by themselves",
} as const;

export const SYNC_NEXT = NEXT.sync;

/** Where to talk to the run's agent: its chat when it is this Mac's, else the machine it runs on. */
function talk(task: Task, run: RunRecord | undefined): string {
  if (run) return run.agentId ? "in its chat" : "in its workspace";
  return `on ${task.run_host ?? "the machine that runs it"}`;
}

/**
 * This Mac's claim of the task's run is still on its way to the plan repository: the plan in memory
 * holds it while it is pushed, and the start writes its run record only once the claim is won
 * (server/api/writes.ts startTask). Such a run is starting, not one whose record is lost.
 */
export function claiming(dashboard: Dashboard, task: Task): boolean {
  if (!task.run_id) return false;
  for (const { sync } of dashboard.spaces.values()) {
    if (sync.journalEntries.some(({ op }) => op.kind === "claim" && op.run.run_id === task.run_id)) return true;
  }
  return false;
}

/**
 * The other way for work in review than accepting it (accept_task, send_back; JOBBY-5YRRY): sending
 * it back reaches only this Mac's agent while it is there and waits (server/result.ts sendBack);
 * another machine's run is sent back there, and with no agent at work (this Mac's run without a
 * record here included) it starts again.
 */
function sendBackStep(task: Task, run: RunRecord | undefined, what: string, host: string): string {
  if (!run && task.run_host !== host) return `send it back ${what} from ${task.run_host ?? "the machine that runs it"}`;
  if (!run?.agentId || run.activity === "stopped") return "release it to todo to start it again";
  if (run.activity === "working" || run.activity === "launching") return `send it back ${what} once its agent waits`;
  return `send it back ${what}`;
}

/**
 * A tracked checkout on the trunk: no PR/MR moves its task, so the step follows from whether its work
 * landed. While its workspace is open the screen offers no "Mark done" (05-architecture.md), so that is said.
 */
function checkoutNext(run: RunRecord): string {
  const trunk = run.adopted?.trunk ?? "";
  const landed = run.adopted?.landed;
  const again = "or release it to todo to start it again";
  const open = landed && !landed.archived ? "; its workspace is still open in Paseo" : "";
  if (landed && !landed.error && landed.landed) return `its work is on origin/${trunk}: release it to done if it is finished, ${again}${open}`;
  if (landed && !landed.error) return `commit and push its work to origin/${trunk}, then release it to done; ${again}${open}`;
  return `check that its work reached origin/${trunk}, then release it to done; ${again}${open}`;
}

/**
 * What the run's agent is doing, as `overview.running` says it. A run this Mac holds without a record
 * of its agent (runs.json lost or moved aside, or a start from another Paseo home) has no agent here:
 * `stopped`, as `task.activity` says "without an agent known here"; while its claim is still being
 * pushed it is `launching`. Another machine's run is `working`.
 */
export function runActivity(dashboard: Dashboard, task: Task, host = localHost()): RunActivity {
  const run = localRun(dashboard.runs, task);
  if (!run) return task.run_host !== host ? "working" : claiming(dashboard, task) ? "launching" : "stopped";
  return run.activity === "needs_input" || run.activity === "waiting" ? "waiting" : run.activity;
}

/**
 * What waits for the user on a task's live run, if anything: one fact per task, the strongest first.
 * The agent asking (a permission, or questions to the user) or failing; then the run's own PR/MR merged without the task done, which says more
 * than an agent waiting or gone after it; then, for a task in progress, its agent waiting after a
 * turn; then the PR/MR closed while nobody works on it; then no agent at work while the task is in
 * progress (gone, none known here, or a tracked trunk checkout's normal end, which only a person moves
 * on); then a review with no PR/MR. In review an agent may well have closed once its PR/MR was open:
 * that task waits for the merge.
 */
export function needOf(dashboard: Dashboard, task: Task, host = localHost()): Need | undefined {
  if (!hasLiveRun(task)) return undefined;
  const run = localRun(dashboard.runs, task);
  const seen = dashboard.prs.seen.get(task.id);
  const own = seen && seen.run_id === task.run_id ? seen : undefined;
  const open = task.status === "in_progress";
  const busy = run?.activity === "working" || run?.activity === "launching";
  const need = (kind: NeedsKind, why: string, next: string, since = ""): Need => ({ kind, why, next, since });
  if (run?.activity === "needs_input") {
    const kind = run.waitingKind === "question" ? "question" : "permission";
    return need(kind, flat(run.waitingFor ?? "waits for your answer"), NEXT[kind], run.activityAt);
  }
  if (run?.activity === "failed") return need("failed", flat(run.error ?? "the agent failed"), NEXT.failed, run.activityAt);
  if (own?.state === "merged") {
    const left =
      task.status === "review"
        ? `accept the work if it is finished; otherwise ${sendBackStep(task, run, "with what is left", host)}`
        : `release it to done if the work is finished; otherwise tell the agent ${talk(task, run)} what is left`;
    return need("merged", flat(`${own.label} ${own.note ?? "merged"}`), left);
  }
  if (open && run?.activity === "waiting") {
    return need(
      "answer",
      run.lastMessage ? `the agent waits: ${flat(run.lastMessage)}` : "the agent finished its turn and waits for you",
      "reply in the agent's chat; if the work is finished, release the task to done",
      run.activityAt,
    );
  }
  if (own?.state === "closed" && !busy) {
    return need("closed", flat(`${own.label} ${own.note ?? "closed without a merge"}`), `reopen it or tell the agent ${talk(task, run)}; or release the task (to todo to start it again, or to canceled)`);
  }
  if (open && run?.activity === "stopped") {
    // A tracked workspace may never have had an agent the dashboard knows.
    const none = Boolean(run.adopted) && !run.agentId;
    if (run.adopted?.trunk) {
      return need("checkout", flat(`${none ? "tracked without an agent" : "its agent is gone, a tracked checkout's normal end"}; ${landedText(run)}`), checkoutNext(run), run.activityAt);
    }
    return need("stopped", none ? "tracked on this Mac without an agent in its workspace" : "its agent is gone while the task is still open", NEXT.stopped, run.activityAt);
  }
  if (open && !run && task.run_host === host && !claiming(dashboard, task)) return need("stopped", "started on this Mac, but this Mac has no record of its agent", NEXT.stopped);
  if (task.status === "review" && !own && !task.run_pr) {
    // A PR/MR the agent named is checked by the tracker; until it answers (or with no gh/glab
    // here) its state is unknown, which is said rather than "without a PR/MR".
    return need(
      "accept",
      run?.reportedPr
        ? flat(`the agent reported ${run.reportedPr}; its state is not known yet (is gh or glab logged in here?)`)
        : "the agent reported the work done without a PR/MR: accept it or send it back",
      `${run?.reportedPr ? `check ${flat(run.reportedPr)}, then ` : ""}accept the work, or ${sendBackStep(task, run, "with what to change", host)}`,
    );
  }
  return undefined;
}
