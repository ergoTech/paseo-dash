import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refId, type Task } from "../../shared/model.ts";
import { frontData, parseEntity } from "../plan/document.ts";
import { opaqueId } from "../plan/ids.ts";
import { loadPlan, type Plan, realPathInside } from "../plan/load.ts";
import { renderRoadmap, ROADMAP_FILE } from "../plan/roadmap.ts";
import { classifyPush, COMMIT_CONFIG, git, SAFE_BRANCH, type GitRunner, systemGit } from "./git.ts";
import { Journal, type JournalEntry } from "./journal.ts";
import { applyOperation, derivedFeatureStatus, featuresOf, type Operation, type Outcome, type RunFields } from "./ops.ts";

/**
 * One space's plugin-owned clone, kept consistent with the plan repo's remote by re-applying
 * operations on top of origin (05-architecture.md, Sync and concurrency, invariants I1–I5).
 * Every git step runs in one serial queue per space.
 */

export interface SyncTimeouts {
  /** An ordinary fetch. */
  fetchMs: number;
  pushMs: number;
  /** Total time one flush may spend on rejected-push replays. */
  flushBudgetMs: number;
  /** I5: the fetch before a claim, the claim's push, and the deciding fetch; together under 30 s. */
  claimFetchMs: number;
  claimPushMs: number;
  claimDecideMs: number;
  /** How long an undecided claim waits for later fetches before it is given up. */
  undecidedMs: number;
}

export const DEFAULT_TIMEOUTS: SyncTimeouts = {
  fetchMs: 15_000,
  pushMs: 20_000,
  flushBudgetMs: 20_000,
  claimFetchMs: 6_000,
  claimPushMs: 10_000,
  claimDecideMs: 6_000,
  undecidedMs: 10 * 60_000,
};

const LOCAL_MS = 15_000;
const TRAILER = "Dashboard-Op";

export interface Conflict {
  op_id: string;
  kind: Operation["kind"];
  id: string;
  reason: string;
  at: string;
}

export type ClaimResult =
  | { result: "won" }
  | { result: "lost" | "refused" | "not_started"; reason: string }
  | { result: "unknown"; reason: string };

/** The new task a claim creates as `todo` before claiming it (adopting a Paseo workspace). */
export type ClaimCreate = { fields: Record<string, unknown>; body: string };

/** A caller's check of the task on freshly fetched state; a reason refuses the claim. */
export type ClaimPrecondition = (plan: Plan) => string | undefined;

export interface SpaceSyncOptions {
  root: string;
  branch: string;
  journalPath: string;
  runner?: GitRunner;
  timeouts?: Partial<SyncTimeouts>;
  now?: () => Date;
  /** A claim decided by a later fetch (I5): the runner continues or gives up its job. */
  onClaimDecided?: (task: string, runId: string, won: boolean) => void;
}

/** What a write, a sync or a claim hears once the space was disconnected from this machine. */
export const CLOSED_REASON = "the space was disconnected from this machine";

class SpaceClosed extends Error {}

export interface SyncState {
  lastFetchOk?: string;
  lastPushOk?: string;
  /** The last fetch or push problem, cleared by the next success. */
  error?: string;
  pending: number;
  conflicts: Conflict[];
  /** Claims of this machine that landed after they were reported as not started or gone. */
  lateClaims: { task: string; run_id: string }[];
  /** Runtime files that could not be read and were moved aside. */
  warnings: string[];
}

export class SpaceSync {
  /** A push after writes is queued and has not started yet (syncSoon). */
  private syncQueued = false;
  plan: Plan;
  readonly state: SyncState = { pending: 0, conflicts: [], lateClaims: [], warnings: [] };
  private readonly journal: Journal;
  private readonly runner: GitRunner;
  private readonly t: SyncTimeouts;
  private readonly now: () => Date;
  private readonly options: SpaceSyncOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  private seenTip: string | undefined;
  /**
   * D15: origin's state as last seen, from a reset or an accepted push, before any local operation
   * was applied on top. Derivation compares origin against it, so only what origin brought counts
   * as a change, never this machine's own unpushed or unstarted work.
   */
  private originPlan: Plan;
  /**
   * Operations whose caller waits for their outcome (`record`), with the latest outcome of each,
   * from whichever pass applied it: a sync already running may pick them up before the local pass.
   */
  private readonly awaiting = new Map<string, Outcome | undefined>();
  /** A commit whose push had no clear answer: once all its operations show up on origin, its
   * state is the state origin passed through, and the base for the next derivation. */
  private unconfirmed: { plan: Plan; opIds: string[] } | undefined;
  /**
   * Set once a disconnect found nothing in the way (`closeUnless`): from then on nothing is journaled
   * and no queued pass runs, so the journal and clone of a removed space are never written again
   * (writing the journal would create its directory anew).
   */
  private closed = false;

