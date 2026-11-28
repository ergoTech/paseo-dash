import { CHATS_LISTED, type ChatState, chatSaid, openSubAgents, type RunChat } from "../shared/chats.ts";
import { hasLiveRun, type Task } from "../shared/model.ts";
import type { NeedsKind, Overview, WaitState } from "../shared/overview.ts";
import type { Dashboard } from "./dashboard.ts";
import type { RunRecord } from "./runner/runs.ts";
import { cut, localHost, localRun } from "./api/view.ts";
import { landedText } from "./tracker/landed.ts";
import { stoppedReading } from "./reconcile/stopped.ts";

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
  /** The chat the user answers in when it is not the run's own agent's: a sub-agent's. */
  chatId?: string;
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
  // Stopped, its chat not read yet: said apart from an agent that is gone.
  stoppedUnread: "check its chat in Paseo and continue it if it is there; otherwise release it: to done if it is finished, to todo to start it again",
  // A closed chat keeps its context: continuing it comes before releasing the task (JOBBY-HCXY5).
  stoppedClosed: "continue its chat (open it in Paseo, or send_message to it with God Mode); otherwise release it: to done if it is finished, to todo to start it again",
  // The run's chat is closed and a sub-agent of it is open: that one is looked at before anything new starts.
  subClosed: "check the sub-agent's chat, then continue the run's closed chat (open it in Paseo, or send_message); otherwise release it: to done if finished, to todo to start again",
  sub: "check the sub-agent's chat (open it in Paseo, or send_message to it) before anything new starts; then release the task: to done if finished, to todo to start again",
  sync: "fix the plan repository's access on this Mac (Paseo Dash settings show the error); the changes then push by themselves",
} as const;

export const SYNC_NEXT = NEXT.sync;

export type { WaitState } from "../shared/overview.ts";

/** How long a wait the agent reported (task_report waiting_for) counts with no fact behind it. */
const REPORTED_WAIT_MS = 30 * 60_000;

/** Sub-agents of the run at work: Paseo's child agents and sub-agent calls on its timeline. */
export function subAgentsAtWork(dashboard: Dashboard, run: RunRecord): number {
  return (dashboard.waits.facts.get(run.run_id)?.working ?? 0) + dashboard.follower.runningSubAgents(run.run_id);
}

/**
 * What an idle agent of a task in progress waits on besides the user, from facts: its sub-agents at
 * work, its PR/MR's checks running, or a wait it reported that no fact contradicts (CI not finished)
 * and that is recent. Undefined when nothing shows one: then it waits for the user.
 */
function idleWait(dashboard: Dashboard, run: RunRecord, now: number): { state: WaitState; note: string } | undefined {
  const subs = subAgentsAtWork(dashboard, run);
  if (subs) return { state: "subagent_working", note: `${subs === 1 ? "a sub-agent" : `${subs} sub-agents`} of it at work` };
  const checks = dashboard.waits.facts.get(run.run_id)?.checks;
  if (checks === "pending" || checks === "waiting") return { state: "waiting_for_ci", note: `its PR/MR's checks are ${checks}` };
  const said = run.waitingOn;
  if (!said || said.kind === "user" || !(now - Date.parse(said.at) < REPORTED_WAIT_MS)) return undefined;
  const note = said.note ? `: ${said.note}` : "";
  if (said.kind === "ci" && checks !== "passing" && checks !== "failing") return { state: "waiting_for_ci", note: flat(`it said it waits for CI${note}`) };
  if (said.kind === "review") return { state: "waiting_for_review", note: flat(`it said it waits for a review${note}`) };
  if (said.kind === "subagent") return { state: "subagent_working", note: flat(`it said its sub-agents work${note}`) };
  return undefined;
}

