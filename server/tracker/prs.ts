import { hasLiveRun, type Task } from "../../shared/model.ts";
import { opaqueId } from "../plan/ids.ts";
import type { RunRecord, RunStore } from "../runner/runs.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import type { Operation } from "../sync/ops.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { type ForgeCli, type ForgePr, prUrlOfProject } from "./forge.ts";

/**
 * A live run's PR/MR and the transitions it drives (03-model.md, Statuses; 05-architecture.md,
 * 3. PR/MR state). The rules, applied as run-scoped, idempotent operations (I2, I3):
 * - a PR/MR of the run's branch first seen open and not a draft → `run_pr` is set, in_progress →
 *   review, once; a draft moves nothing until it is marked ready;
 * - the run's own `run_pr` merged → done, and the run ends, when every acceptance line is ticked,
 *   or when the run's workspace is archived on its machine (the person ended the run); with lines
 *   left and the workspace kept, nothing moves and a person is told;
 * - a PR/MR first seen already merged counts as the run's own only when it was merged later than
 *   the run started by more than a margin for clock differences; otherwise nothing moves and a
 *   person is told;
 * - `run_pr` closed without a merge → a warning; a newer open PR/MR of the branch replaces it.
 * Any machine with the CLI checks any live run of a mapped project, so a merge is recorded even
 * when the run's own machine is off; the operations make several machines agree (I2).
 */

export interface PrView {
  /** The run it was seen for: a later run of the task does not show it. */
  run_id: string;
  label: string;
  state: string;
  url: string;
  /** For a person: why nothing moved. */
  note?: string;
}

export interface PrTrackerOptions {
  spaces: () => { key: string; sync: SpaceSync; mapping: Record<string, string | null> }[];
  runs: () => RunStore | undefined;
  projectRoot: (projectId: string) => string | undefined;
  forge: ForgeCli;
  now?: () => Date;
  /** Clock difference allowed between the forge and the claiming machine (default ten minutes). */
  marginMs?: number;
  everyMs?: number;
  /** Whether this machine's run has its workspace archived; asked only for a merge with lines left. */
  archived?: (run: RunRecord) => Promise<boolean>;
  /**
   * Whether this machine's project checkouts are known yet. Before that no task can be checked, so a
   * pass does nothing and does not count as a fresh one (`peek`).
   */
  ready?: () => boolean;
  log?: (message: string) => void;
}

export class PrTracker {
  /** What the last check saw per task, for reads. */
  readonly seen = new Map<string, PrView>();
  private readonly options: PrTrackerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private stopped = false;
  /** When the last pass over every live run ended (ms); 0 before the first one with checkouts known. */
  private lastPass = 0;
  /** Tasks being checked, and those asked for again meanwhile: one check per task at a time. */
  private readonly inFlight = new Set<string>();
  private readonly again = new Set<string>();