  constructor(options: SpaceSyncOptions) {
    if (!SAFE_BRANCH.test(options.branch)) throw new Error(`unsafe branch name ${JSON.stringify(options.branch)}`);
    this.options = options;
    this.runner = options.runner ?? systemGit;
    this.t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? (() => new Date());
    this.journal = new Journal(options.journalPath);
    if (this.journal.movedAside) this.state.warnings.push(`the journal could not be read and was moved to ${this.journal.movedAside}`);
    this.plan = loadPlan(options.root);
    this.originPlan = snapshot(this.plan);
    this.state.pending = this.journal.entries.length;
  }

  get root(): string {
    return this.options.root;
  }

  /** The git this clone runs, for reads of its history (server/plan/run-history.ts). */
  get gitRunner(): GitRunner {
    return this.runner;
  }

  /**
   * The plan as origin last had it, without this machine's operations that are not on origin yet:
   * what the issue mirror writes from (09-forge-issues.md, the mirror). Read only; later writes
   * replace entries, never edit them.
   */
  get committed(): Plan {
    return this.originPlan;
  }

  /** What the journal holds now: pending operations and claims not decided yet (I1, I5). */
  get journalEntries(): readonly JournalEntry[] {
    return this.journal.entries;
  }

  /**
   * Runs `check` in the space's queue, after everything queued before it, and closes the space when
   * the check finds nothing in the way: `record`, `submit` and `claim` refuse from then on, and the
   * queue runs nothing more. Returns the check's objection, if any; the space then stays open.
   */
  closeUnless(check: () => string | undefined): Promise<string | undefined> {
    return this.exclusive(async () => {
      const objection = check();
      if (!objection) this.closed = true;
      return objection;
    });
  }

  /** Records operations and writes them: committed locally at once, pushed when origin answers. */
  submit(ops: Operation[]): Promise<void> {
    return this.exclusive(async () => {
      for (const op of ops) this.journal.add(op);
      await this.flush();
    });
  }

  /**
   * Records operations for a caller who waits for their outcome: journaled at once (so they survive
   * a restart), applied and committed locally without touching the network, and pushed by a sync
   * started in the background (05-architecture.md, Write path). A refusal goes back to the caller,
   * not to the conflict list; once the caller stopped waiting (`forget`), it is a conflict again.
   */
  record(ops: Operation[]): { outcomes: Promise<Map<string, Outcome>>; forget: () => void } {
    if (this.closed) {
      const refused: Outcome = { status: "refused", reason: CLOSED_REASON };
      return { outcomes: Promise.resolve(new Map(ops.map((op) => [op.op_id, refused]))), forget: () => undefined };
    }
    for (const op of ops) {
      this.awaiting.set(op.op_id, undefined);
      this.journal.add(op);
    }
    this.state.pending = this.journal.entries.length;
    // A caller that stopped waiting never hears a refusal a pass already recorded: it becomes a conflict.
    const forget = () => {
      for (const op of ops) {
        const outcome = this.awaiting.get(op.op_id);
        this.awaiting.delete(op.op_id);
        if (outcome?.status === "refused") {
          this.state.conflicts.push({ op_id: op.op_id, kind: op.kind, id: "id" in op ? op.id : "", reason: outcome.reason, at: this.stamp() });
        }
      }
    };
    const collect = () => {
      const seen = new Map<string, Outcome>();
      for (const op of ops) {
        const outcome = this.awaiting.get(op.op_id);
        if (outcome) seen.set(op.op_id, outcome);
        this.awaiting.delete(op.op_id);
      }
      return seen;
    };
    const outcomes = this.exclusive(async () => {
      try {
        await this.localPass();
      } catch (error) {
        // The caller hears the failure, not the outcomes: later passes report refusals as conflicts.
        forget();
        throw error;
      }
      return collect();
    })
      .catch((error: unknown) => {
        // Closed after an earlier pass took these operations off the journal (else the disconnect
        // would have refused): the outcomes that pass recorded stand.
        if (error instanceof SpaceClosed) return collect();
        throw error;
      })
      .finally(() => this.syncSoon());
    return { outcomes, forget };
  }