/** A task's state as the waits name it, with a short fact: what overview.running and the task screen show. */
export function waitState(dashboard: Dashboard, task: Task, host = localHost(), now = Date.now()): { state: WaitState; note: string } {
  const run = localRun(dashboard.runs, task);
  const need = needOf(dashboard, task, host, now);
  if (need?.kind === "question") return { state: "needs_user_question", note: need.why };
  if (need?.kind === "permission") return { state: "approval", note: need.why };
  if (need?.kind === "failed") return { state: "failed", note: need.why };
  if (need?.kind === "checkout") return { state: "checkout", note: need.why };
  // Merged work of a card whose agent is stopped: it is still stopped, and the note says what is merged.
  // With a sub-agent of it still open, the state below says that instead.
  if (need?.kind === "merged" && (run ? run.activity === "stopped" && !openSubAgents(dashboard.chats.of(run)).length : task.run_host === host)) return { state: run ? "stopped" : "record_lost", note: need.why };
  if (need?.kind === "stopped") return { state: run ? "stopped" : "record_lost", note: need.why };
  if (need?.kind === "subagent") return { state: "subagent_open", note: need.why };
  if (need?.kind === "answer") return { state: run?.waitingOn?.kind !== "user" && /^blocked: /.test(task.progress_note ?? "") ? "blocked" : "answer", note: need.why };
  if (!run) return task.run_host !== host ? { state: "elsewhere", note: `on ${task.run_host ?? "another machine"}` } : { state: claiming(dashboard, task) ? "launching" : "record_lost", note: "" };
  if (run.activity === "launching") return { state: "launching", note: "" };
  if (run.activity === "waiting" && task.status === "in_progress") return idleWait(dashboard, run, now) ?? { state: "answer", note: "" };
  if (run.activity === "waiting" && task.status === "review") return { state: "waiting_for_review", note: "its work is in review" };
  // In review too: the run's agent is stopped, and a sub-agent of it may still be at the work.
  if (run.activity === "stopped") {
    const chat = dashboard.chats.of(run);
    return chat && openSubAgents(chat).length ? { state: "subagent_open", note: flat(subAgentWhy(chat)) } : { state: "stopped", note: "" };
  }
  return { state: "working", note: "" };
}

