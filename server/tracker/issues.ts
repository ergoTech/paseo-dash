import type { Task } from "../../shared/model.ts";
import { issueKey, parseIssueUrl } from "../../shared/issues.ts";
import type { Plan } from "../plan/load.ts";
import { projectRepo } from "../issues/link.ts";
import type { ForgeIssues, IssueState } from "./forge.ts";

/**
 * The state of the issues tasks stand for (09-forge-issues.md, option b). It is runtime state per
 * machine, like run activity, never a plan field: storing it would make every machine commit the
 * same observation. Nothing here writes to the plan or the forge; an issue closed on the forge is
 * shown and changes nothing by itself, as a merge that is not the run's own (03-model.md, Statuses).
 *
 * Read on a slow timer for tasks not done or canceled, and for done tasks while their run ended
 * recently (the after-merge check), plus on demand when a screen shows a task whose reading is old.
 * Only issues on github.com or on the web host of one of the space's own projects are read: a link
 * anyone can write into the plan must not make every collaborator's daemon call a host of their choosing.
 */

/** Whether the plan's projects make the issue's host one this machine reads from. */
export function readableIssue(plan: Pick<Plan, "space">, url: string | undefined): boolean {
  const ref = parseIssueUrl(url);
  if (!ref) return false;
  if (ref.forge === "github") return true;
  return Object.values(plan.space?.projects ?? {}).some((project) => {
    const repo = projectRepo(project);
    return repo?.forge === "gitlab" && repo.host === ref.host;
  });
}

export interface IssueView extends IssueState {
  /** When this machine read it. */
  at: string;
}

export interface IssueTrackerOptions {
  plans: () => Plan[];
  issues: ForgeIssues;
  /** A directory the CLIs run in. */
  cwd: () => string;
  now?: () => Date;
  everyMs?: number;
  log?: (message: string) => void;
}

/** A done task's issue is read after the merge for this long, then left alone. */
const AFTER_MERGE_MS = 14 * 24 * 3_600_000;
/** A screen's read starts a new reading when the last is older than this. */
const FRESH_MS = 5 * 60_000;

export class IssueTracker {
  /** By issue key (shared/issues.ts). */
  readonly seen = new Map<string, IssueView>();
  private readonly options: IssueTrackerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: IssueTrackerOptions) {
    this.options = options;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    void this.checkAll().catch(() => undefined);
    this.timer = setInterval(() => void this.checkAll().catch(() => undefined), this.options.everyMs ?? 15 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether the timer follows this task's issue: its host is the space's, and the task is open or its run ended recently. */
  follows(task: Task, plan: Pick<Plan, "space">): boolean {
    if (!readableIssue(plan, task.issue) || task.status === "canceled") return false;
    if (task.status !== "done") return true;
    const ended = Date.parse(task.run_ended ?? "");
    return Number.isFinite(ended) && this.now().getTime() - ended < AFTER_MERGE_MS;
  }

  /** Every followed issue once, one at a time. */
  async checkAll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const done = new Set<string>();
      for (const plan of this.options.plans()) {
        for (const loaded of [...plan.entities.values()]) {
          if (this.stopped) return;
          const task = loaded.entity;
          if (task.type !== "task" || !this.follows(task, plan)) continue;
          const key = issueKey(task.issue)!;
          if (done.has(key)) continue;
          done.add(key);
          await this.check(task.issue!);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  /** Reads one issue now; a read of the same issue already going on is shared. */
  check(url: string): Promise<void> {
    const ref = parseIssueUrl(url);
    if (!ref) return Promise.resolve();
    const key = issueKey(ref.url)!;
    const running = this.inFlight.get(key);
    if (running) return running;
    const read = this.options.issues
      .state(ref, this.options.cwd())
      .then((state) => {
        // A forge that did not answer leaves the last reading; with none, the state shows unknown.
        if (state && !this.stopped) this.seen.set(key, { ...state, at: this.now().toISOString() });
      })
      .catch((error: unknown) => this.options.log?.(`issue ${ref.url}: ${(error as Error).message}`))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, read);
    return read;
  }

  /**
   * The reading of a task's issue; an old or missing one starts a new reading, which this call does
   * not wait for. An issue on a host the space's projects do not name is never read.
   */
  peek(task: Pick<Task, "issue">, plan: Pick<Plan, "space">): IssueView | undefined {
    const key = issueKey(task.issue);
    if (!key || !readableIssue(plan, task.issue)) return undefined;
    const view = this.seen.get(key);
    const at = Date.parse(view?.at ?? "");
    if (!this.stopped && (!Number.isFinite(at) || this.now().getTime() - at >= FRESH_MS)) void this.check(task.issue!);
    return view;
  }
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();

/**
 * What a person should know about the issue next to the task, from the plan and this machine's
 * reading; pure. `state` is one word for reads: open, closed, closed by <PR/MR URL>, unknown.
 */
export function issueFacts(task: Pick<Task, "issue" | "status" | "run_pr">, view: IssueState | undefined, readable = true): { state: string; note: string } {
  if (!task.issue) return { state: "", note: "" };
  const ref = parseIssueUrl(task.issue);
  if (!ref) return { state: "unknown", note: "The link is not an issue URL, so its state is not read." };
  if (!readable) {
    return { state: "unknown", note: `Its state is not read: ${ref.host} is not the web host of any project of this space (set it as a project's web host on the Projects tab).` };
  }
  if (!view) return { state: "unknown", note: "" };
  const by = view.closedBy[0];
  const state = view.state === "open" ? "open" : by ? `closed by ${by}` : "closed";
  const open = task.status !== "done" && task.status !== "canceled";
  if (view.state === "closed" && open) {
    return { state, note: `The issue is closed on the forge. This changes nothing by itself: mark the task done or cancel it if that was its work.` };
  }
  if (task.status === "done" && task.run_pr) {
    if (view.state === "open") {
      return { state, note: `The task is done, but the issue is still open: the forge did not close it with ${task.run_pr} (not merged, no closing keyword, or not into the default branch). Close it on the forge if the work is complete.` };
    }
    if (view.closedBy.length && !view.closedBy.some((url) => sameUrl(url, task.run_pr!))) {
      return { state, note: `The issue was closed by another PR/MR than this task's ${task.run_pr}.` };
    }
  }
  return { state, note: "" };
}