  /** Creates journaled but possibly not applied yet (for de-duplication of drafts). */
  pendingCreates(): Extract<Operation, { kind: "create" }>[] {
    return this.journal.entries.map((e) => e.op).filter((op): op is Extract<Operation, { kind: "create" }> => op.kind === "create");
  }

  /** Ids of entities the plan has or a pending create will add: never handed out again. */
  takenIds(): Set<string> {
    const taken = new Set(this.plan.entities.keys());
    for (const id of this.plan.duplicates) taken.add(id);
    for (const entry of this.journal.entries) if (entry.op.kind === "create" || (entry.op.kind === "claim" && entry.op.create)) taken.add(entry.op.id);
    return taken;
  }

  /** The person this machine commits as (`git config user.name`); empty when unset. */
  async gitUser(): Promise<string> {
    const result = await this.runner.run(this.root, ["config", "user.name"], 2_000);
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  }

  /** The email this machine commits with (`git config user.email`); empty when unset. */
  async gitEmail(): Promise<string> {
    const result = await this.runner.run(this.root, ["config", "user.email"], 2_000);
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  }

  /** Who last changed a file on origin, per git (a hint: git authorship is not authenticated). */
  async lastAuthor(path: string): Promise<string> {
    const result = await this.runner.run(this.root, ["log", "-1", "--format=%an", this.remoteRef(), "--", path], 2_000);
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  }

  /**
   * One push after writes: many agents reporting at once queue one fetch and push behind the work in
   * hand, not one each, so a start's claim does not wait behind a queue of them.
   */
  private syncSoon(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    void this.exclusive(() => {
      this.syncQueued = false;
      return this.flush();
    }).catch(() => undefined);
  }

  /** The fetch loop's tick: brings in others' changes and pushes what is pending. */
  sync(): Promise<void> {
    return this.exclusive(() => this.flush());
  }

  /**
   * I5: claims a task for a new run. The budget counts from this call, so time spent waiting behind
   * another write in the queue is counted too; a claim that waited too long starts nothing.
   */
  claim(taskId: string, run: RunFields, precondition?: ClaimPrecondition, create?: ClaimCreate): Promise<ClaimResult> {
    const deadline = this.now().getTime() + this.t.claimFetchMs + this.t.claimPushMs + this.t.claimDecideMs;
    return this.exclusive(async () => {
      const result = await this.claimLocked(taskId, run, deadline, precondition, create);
      // The claim left the clone at origin; this machine's pending writes are applied again next in
      // the queue, outside the caller's time budget.
      void this.exclusive(() => this.localPass()).catch(() => undefined);
      return result;
    }).catch((error: unknown): ClaimResult => {
      if (error instanceof SpaceClosed) return { result: "not_started", reason: `${CLOSED_REASON}; nothing was started` };
      throw error;
    });
  }