/** What a stopped run left: its PR/MR, its handoff and the acceptance still open, in one line. */
function leftBehind(dashboard: Dashboard, task: Task): string {
  const seen = dashboard.prs.seen.get(task.id);
  const pr = seen && seen.run_id === task.run_id ? `${seen.label} ${seen.state}` : task.run_pr ? task.run_pr.replace(/^https:\/\/[^/]+\//, "") : "no PR/MR";
  let loaded: { acceptance: { done: boolean }[]; handoff?: { at: string } } | undefined;
  for (const { sync } of dashboard.spaces.values()) loaded ??= sync.plan.entities.get(task.id);
  const open = loaded?.acceptance.filter((a) => !a.done).length ?? 0;
  const total = loaded?.acceptance.length ?? 0;
  const handoff = loaded?.handoff ? `handoff ${loaded.handoff.at.slice(0, 16).replace("T", " ")}` : "no handoff";
  return `${pr}; ${handoff}; ${total ? `${open} of ${total} acceptance lines open` : "no acceptance"}`;
}

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

/** A stopped run's agent in the words of `why`, from what was read of its chat. */
const CHAT_WHY: Record<ChatState | "unread", string> = {
  closed: "its chat is closed, not archived: it can be continued",
  archived: "its chat is archived",
  gone: "its agent is gone while the task is still open",
  unread: "its agent is stopped; its chat is not read yet",
};

const SUB_STATE_WORDS = { needs_input: "asks", working: "at work", idle: "idle", failed: "failed", closed: "closed" } as const;

/** A stopped run's closed sub-agents, named so their work is not done twice: "; sub-agent a1b2c3d4 closed too". */
function closedSubAgents(chat: RunChat | undefined): string {
  const [first, ...rest] = (chat?.sub_agents ?? []).filter((sub) => sub.state === "closed");
  if (!first) return "";
  // The list is cut at CHATS_LISTED: a full one may stand for more.
  const more = rest.length + 1 >= CHATS_LISTED ? " or more" : "";
  return rest.length ? `; ${rest.length + 1}${more} closed sub-agents` : `; sub-agent ${first.id.slice(0, 8)} closed too`;
}

/** The first open sub-agent of a stopped run (the others counted), then what became of the run's own chat. */
function subAgentWhy(chat: RunChat): string {
  const [first, ...rest] = openSubAgents(chat);
  const where = first!.directory.split("/").filter(Boolean).pop();
  const more = rest.length ? ` and ${rest.length} more` : "";
  const own = chat.state === "gone" ? "the run's agent is gone" : `the run's chat is ${chat.state}`;
  return `its sub-agent ${first!.id.slice(0, 8)} is ${SUB_STATE_WORDS[first!.state]}${where ? ` in ${where}` : ""}${more}; ${own}`;
}

/**
 * The other way for work in review than accepting it (accept_task, send_back; JOBBY-5YRRY): sending
 * it back reaches only this Mac's agent while it is there and waits (server/result.ts sendBack);
 * another machine's run is sent back there, and with no agent at work (this Mac's run without a
 * record here included) it starts again.
 */
function sendBackStep(task: Task, run: RunRecord | undefined, what: string, host: string, chat: ChatState | undefined): string {
  if (!run && task.run_host !== host) return `send it back ${what} from ${task.run_host ?? "the machine that runs it"}`;
  if (chat === "closed") return `continue its closed chat ${what} (open it in Paseo, or send_message to it), or release it to todo to start it again`;
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
 * The agent asking (a permission, or questions to the user) or failing; then, for a task in progress whose
 * agent is stopped, a sub-agent of it still open; then, with the agent stopped, work of
 * the task merged into the target branch; then the run's own PR/MR merged without the task done, which says more
 * than an agent waiting or gone after it; then, for a task in progress, its agent waiting after a
 * turn; then the PR/MR closed while nobody works on it; then no agent at work while the task is in
 * progress (closed, archived or gone, none known here, or a tracked trunk checkout's normal end, which only a person moves on); then a review with no PR/MR. In review an agent may well have closed once its PR/MR was open:
 * that task waits for the merge.
 */
export function needOf(dashboard: Dashboard, task: Task, host = localHost(), now = Date.now()): Need | undefined {
  if (!hasLiveRun(task)) return undefined;
  const run = localRun(dashboard.runs, task);
  const seen = dashboard.prs.seen.get(task.id);
  const own = seen && seen.run_id === task.run_id ? seen : undefined;
  const open = task.status === "in_progress";
  const busy = run?.activity === "working" || run?.activity === "launching";
  const need = (kind: NeedsKind, why: string, next: string, since = ""): Need => ({ kind, why, next, since });
  // What became of a stopped run's chat and its sub-agents (server/chats.ts); undefined until read.
  const chat = dashboard.chats.of(run);
  if (run?.activity === "needs_input") {
    const kind = run.waitingKind === "question" ? "question" : "permission";
    return need(kind, flat(run.waitingFor ?? "waits for your answer"), NEXT[kind], run.activityAt);
  }
  // A sub-agent's question or permission is the user's as much as the agent's own: a child at work never hides it.
  const child = !run ? undefined : run.activity === "stopped" ? dashboard.chats.asking(run) : dashboard.waits.facts.get(run.run_id)?.asking;
  if (child) {
    const kind = child.kind === "question" ? "question" : "permission";
    return { ...need(kind, flat(`a sub-agent asks: ${child.text}`), kind === "question" ? NEXT.question.replace("the agent's chat", "the sub-agent's chat") : "answer it in the sub-agent's chat", run!.activityAt), chatId: child.agentId };
  }
  if (run?.activity === "failed") return need("failed", flat(run.error ?? "the agent failed"), NEXT.failed, run.activityAt);
  // An agent stopped while its run holds the task: work merged from any branch says more than that, and
  // what is left of it is the step, never a second start of the same work (server/reconcile/stopped.ts).
  const gone = stoppedReading(dashboard, task, host);
  // A sub-agent still open is its own state: work may go on, and a new start could repeat it.
  if (open && run?.activity === "stopped" && chat && openSubAgents(chat).length) {
    const merged = gone?.landed.length ? `; ${gone.landed.map((pr) => pr.label).join(", ")} merged` : "";
    const next = gone?.next ?? (chat.state === "closed" ? NEXT.subClosed : NEXT.sub);
    return { ...need("subagent", flat(`${subAgentWhy(chat)}${merged}`), next, run.activityAt), chatId: openSubAgents(chat)[0]!.id };
  }
  if (gone?.landed.length) return need("merged", flat(gone.why), gone.next, run?.activityAt ?? "");
  // Nothing merged, but work of it standing: the agent is gone all the same, and the step is that work.
  // A review whose run's own PR/MR is known waits for its merge as before.
  if (gone?.pending.length && (open || (!own && !task.run_pr))) return need("stopped", flat(gone.why), gone.next, run?.activityAt ?? "");
  if (own?.state === "merged") {
    const left =
      task.status === "review"
        ? `accept the work if it is finished; otherwise ${sendBackStep(task, run, "with what is left", host, chat?.state)}`
        : `release it to done if the work is finished; otherwise tell the agent ${talk(task, run)} what is left`;
    return need("merged", flat(`${own.label} ${own.note ?? "merged"}`), left);
  }
  if (open && run?.activity === "waiting") {
    // Idle is not by itself a question to the user: sub-agents at work, running checks or a wait the
    // agent reported (and nothing contradicts) leave nothing to answer (server/wait.ts).
    if (idleWait(dashboard, run, now)) return undefined;
    const blocked = /^blocked: /.test(task.progress_note ?? "") ? task.progress_note! : "";
    const said = run.waitingOn?.kind === "user" ? `it asks for your answer${run.waitingOn.note ? `: ${run.waitingOn.note}` : ""}` : "";
    return need(
      "answer",
      blocked ? `the agent is ${flat(blocked)}` : said ? flat(said) : run.lastMessage ? `the agent waits: ${flat(run.lastMessage)}` : "the agent finished its turn and waits for you",
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
      const next = chat?.state === "closed" ? `continue its chat if work is left (open it in Paseo, or send_message to it); otherwise ${checkoutNext(run)}` : checkoutNext(run);
      return need("checkout", flat(`${none ? "tracked without an agent" : `${chatSaid(chat?.state)}, a tracked checkout's normal end`}; ${landedText(run)}`), next, run.activityAt);
    }
    const next = none || chat?.state === "archived" || chat?.state === "gone" ? NEXT.stopped : chat ? NEXT.stoppedClosed : NEXT.stoppedUnread;
    return need("stopped", flat(`${none ? "tracked on this Mac without an agent in its workspace" : CHAT_WHY[chat?.state ?? "unread"]}${closedSubAgents(chat)}; ${leftBehind(dashboard, task)}`), next, run.activityAt);
  }
  // Not a run that ended: this Mac lost the record of its agent (runs.json moved aside, another Paseo home).
  if (open && !run && task.run_host === host && !claiming(dashboard, task)) return need("stopped", flat(`started on this Mac, but this Mac has no record of its agent (not an ended run); ${leftBehind(dashboard, task)}`), NEXT.stopped);
  if (task.status === "review" && !own && !task.run_pr) {
    // A PR/MR the agent named is checked by the tracker; until it answers (or with no gh/glab
    // here) its state is unknown, which is said rather than "without a PR/MR".
    return need(
      "accept",
      run?.reportedPr
        ? flat(`the agent reported ${run.reportedPr}; its state is not known yet (is gh or glab logged in here?)`)
        : "the agent reported the work done without a PR/MR: accept it or send it back",
      `${run?.reportedPr ? `check ${flat(run.reportedPr)}, then ` : ""}accept the work, or ${sendBackStep(task, run, "with what to change", host, chat?.state)}`,
    );
  }
  return undefined;
}