  constructor(options: PrTrackerOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkAll().catch(() => undefined), this.options.everyMs ?? 300_000);
    this.timer.unref?.();
  }

  /**
   * A pass in the background when the last one ended `minAgeMs` ago or more, or none has run with the
   * checkouts known; reads never wait on it.
   */
  peek(minAgeMs: number): void {
    if (this.stopped || !this.timer || this.checking || Date.now() - this.lastPass < minAgeMs) return;
    void this.checkAll().catch(() => undefined);
  }

  /** Stops the timer, ends running CLI processes, and makes passes in flight write nothing more. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.forge.abort();
  }

  /** Every live run of a mapped project in every space, one at a time. */
  async checkAll(): Promise<void> {
    if (this.checking || this.options.ready?.() === false) return;
    this.checking = true;
    try {
      for (const space of this.options.spaces()) {
        for (const loaded of [...space.sync.plan.entities.values()]) {
          if (this.stopped) return;
          const task = loaded.entity;
          if (task.type !== "task" || !hasLiveRun(task)) continue;
          await this.check(space, task).catch((error: unknown) => this.options.log?.(`PR check of ${task.id}: ${(error as Error).message}`));
        }
      }
    } finally {
      this.checking = false;
      this.lastPass = Date.now();
    }
  }

  /** Checks one task; a request while it is being checked runs it once more afterwards. */
  async check(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task): Promise<void> {
    if (this.inFlight.has(task.id)) {
      this.again.add(task.id);
      return;
    }
    this.inFlight.add(task.id);
    try {
      do {
        this.again.delete(task.id);
        const current = space.sync.plan.entities.get(task.id)?.entity;
        if (current?.type !== "task" || !hasLiveRun(current)) return;
        await this.checkOnce(space, current);
      } while (this.again.has(task.id) && !this.stopped);
    } finally {
      this.inFlight.delete(task.id);
      this.again.delete(task.id);
    }
  }

  private async checkOnce(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task): Promise<void> {
    const project = task.project ? space.sync.plan.space?.projects[task.project] : undefined;
    const projectId = task.project ? space.mapping[task.project] : undefined;
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    const branch = task.run_branch;
    // The branch comes from the plan, which anyone with push access edits: it is checked before use.
    if (!project || !root || !branch || !task.run_id || !SAFE_BRANCH.test(branch)) return;
    const run = this.options.runs()?.runs.get(task.run_id);
    // A tracked checkout on the trunk has no PR/MR of its own; its "landed" is read instead.
    if (branch === project.trunk || branch === task.base || branch === run?.adopted?.trunk) return;

    const found = (await this.options.forge.byBranch(root, project.remote, branch)) ?? [];
    const add = (pr: ForgePr | undefined) => {
      if (pr && pr.head === branch && !found.some((f) => f.url === pr.url)) found.push(pr);
    };
    // The agent's own word for its PR/MR, only if it is the project's and from this branch.
    if (run?.reportedPr && prUrlOfProject(run.reportedPr, project.remote)) add(await this.options.forge.byUrl(root, project.remote, run.reportedPr));
    if (task.run_pr && !found.some((f) => f.url === task.run_pr)) add(await this.options.forge.byUrl(root, project.remote, task.run_pr));

    if (this.stopped) return;
    const unticked = space.sync.plan.entities.get(task.id)?.acceptance.filter((line) => !line.done).length ?? 0;
    // Only this machine's run with an agent or a tracked workspace can be told archived (a failed
    // start archives a stray workspace of its own); a failed read cannot tell, and nothing moves then.
    const ask = unticked > 0 && found.some((pr) => pr.state === "merged") && run?.workspaceId && (run.agentId || run.adopted);
    const archived = ask && this.options.archived ? await this.options.archived(run).catch(() => false) : false;
    if (this.stopped) return;
    // A merge finishes the run only with nothing pushed to its branch after it (read when it matters).
    const tip = found.some((pr) => pr.state === "merged") && !archived && unticked === 0 ? await this.options.forge.branchTip(root, branch).catch(() => undefined) : undefined;
    if (this.stopped) return;
    const decision = this.decide(task, found, unticked, archived, tip, Boolean(run?.adopted));
    if (decision.view) this.seen.set(task.id, decision.view);
    if (decision.op) {
      const { outcomes } = space.sync.record([decision.op]);
      await outcomes;
    }
  }

  /**
   * The transition the PR/MR facts call for, and what to show; pure, for tests. `unticked` counts
   * the task's acceptance lines not ticked yet: a merge with any of them left ends nothing, because
   * a merged PR/MR may hold only part of the work, unless the run's workspace is `archived`: then
   * nobody is left to do the rest, and the person who archived it ended the run.
   */
  decide(task: Task, found: ForgePr[], unticked = 0, archived = false, tip?: string, adopted = false): { op?: Operation; view?: PrView } {
    const at = (this.options.now ?? (() => new Date()))().toISOString();
    const transition = (to: "review" | "done", pr: ForgePr, when = at): Operation => ({
      op_id: opaqueId("op"),
      kind: "transition",
      id: task.id,
      to,
      run_id: task.run_id!,
      run_pr: pr.url,
      at: when,
      ...(to === "done" && unticked && archived ? { archived: true as const } : {}),
    });
    const view = (pr: ForgePr, note?: string): PrView => ({ run_id: task.run_id!, label: pr.label, state: pr.draft ? "draft" : pr.state, url: pr.url, ...(note ? { note } : {}) });
    const DRAFT = task.status === "review" ? "a draft" : "a draft; the task moves to review when it is marked ready";
    const UNTICKED = `merged with ${unticked} acceptance line${unticked === 1 ? "" : "s"} not ticked; archive the run's workspace or mark the task done when the work is complete`;
    // A draft is the agent's work in progress (agents open one at their first push): not review yet.
    const newestReady = found.find((pr) => pr.state === "open" && !pr.draft);
    const newestDraft = found.find((pr) => pr.state === "open" && pr.draft);
    // Work pushed to the branch after the merge is not in the trunk: the run is not done (P1 of the
    // 2026-10-28 audit). An unknown tip, a branch deleted after the merge, or an archived workspace
    // (its person ended the run) do not hold it.
    const pushedAfter = (pr: ForgePr) => !archived && Boolean(pr.headSha && tip && tip !== pr.headSha);
    const AFTER = (pr: ForgePr) => `merged, but ${task.run_branch ?? "its branch"} has commits pushed after ${pr.label}, without a new PR/MR: open one for them, or mark the task done`;
    const done = (pr: ForgePr, when: string | undefined) =>
      unticked && !archived ? { view: view(pr, UNTICKED) } : pushedAfter(pr) ? { view: view(pr, AFTER(pr)) } : { op: transition("done", pr, when), view: view(pr) };
    // A PR/MR opened before this run started is an earlier run's, continued on the same branch: the
    // new agent has not done its part yet, so the task moves to review when the agent says it is done.
    // A tracked workspace's run starts when it is tracked, usually after its PR/MR opened, and its
    // agent has no tools to report with: its PR/MR is its own and moves it as before.
    const margin = this.options.marginMs ?? 600_000;
    const inherited = (pr: ForgePr) => !adopted && Boolean(pr.createdAt && task.run_started && Date.parse(pr.createdAt) < Date.parse(task.run_started) - margin);
    const INHERITED = "open since an earlier run of this task; the task moves to review once the agent reports the work done";

    const current = task.run_pr ? found.find((pr) => pr.url === task.run_pr) : undefined;
    if (current) {
      // Recorded while the run was live: its merge is the run's own. A PR/MR of the branch opened
      // after it carries the rest of the work, so the task follows that one instead.
      if (current.state === "merged") {
        // Numbers grow on both forges, so "opened after it" is a larger number.
        const after = (pr: ForgePr) => pr.state === "open" && Number(pr.label.slice(1)) > Number(current.label.slice(1));
        const nextReady = found.find((pr) => after(pr) && !pr.draft);
        const nextDraft = found.find((pr) => after(pr) && pr.draft);
        if (nextReady) return { op: transition("review", nextReady), view: view(nextReady) };
        if (nextDraft) return { view: view(nextDraft, `${current.label} merged earlier; ${DRAFT}`) };
        return done(current, current.mergedAt ?? at);
      }
      if (current.state === "closed") {
        if (newestReady) return { op: transition("review", newestReady), view: view(newestReady) };
        if (newestDraft) return { view: view(newestDraft, DRAFT) };
        return { view: view(current, "closed without a merge; the task stays where it is") };
      }
      return { view: view(current) };
    }
    if (newestReady && inherited(newestReady) && task.status === "in_progress") return { view: view(newestReady, INHERITED) };
    if (newestReady) return { op: transition("review", newestReady), view: view(newestReady) };
    if (newestDraft) return { view: view(newestDraft, DRAFT) };

    const merged = found.find((pr) => pr.state === "merged");
    if (merged) {
      const started = Date.parse(task.run_started ?? "");
      const mergedAt = Date.parse(merged.mergedAt ?? "");
      if (Number.isFinite(started) && Number.isFinite(mergedAt) && mergedAt > started + margin) return done(merged, merged.mergedAt);
      return { view: view(merged, "merged before this run started, or at an unknown time; mark the task done if this was its work") };
    }
    const closed = found.find((pr) => pr.state === "closed");
    return closed ? { view: view(closed, "closed without a merge") } : {};
  }
}