  /** The space's serial queue; once the space is closed, a queued step is refused instead of run. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const step = () => (this.closed ? Promise.reject(new SpaceClosed(CLOSED_REASON)) : fn());
    const next = this.chain.then(step, step);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private async git(args: string[], timeoutMs = LOCAL_MS): Promise<string> {
    return git(this.runner, this.root, args, timeoutMs);
  }

  private async fetch(timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    const result = await this.runner.run(this.root, ["fetch", "--quiet", "origin", `+refs/heads/${this.options.branch}:refs/remotes/${this.remoteRef()}`], timeoutMs);
    if (result.code === 0 && !result.timedOut) {
      this.state.lastFetchOk = this.stamp();
      this.state.error = undefined;
      return { ok: true };
    }
    const error = result.timedOut ? "the plan repo did not answer in time" : result.stderr.trim().split("\n").pop() || "fetch failed";
    this.state.error = error;
    return { ok: false, error };
  }

  private remoteRef(): string {
    return `origin/${this.options.branch}`;
  }

  /**
   * I1: the operation ids origin carries, read incrementally from commit trailers. Runs on every
   * pass, fetched or not: the local tracking ref is authoritative for what it already contains.
   */
  private async updateSeen(): Promise<void> {
    const ref = await this.runner.run(this.root, ["rev-parse", "--verify", "--quiet", this.remoteRef()], LOCAL_MS);
    if (ref.code !== 0) return;
    const tip = ref.stdout.trim();
    if (tip === this.seenTip) return;
    let range = tip;
    if (this.seenTip) {
      const ancestor = await this.runner.run(this.root, ["merge-base", "--is-ancestor", this.seenTip, tip], LOCAL_MS);
      if (ancestor.code === 0) range = `${this.seenTip}..${tip}`;
    }
    const out = await this.git(["log", `--format=%(trailers:key=${TRAILER},valueonly)`, range]);
    for (const line of out.split("\n")) if (line.trim()) this.seen.add(line.trim());
    this.seenTip = tip;
  }

  /** The clone and the in-memory plan both become origin's state; nothing local survives. */
  private async resetToOrigin(): Promise<void> {
    await this.git(["reset", "--quiet", "--hard", this.remoteRef()]);
    await this.git(["clean", "--quiet", "-fd"]);
    this.plan = loadPlan(this.root);
    this.originPlan = snapshot(this.plan);
  }

  /** Re-reads origin's state into the clone and the index; returns origin's state seen before. */
  private async refresh(fetched: boolean): Promise<Plan> {
    let previous = this.originPlan;
    await this.updateSeen();
    if (this.unconfirmed?.opIds.every((id) => this.seen.has(id))) {
      previous = this.unconfirmed.plan;
      this.unconfirmed = undefined;
    } else if (fetched) {
      // Origin was read and the commit is not on it: it did not land, the usual base stands.
      this.unconfirmed = undefined;
    }
    await this.resetToOrigin();
    return previous;
  }

  /**
   * Drops operations already on origin, decides undecided claims and notices late ones (I1, I5).
   * An undecided claim is given up only after a fetch that read origin without it, past its wait.
   */
  private settleJournal(fetched: boolean): void {
    const done = this.journal.entries.filter((entry) => this.seen.has(entry.op.op_id) && !entry.undecided && !entry.inflight);
    this.journal.remove(done.map((entry) => entry.op.op_id));
    for (const entry of [...this.journal.entries]) {
      if (!entry.undecided) continue;
      const task = this.plan.entities.get(entry.undecided.task)?.entity as Task | undefined;
      if (task?.run_id === entry.undecided.run_id || this.seen.has(entry.op.op_id)) {
        this.journal.remove([entry.op.op_id]);
        this.options.onClaimDecided?.(entry.undecided.task, entry.undecided.run_id, true);
      } else if (fetched && this.now().getTime() - Date.parse(entry.undecided.since) > this.t.undecidedMs) {
        this.journal.remove([entry.op.op_id]);
        this.abandon(entry.undecided.task, entry.undecided.run_id);
        this.options.onClaimDecided?.(entry.undecided.task, entry.undecided.run_id, false);
      }
    }
    for (const claim of [...this.journal.abandonedClaims]) {
      const task = this.plan.entities.get(claim.task)?.entity as Task | undefined;
      if (task?.run_id === claim.run_id) {
        this.state.lateClaims.push(claim);
        this.journal.abandonedClaims = this.journal.abandonedClaims.filter((c) => c !== claim);
        this.journal.save();
      }
    }
  }

  /** A claim reported as not started or gone; if it ever shows up on origin, it is an orphan. */
  private abandon(task: string, runId: string): void {
    this.journal.abandonedClaims.push({ task, run_id: runId });
    this.journal.save();
  }

  /**
   * D15: derived feature transitions for every feature whose task set changed, by the given
   * operations and, when `previous` is given, by whatever origin brought since then. Each carries
   * the status it was derived from and origin's tip, so a retry never overrides a person's choice.
   */
  private derive(touched: string[], before: Map<string, string | undefined>, previous: Plan | undefined): Operation[] {
    if (previous) {
      for (const [id, loaded] of this.plan.entities) {
        if (loaded.entity.type !== "task") continue;
        const old = previous.entities.get(id)?.entity;
        if (!old || old.type !== "task" || old.status !== loaded.entity.status || refId(old.feature) !== refId(loaded.entity.feature)) {
          touched.push(id);
          before.set(id, old?.type === "task" ? refId(old.feature) : undefined);
        }
      }
    }
    const applied: Operation[] = [];
    for (const featureId of featuresOf(this.plan, touched, before)) {
      const to = derivedFeatureStatus(this.plan, featureId);
      const feature = this.plan.entities.get(featureId)?.entity;
      if (!to || feature?.type !== "feature") continue;
      const op: Operation = { op_id: opaqueId("op"), kind: "derived", id: featureId, to, expect: feature.status, since: this.seenTip };
      if (applyOperation(this.root, this.plan, op, this.stamp()).status === "applied") applied.push(op);
    }
    return applied;
  }

  /**
   * D15: a derived transition still waiting for a push is dropped when someone edited that feature's
   * status on origin after it was derived; their choice stands until the next task-set change.
   */
  private async dropOverriddenDerived(): Promise<void> {
    const overridden: string[] = [];
    for (const op of this.journal.pending()) {
      if (op.kind !== "derived" || !op.since || op.since === this.seenTip) continue;
      const path = this.plan.entities.get(op.id)?.path;
      if (!path) continue;
      if (!/^[0-9a-f]{40,64}$/.test(op.since) || (await this.statusEdited(path, op.since, op.expect))) overridden.push(op.op_id);
    }
    this.journal.remove(overridden);
  }

  /**
   * Whether any commit on origin since `since` left the feature at `path` with a status other than
   * `expect`, read from each version's front matter (so body text and key quoting do not matter and
   * an A→B→A edit is still seen). A history that cannot be read counts as edited.
   */
  private async statusEdited(path: string, since: string, expect: string | undefined): Promise<boolean> {
    const log = await this.runner.run(this.root, ["log", "--format=%H", `${since}..${this.remoteRef()}`, "--", path], LOCAL_MS);
    if (log.code !== 0) return true;
    for (const sha of log.stdout.split("\n").filter(Boolean)) {
      const show = await this.runner.run(this.root, ["show", `${sha}:${path}`], LOCAL_MS);
      if (show.code !== 0) return true;
      try {
        if (frontData(parseEntity(show.stdout)).status !== expect) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  private featureOf(id: string): string | undefined {
    const entity = this.plan.entities.get(id)?.entity;
    return entity?.type === "task" ? refId(entity.feature) : undefined;
  }

  /** Applies the pending operations to a clone reset to origin; returns the ids to commit. */
  private applyPending(previous: Plan | undefined): string[] {
    const now = this.stamp();
    const applied: string[] = [];
    const leave: string[] = [];
    const touched: string[] = [];
    const before = new Map<string, string | undefined>();
    const pass = new Map<string, Outcome>();
    for (const op of this.journal.pending()) {
      if ("id" in op && op.kind !== "create") before.set(op.id, this.featureOf(op.id));
      // A pinned color lives and dies with the operation it was pinned for, journaled just before it.
      const outcome: Outcome =
        op.kind === "project" && op.pin && pass.get(op.pin)?.status !== "applied"
          ? { status: "dropped", reason: "the change it was pinned for did not apply" }
          : applyOperation(this.root, this.plan, op, now);
      pass.set(op.op_id, outcome);
      if (this.awaiting.has(op.op_id)) this.awaiting.set(op.op_id, outcome);
      if (outcome.status === "applied") {
        applied.push(op.op_id);
        touched.push(...outcome.tasksTouched);
        continue;
      }
      leave.push(op.op_id);
      if (outcome.status === "refused" && !this.awaiting.has(op.op_id)) {
        this.state.conflicts.push({ op_id: op.op_id, kind: op.kind, id: "id" in op ? op.id : "", reason: outcome.reason, at: now });
      }
    }
    this.journal.remove(leave);
    // Journaled like any operation: a derived transition whose push fails is retried, not lost.
    const derived = this.derive(touched, before, previous);
    for (const op of derived) this.journal.add(op);
    return [...applied, ...derived.map((op) => op.op_id)];
  }

  private async commit(opIds: string[]): Promise<void> {
    this.writeRoadmap();
    await this.git(["add", "-A"]);
    const trailers = opIds.map((id) => `${TRAILER}: ${id}`).join("\n");
    const subject = `dashboard: ${opIds.length} change${opIds.length === 1 ? "" : "s"}`;
    await this.git([...COMMIT_CONFIG, "commit", "--quiet", "-m", subject, "-m", trailers]);
  }

  /**
   * ROADMAP.md rides in each of the plugin's own commits, rendered from the plan being committed and
   * written only when its text changes (05-architecture.md, Derived files). It never stops a commit:
   * a path that is not a plain file inside the clone is left alone and reported once.
   */
  private writeRoadmap(): void {
    const path = join(this.root, ROADMAP_FILE);
    try {
      const text = renderRoadmap(this.plan);
      if (text === undefined) return;
      if (!realPathInside(this.root, ROADMAP_FILE) || (existsSync(path) && !lstatSync(path).isFile())) {
        throw new Error("it is not a plain file in the plan repository");
      }
      if (existsSync(path) && readFileSync(path, "utf8") === text) return;
      writeFileSync(path, text);
    } catch (error) {
      const warning = `${ROADMAP_FILE} was not updated: ${String((error as Error)?.message ?? error)}`;
      if (!this.state.warnings.includes(warning)) this.state.warnings.push(warning);
    }
  }

  private push(timeoutMs: number) {
    return this.runner.run(this.root, ["push", "--quiet", "origin", `HEAD:refs/heads/${this.options.branch}`], timeoutMs);
  }

  /** Applies and commits what is pending on top of the last fetched origin, without the network. */
  private async localPass(): Promise<void> {
    try {
      await this.refresh(false);
      this.settleJournal(false);
      await this.dropOverriddenDerived();
      const opIds = this.applyPending(undefined);
      if (opIds.length) await this.commit(opIds);
    } finally {
      this.state.pending = this.journal.entries.length;
    }
  }

  private async flush(): Promise<void> {
    const deadline = this.now().getTime() + this.t.flushBudgetMs;
    try {
      for (;;) {
        const fetched = (await this.fetch(this.t.fetchMs)).ok;
        const previous = await this.refresh(fetched);
        this.settleJournal(fetched);
        await this.dropOverriddenDerived();
        const opIds = this.applyPending(fetched ? previous : undefined);
        if (!opIds.length) return;
        await this.commit(opIds);
        if (!fetched) return;
        const push = classifyPush(await this.push(this.t.pushMs));
        if (push === "accepted") {
          for (const id of opIds) this.seen.add(id);
          this.journal.remove(opIds);
          this.state.lastPushOk = this.stamp();
          this.originPlan = snapshot(this.plan);
          return;
        }
        if (push === "unknown") this.unconfirmed = { plan: snapshot(this.plan), opIds };
        this.state.error = push === "rejected" ? undefined : `push ${push}`;
        if (push !== "rejected" || this.now().getTime() > deadline) return;
      }
    } finally {
      this.state.pending = this.journal.entries.length;
    }
  }

  private async claimLocked(taskId: string, run: RunFields, deadline: number, precondition?: ClaimPrecondition, create?: ClaimCreate): Promise<ClaimResult> {
    const left = (step: number) => Math.max(1, Math.min(step, deadline - this.now().getTime()));
    if (deadline - this.now().getTime() < 1_000) {
      return { result: "not_started", reason: "the plan repo was busy with other changes for too long; nothing was started" };
    }
    const pre = await this.fetch(left(this.t.claimFetchMs));
    if (!pre.ok) return { result: "not_started", reason: `could not reach the plan repo; nothing was started (${pre.error})` };

    const op: Operation = { op_id: opaqueId("op"), kind: "claim", id: taskId, run, ...(create ? { create } : {}) };
    this.journal.add(op, true);
    const finish = (result: ClaimResult): ClaimResult => {
      this.journal.remove([op.op_id]);
      this.state.pending = this.journal.entries.length;
      return result;
    };
    const notStarted = async (reason: string): Promise<ClaimResult> => {
      await this.resetToOrigin().catch(() => undefined);
      // After a push attempt, keep a record: if it ever shows up on origin, it is an orphan.
      this.abandon(taskId, run.run_id);
      return finish({ result: "not_started", reason });
    };

    try {
      for (;;) {
        const previous = await this.refresh(true);
        this.settleJournal(true);
        // Transitions answering what origin brought are journaled before the claim is applied: they
        // ride with the claim's commit when it lands and are retried by a flush when it does not.
        const answering = this.derive([], new Map(), previous);
        for (const derivedOp of answering) this.journal.add(derivedOp);
        // The caller's own checks, again on the state just fetched: the index it checked may be older.
        const objection = precondition?.(this.plan);
        if (objection) return finish({ result: "refused", reason: objection });
        const before = new Map([[taskId, this.featureOf(taskId)]]);
        const outcome = applyOperation(this.root, this.plan, op, this.stamp());
        if (outcome.status === "already") return finish({ result: "won" });
        if (outcome.status !== "applied") {
          const reason = outcome.status === "refused" ? outcome.reason : "the task changed";
          return finish({ result: reason.startsWith("already started") ? "lost" : "refused", reason });
        }
        // The claim's own transitions live and die with its commit.
        const own = this.derive([...outcome.tasksTouched], before, undefined).map((d) => d.op_id);
        const carried = answering.map((d) => d.op_id);
        const derived = [...own, ...carried];
        await this.commit([op.op_id, ...derived]);
        const pushed = await this.push(left(this.t.claimPushMs));
        const push = classifyPush(pushed);
        if (push === "accepted") {
          this.seen.add(op.op_id);
          for (const id of derived) this.seen.add(id);
          this.journal.remove(carried);
          this.state.lastPushOk = this.stamp();
          this.originPlan = snapshot(this.plan);
          return finish({ result: "won" });
        }
        const said = pushed.stderr.trim().split("\n").filter(Boolean).pop() ?? push;
        if (push === "declined") return await notStarted(`the plan repo refused the push; nothing was started (${said})`);
        if (push === "unreachable") return await notStarted(`could not reach the plan repo; nothing was started (${said})`);
        if (push === "rejected") {
          // A rejected push changed nothing on origin: replay while there is time, else nothing started.
          if (deadline - this.now().getTime() > 1_000 && (await this.fetch(left(this.t.claimFetchMs))).ok) continue;
          return await notStarted("the plan repo kept changing and could not be read again in time; nothing was started");
        }
        // Cut midway or unexplained: only origin can tell (I5).
        const decide = await this.fetch(left(this.t.claimDecideMs));
        if (decide.ok) {
          await this.updateSeen();
          // The clone holds exactly the commit that landed, derived transitions included.
          if (this.seen.has(op.op_id)) {
            this.originPlan = snapshot(this.plan);
            return finish({ result: "won" });
          }
        }
        this.unconfirmed = { plan: snapshot(this.plan), opIds: [op.op_id, ...derived] };
        return await this.markUndecided(op, taskId, run, "the claim's push did not finish; whether it landed is decided by the next fetches");
      }
    } catch (error) {
      return this.markUndecided(op, taskId, run, `the claim failed midway (${(error as Error).message}); whether it landed is decided by the next fetches`);
    }
  }

  private async markUndecided(op: Operation, taskId: string, run: RunFields, reason: string): Promise<ClaimResult> {
    const entry = this.journal.entries.find((e) => e.op.op_id === op.op_id);
    if (entry) {
      delete entry.inflight;
      entry.undecided = { since: this.stamp(), run_id: run.run_id, task: taskId };
      this.journal.save();
    }
    this.state.pending = this.journal.entries.length;
    await this.resetToOrigin().catch(() => undefined);
    return { result: "unknown", reason };
  }
}

/** A copy that later writes to the plan cannot change: they replace entries, never edit them. */
function snapshot(plan: Plan): Plan {
  return { ...plan, entities: new Map(plan.entities), duplicates: new Set(plan.duplicates), problems: [...plan.problems] };
}
