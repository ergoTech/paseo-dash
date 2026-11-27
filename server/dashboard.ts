import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi } from "./paseo.ts";
import { hasLiveRun, SPACE_KEY_PATTERN } from "../shared/model.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";
import { OwnerLock } from "./lock.ts";
import { opaqueId } from "./plan/ids.ts";
import { loadPlan } from "./plan/load.ts";
import { PlanRecap } from "./plan/recap.ts";
import { RunHistory } from "./plan/run-history.ts";
import { type LocalProject, mapProjects, normalizeRemote } from "./spaces/mapping.ts";
import { COMMIT_CONFIG, git, type GitRunner, SAFE_BRANCH, systemGit } from "./sync/git.ts";
import { SpaceSync, type SyncTimeouts } from "./sync/space-sync.ts";
import type { Operation } from "./sync/ops.ts";
import { LookupCache } from "./runner/branch.ts";
import { Profiles } from "./runner/profiles.ts";
import { Runner, type RunnerOptions } from "./runner/runner.ts";
import { type RunRecord, RunStore } from "./runner/runs.ts";
import type { AgentStopper } from "./runner/stop.ts";
import { Autopilot } from "./autopilot.ts";
import { Tracker, type TrackerOptions } from "./tracker/tracker.ts";
import { RunFollower, type FollowerOptions } from "./tracker/follow.ts";
import { AgentToolsBridge, sameToken } from "./agent-tools/bridge.ts";
import { handleTool } from "./agent-tools/tools.ts";
import { ForgeCli, ForgeIssues } from "./tracker/forge.ts";
import { IssueTracker, type IssueTrackerOptions } from "./tracker/issues.ts";
import { IssueWriter } from "./issues/forge-write.ts";
import { IssueMirror, type IssueMirrorOptions, MirrorStore } from "./issues/mirror.ts";
import { PrTracker, type PrTrackerOptions } from "./tracker/prs.ts";
import { MergedTracker, type MergedTrackerOptions } from "./tracker/merged.ts";
import { WebHosts } from "./tracker/web-host.ts";
import { BatchStore } from "./api/batch.ts";
import { WaitProbe } from "./wait.ts";
import { subAgentsAtWork } from "./needs.ts";
import { prDetails } from "./tracker/details.ts";
import { readLanded } from "./tracker/landed.ts";
import { SeenStore } from "./runner/seen.ts";
import { EventStore, noteActivity } from "./events.ts";
import { VIEW_FILES } from "./plan/views.ts";
import { ActivityReader, runWorkspaces } from "./activity.ts";
import { LaconoteStore } from "./laconote/store.ts";
import { ReleasePusher, type ReleasePusherOptions, ReleaseStore } from "./laconote/releases.ts";
import { UiPrefsStore } from "./ui-prefs.ts";
import { checkGodModeFile } from "./godmode-settings.ts";
import { checkPlanToolsFile, planToolsOn } from "./plan-tools-settings.ts";
import { DelegationStore } from "./delegation/store.ts";
import { ManagedQueue } from "./managed/queue.ts";
import { handleCoordinatorTool } from "./delegation/tools.ts";
import { handlePlanTool, PlanCallers } from "./agent-tools/plan.ts";

/**
 * The daemon side of the dashboard: the owner lock, the registry of connected spaces, one
 * SpaceSync per space, and the fetch loop. Nothing here starts before `start()`, which the first
 * RPC triggers, so `contribute()` stays cheap and cannot fail on I/O.
 */

export function defaultDataDir(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "dashboard");
}

const registrySchema = z.object({
  version: z.literal(1),
  spaces: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      remote: z.string(),
      branch: z.string(),
      added: z.string(),
      mapping: z.record(z.string(), z.string().nullable()).default({}),
      /** Project keys mapped by hand on this machine to a Paseo project id. */
      overrides: z.record(z.string(), z.string()).default({}),
    }),
  ),
});
type Registry = z.output<typeof registrySchema>;
export type SpaceRecord = Registry["spaces"][number];

export interface DashboardOptions {
  dataDir?: string;
  /** How a run's agent is stopped: the plugin passes the Paseo CLI (server/runner/stop.ts). */
  stopAgent?: AgentStopper;
  runner?: GitRunner;
  fetchIntervalMs?: number;
  timeouts?: Partial<SyncTimeouts>;
  lock?: { heartbeatMs: number; staleMs: number };
  starts?: Partial<RunnerOptions>;
  tracker?: Partial<TrackerOptions>;
  follower?: Partial<FollowerOptions>;
  prs?: Partial<PrTrackerOptions>;
  issues?: Partial<IssueTrackerOptions>;
  merged?: Partial<MergedTrackerOptions>;
  mirror?: Partial<IssueMirrorOptions>;
  releases?: Partial<ReleasePusherOptions>;
  /** The forge CLIs (gh, glab); injectable for tests. */
  forge?: ForgeCli;
}

const NETWORK_MS = 60_000;

/** README and LICENSE as a forge names them, at the root; `.gitignore` is matched exactly. */
const FORGE_FILE = /^(?:README|LICENSE)(?:\.[A-Za-z0-9]+)?$/i;

/** The plugin's line in a plan repository's `.gitignore`: Obsidian's per-machine layout files. */
const IGNORE_LINE = ".obsidian/workspace*.json";

/** How old a tracked trunk checkout's landed reading may be before a screen's read asks git again. */
const LANDED_FRESH_MS = 10_000;
/** While someone looks at the dashboard, live runs' PRs/MRs are checked at most this often. */
const PRS_FRESH_MS = 60_000;

/** A pending operation in a few words, for a refused disconnect. */
function describeOp(op: Operation): string {
  if (op.kind === "set") return `${op.field} of ${op.id}`;
  if (op.kind === "delegated") return `a coordinator's change of ${op.id}`;
  if ("id" in op) return `${op.kind} of ${op.id}`;
  if ("key" in op) return `${op.kind} ${op.key}`;
  if ("name" in op) return `${op.kind} ${op.name}`;
  return op.kind;
}

/**
 * Since when this machine stops agents of runs another machine released (D23): written once, the first
 * time this version runs, so runs that ended before stops existed are history, not news, however long
 * a machine was away.
 */
const stopsFileSchema = z.object({ since: z.string() });

export class Dashboard {
  readonly dataDir: string;
  readonly spaces = new Map<string, { record: SpaceRecord; sync: SpaceSync }>();
  ownerReason = "";
  /** Runtime files that could not be read and were moved aside. */
  readonly warnings: string[] = [];
  private registry: Registry = { version: 1, spaces: [] };
  private readonly lock: OwnerLock;
  private readonly runner: GitRunner;
  private readonly stopper: AgentStopper;
  private stopsFrom = "";
  /** This machine's autopilot flags and passes; set once this installation owns the data. */
  autopilot: Autopilot | undefined;
  private readonly options: DashboardOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started: Promise<void> | undefined;
  private syncing = false;
  /** Spaces being disconnected: gone from `spaces`, and not connected again until that is over. */
  private readonly disconnecting = new Set<string>();
  /** Paseo's API, which arrives with the first RPC or hook (05-architecture.md, Lifecycle). */
  paseo: PaseoApi | undefined;
  /** Runs started on this machine, and the start jobs that drive them; owner only. */
  runs: RunStore | undefined;
  starts: Runner | undefined;
  readonly profiles = new Profiles();
  /** The start confirmation's lookups of origin's branches and PRs/MRs, kept for a minute; a start asks again. */
  readonly startLookups = new LookupCache();
  /** Each task's runs as the plan's commits have them, read when a screen or God Mode asks. */
  readonly runHistory = new RunHistory();
  /** Each clone's task changes over a period, read when the Live tab or God Mode asks for a recap. */
  readonly recap = new PlanRecap();
  readonly tracker: Tracker;
  /** What this machine's running task agents touch, live (server/tracker/follow.ts). */
  readonly follower: RunFollower;
  readonly prs: PrTracker;
  readonly forge: ForgeCli;
  /** Issue reads through the forge CLIs, and what this machine last read of each task's issue. */
  readonly forgeIssues: ForgeIssues;
  readonly issues: IssueTracker;
  /** Work merged outside the dashboard for tasks that never ran (server/tracker/merged.ts). */
  readonly merged: MergedTracker;
  /** GitLab projects' web hosts as their forges name them (server/tracker/web-host.ts). */
  readonly webHosts: WebHosts;
  /** What idle run agents wait on: their child agents and their PR/MR's checks (server/wait.ts). */
  readonly waits: WaitProbe;
  /** The one-way issue mirror (server/issues/mirror.ts); writes only where its switch is on. */
  readonly mirror: IssueMirror;
  /** This machine's mirror switches and the issues the mirror made; owner only. */
  mirrorStore: MirrorStore | undefined;
  /** What the local user last saw of each task's instructions; owner only. */
  seen: SeenStore | undefined;
  /** update_tasks' checkpoints per idempotency key (server/api/batch.ts); owner only. */
  batches: BatchStore | undefined;
  /** Task events of this machine's runs (server/events.ts). */
  events: EventStore | undefined;
  /** This machine's Laconote URLs, key and imports; owner only. */
  laconote: LaconoteStore | undefined;
  /** Sends each mapped project's open milestones to Laconote (server/laconote/releases.ts). */
  readonly releases: ReleasePusher;
  /** This machine's release context mapping and what was sent; owner only. */
  releaseStore: ReleaseStore | undefined;
  /** This machine's display choices (the sidebar's rows); owner only. */
  prefs: UiPrefsStore | undefined;
  /** The agent tools socket; undefined until open, or when it could not start (then agents get no tools). */
  bridge: AgentToolsBridge | undefined;
  /** The plan tools' tokens of open agent sessions (server/agent-tools/plan.ts). */
  readonly planCallers = new PlanCallers();
  /** The tokens of coordinators' sessions, apart from the plan tools': one token reaches one set of tools. */
  readonly coordinatorCallers = new PlanCallers();
  /** Who may do what by delegation, and what they did (server/delegation/store.ts); the owner's only. */
  delegation: DelegationStore | undefined;
  /** This machine's managed queue: the owner's limits and what it started (server/managed/); the owner's only. */
  queue: ManagedQueue | undefined;
  /** Paseo workspaces no dashboard task runs in (server/activity.ts). */
  readonly activity = new ActivityReader(
    () => this.paseo,
    () => runWorkspaces(this),
  );

  constructor(options: DashboardOptions = {}) {
    this.options = options;
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.runner = options.runner ?? systemGit;
    // The plugin passes the Paseo CLI (index.server.ts); without one (tests) nothing is stopped.
    this.stopper = options.stopAgent ?? (async () => ({ ok: false, error: "no way to stop agents here" }));
    this.lock = new OwnerLock(join(this.dataDir, "owner.lock"), {
      ...(options.lock ?? { heartbeatMs: 30_000, staleMs: 120_000 }),
      log: (message) => console.error(`dashboard: ${message}`),
    });
    this.tracker = new Tracker({
      runs: () => (this.owner ? this.runs : undefined),
      paseo: () => this.paseo,
      attach: (paseo) => this.attach(paseo),
      isLive: (run) => this.isLive(run),
      log: (message) => console.error(`dashboard: ${message}`),
      onTurnStarted: (run, cwd) => void this.follower.follow(run, cwd),
      onAgentSeen: (run, cwd) => {
        void this.follower.follow(run, cwd);
        if (run.activity === "waiting") void this.waits.probe(run);
      },
      onReconciled: () => this.follower.sweep(),
      onTurnEnded: (run) => void this.turnEnded(run),
      onLastMessage: (run) => {
        if (run.activity === "waiting" && run.lastMessage) this.events?.fill(run.run_id, run.activityAt, run.lastMessage);
      },
      // An archive often follows the merge, and with lines left it is what finishes the task.
      onWorkspaceArchived: (run) => this.checkPrs(run),
      onReconcileTrunk: (run) => void this.refreshLanded(run),
      onRunOver: (run) => this.stopReleased(run),
      ...options.tracker,
    });
    this.follower = new RunFollower({
      runs: () => (this.owner ? this.runs : undefined),
      paseo: () => this.paseo,
      git: this.runner,
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.follower,
    });
    this.forge = options.forge ?? new ForgeCli();
    this.prs = new PrTracker({
      spaces: () => (this.owner ? [...this.spaces.values()].map(({ record, sync }) => ({ key: record.key, sync, mapping: record.mapping })) : []),
      runs: () => (this.owner ? this.runs : undefined),
      projectRoot: (projectId) => this.projectRoots.get(projectId),
      forge: this.forge,
      archived: (run) => this.workspaceArchived(run),
      ready: () => this.local !== undefined,
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.prs,
    });
    this.forgeIssues = new ForgeIssues(this.forge);
    this.issues = new IssueTracker({
      plans: () => (this.owner ? [...this.spaces.values()].map(({ sync }) => sync.plan) : []),
      issues: this.forgeIssues,
      cwd: () => this.dataDir,
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.issues,
    });
    this.merged = new MergedTracker({
      spaces: () => (this.owner ? [...this.spaces.values()].map(({ record, sync }) => ({ sync, mapping: record.mapping })) : []),
      projectRoot: (projectId) => this.projectRoots.get(projectId),
      forge: this.forge,
      ready: () => this.local !== undefined,
      // The issues tracker reads before this one is asked: its closers are the forge's own answer.
      issueClosers: (plan, task) => this.issues.peek(task, plan)?.closedBy ?? [],
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.merged,
    });
    this.waits = new WaitProbe({
      paseo: () => this.paseo,
      checks: (run) => this.ownChecks(run),
      log: (message) => console.error(`dashboard: ${message}`),
    });
    this.webHosts = new WebHosts({ forge: this.forge, cwd: () => this.dataDir, log: (message) => console.error(`dashboard: ${message}`) });
    this.mirror = new IssueMirror({
      spaces: () => (this.owner ? [...this.spaces.values()].map(({ record, sync }) => ({ key: record.key, sync })) : []),
      store: () => (this.owner ? this.mirrorStore : undefined),
      writer: new IssueWriter(this.forge, this.dataDir),
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.mirror,
    });
    this.releases = new ReleasePusher({
      spaces: () => (this.owner ? [...this.spaces.values()].map(({ record, sync }) => ({ key: record.key, sync })) : []),
      store: () => (this.owner ? this.releaseStore : undefined),
      laconote: () => (this.owner ? this.laconote : undefined),
      log: (message) => console.error(`dashboard: ${message}`),
      ...options.releases,
    });
  }

  private readonly landedReads = new Map<string, Promise<void>>();

  /**
   * Reads whether a tracked checkout on the trunk landed (server/tracker/landed.ts) and keeps the
   * answer in runs.json; one read per run at a time, and only while the plan holds the run.
   */
  refreshLanded(run: RunRecord): Promise<void> {
    if (!run.adopted?.trunk || !this.owner || this.isLive(run) === false) return Promise.resolve();
    const running = this.landedReads.get(run.run_id);
    if (running) return running;
    const read = readLanded(this.git, this.paseo, run, this.projectRoots.get(run.projectId), new Date())
      .then((landed) => {
        if (!landed || !run.adopted) return;
        run.adopted.landed = landed;
        this.runs?.save();
      })
      .catch((error: unknown) => console.error(`dashboard: landed check of ${run.task}: ${(error as Error).message}`))
      .finally(() => this.landedReads.delete(run.run_id));
    this.landedReads.set(run.run_id, read);
    return read;
  }

  /** A landed reading older than `freshMs` starts a new one in the background; reads never wait. */
  peekLanded(run: RunRecord, freshMs = LANDED_FRESH_MS): void {
    const at = Date.parse(run.adopted?.landed?.at ?? "");
    if (!Number.isFinite(at) || Date.now() - at >= freshMs) void this.refreshLanded(run);
  }

  /** A pass over every live run's PR/MR when the last one is older than PRS_FRESH_MS; reads never wait. */
  peekPrs(): void {
    if (this.owner) this.prs.peek(PRS_FRESH_MS);
  }

  /** Checks one run's PR/MR now (after a turn, or when its agent reported one); errors are logged. */
  checkPrs(run: RunRecord): void {
    if (run.adopted?.trunk) {
      void this.refreshLanded(run);
      return;
    }
    const entry = this.spaces.get(run.space);
    const task = entry?.sync.plan.entities.get(run.task)?.entity;
    if (!this.owner || !entry || task?.type !== "task") return;
    void this.prs
      .check({ sync: entry.sync, mapping: entry.record.mapping }, task)
      .catch((error: unknown) => console.error(`dashboard: PR check of ${run.task}: ${(error as Error).message}`));
  }

  /**
   * Whether the run's workspace is archived, as Paseo says now: `archivingAt` set, or the workspace
   * no longer listed while its agent is already seen stopped. False when Paseo cannot be asked, so a
   * failed read never ends a run.
   */
  async workspaceArchived(run: RunRecord): Promise<boolean> {
    if (!this.paseo || !run.workspaceId) return false;
    const descriptor = (await this.paseo.workspaces.ref(run.workspaceId).refresh()) as { archivingAt?: string | null } | null;
    return descriptor === null ? run.activity === "stopped" : Boolean(descriptor.archivingAt);
  }

  /**
   * Stops a run's agent on this machine (D23), once: when this machine releases the run, and when
   * another machine's release reaches this one, however late (its task back to todo or canceled, or
   * claimed by a new run). A run that ended by its merge or by a release to done (the plan cannot tell the two
   * apart) is left alone: its agent is done, and a person may still be talking to it.
   *
   * Invariant: an agent belongs to at most one live run here, and stopping an ended run's agent never
   * touches an agent a newer run holds (a workspace tracked again keeps its agent). Answers what a
   * person should hear: "" when stopped or when there was nothing to stop.
   */
  async stopAgentOf(run: RunRecord): Promise<string> {
    if (!run.agentId || run.stoppedAt || run.activity === "stopped") return "";
    // Marked first, so a reconcile pass meanwhile does not stop it twice.
    run.stoppedAt = new Date().toISOString();
    this.runs?.save();
    if (this.runs?.byAgent(run.agentId) !== run) return "";
    const stopped = await this.stopper(run.agentId).catch((error: unknown) => ({ ok: false, error: String((error as Error)?.message ?? error) }));
    if (!stopped.ok) console.error(`dashboard: run ${run.run_id}: its agent could not be stopped: ${stopped.error}`);
    return stopped.ok ? "" : stopped.error;
  }

  private stopsSince(): string {
    if (this.stopsFrom) return this.stopsFrom;
    const path = join(this.dataDir, "stops.json");
    let since = readJsonFile(path, stopsFileSchema, () => ({ since: "" })).value.since;
    if (!since) {
      since = new Date().toISOString();
      writeJsonFile(path, { since });
    }
    this.stopsFrom = since;
    return since;
  }

  /** A release seen from another machine, made since this machine stops agents (stopsSince). */
  private async stopReleased(run: RunRecord): Promise<void> {
    if (!this.owner || !run.agentId || run.stoppedAt || run.activity === "stopped") return;
    const task = this.spaces.get(run.space)?.sync.plan.entities.get(run.task)?.entity;
    if (task?.type !== "task") return;
    const ended = task.run_id === run.run_id ? task.run_ended : task.run_started;
    const recent = Boolean(ended) && Date.parse(ended!) >= Date.parse(this.stopsSince());
    const released = task.run_id !== run.run_id || task.status === "todo" || task.status === "canceled";
    if (released && recent) await this.stopAgentOf(run);
    else if (released) {
      // Ended before stops existed: remembered, so the pass does not look at it again.
      run.stoppedAt = new Date().toISOString();
      this.runs?.save();
    }
  }

  /** Whether the space's plan holds this run as its task's live run; undefined when the plan is not loaded. */
  isLive(run: RunRecord): boolean | undefined {
    const plan = this.spaces.get(run.space)?.sync.plan;
    if (!plan) return undefined;
    const task = plan.entities.get(run.task)?.entity;
    return task?.type === "task" && task.run_id === run.run_id && !task.run_ended;
  }

  /**
   * Releases a task back to todo after its start failed before an agent was asked for (I4). The
   * release applies only while the plan still holds this run, so a task released or restarted
   * meanwhile is left as it is; an offline machine keeps it in the journal like any change.
   */
  private releaseFailedStart(run: RunRecord): void {
    const space = this.spaces.get(run.space);
    if (!space) return;
    const op: Operation = { op_id: opaqueId("op"), kind: "release", id: run.task, run_id: run.run_id, to: "todo", at: new Date().toISOString() };
    void space.sync
      .record([op])
      .outcomes.then((outcomes) => {
        const outcome = outcomes.get(op.op_id);
        if (outcome?.status === "refused" || outcome?.status === "dropped") console.error(`dashboard: run ${run.run_id}: the failed start was not released: ${outcome.reason}`);
      })
      .catch((error: unknown) => console.error(`dashboard: run ${run.run_id}: releasing the failed start: ${(error as Error)?.message ?? error}`));
  }

  /** Keeps Paseo's API from a handler or hook; the first one lets unfinished starts continue. */
  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    void this.start()
      .then(() => {
        if (!this.owner) return;
        this.starts?.recover();
        this.tracker.start();
        this.prs.start();
        this.issues.start();
        this.merged.start();
        this.mirror.start();
        this.releases.start();
      })
      .catch(() => undefined);
  }

  /** Git for this machine's checkouts (branch lookups of a start). */
  get git(): GitRunner {
    return this.runner;
  }

  get owner(): boolean {
    return this.lock.isOwner;
  }

  /** Idempotent: the first call takes the lock, opens every space and starts the fetch loop. */
  start(): Promise<void> {
    this.started ??= this.open();
    return this.started;
  }

  private async open(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const lock = this.lock.acquire();
    if (!lock.owner) {
      this.ownerReason = lock.reason;
      return;
    }
    const read = readJsonFile(join(this.dataDir, "spaces.json"), registrySchema, () => ({ version: 1 as const, spaces: [] }));
    this.registry = read.value;
    if (read.movedAside) this.warnings.push(`the list of spaces could not be read and was moved to ${read.movedAside}`);
    // Before the spaces: their first apply of a coordinator's change asks it for the permission.
    this.delegation = new DelegationStore(this.dataDir);
    for (const aside of this.delegation.movedAside) this.warnings.push(`a delegation file could not be read and was moved to ${aside}; check Delegation in Settings`);
    for (const record of this.registry.spaces) {
      try {
        this.openSpace(record);
      } catch (error) {
        this.warnings.push(`space ${record.key} could not be opened: ${(error as Error).message}`);
      }
    }
    this.seen = new SeenStore(join(this.dataDir, "seen.json"));
    this.batches = new BatchStore(this.dataDir);
    if (this.seen.movedAside) this.warnings.push(`the record of seen instructions could not be read and was moved to ${this.seen.movedAside}`);
    this.laconote = new LaconoteStore(this.dataDir);
    for (const aside of this.laconote.movedAside) this.warnings.push(`a Laconote settings file could not be read and was moved to ${aside}`);
    this.releaseStore = new ReleaseStore(this.dataDir);
    if (this.releaseStore.movedAside) this.warnings.push(`the release context's record could not be read and was moved to ${this.releaseStore.movedAside}`);
    this.prefs = new UiPrefsStore(this.dataDir);
    if (this.prefs.movedAside) this.warnings.push(`the display settings could not be read and were moved to ${this.prefs.movedAside}`);
    const godMode = checkGodModeFile(this.dataDir);
    if (godMode) this.warnings.push(`the ChatGPT settings could not be read and were moved to ${godMode}; starting without asking is off`);
    const planTools = checkPlanToolsFile(this.dataDir);
    if (planTools) this.warnings.push(`the plan tools' switch could not be read and was moved to ${planTools}; the plan tools are off`);
    this.mirrorStore = new MirrorStore(this.dataDir);
    if (this.mirrorStore.movedAside) this.warnings.push(`the issue mirror's record could not be read and was moved to ${this.mirrorStore.movedAside}`);
    this.events = new EventStore(join(this.dataDir, "events.json"));
    if (this.events.movedAside) this.warnings.push(`the task events could not be read and were moved to ${this.events.movedAside}`);
    this.runs = new RunStore(join(this.dataDir, "runs.json"));
    // From now on another machine's releases stop this machine's agents; earlier ends are history.
    this.stopsSince();
    this.autopilot = new Autopilot(this, join(this.dataDir, "autopilot.json"));
    this.queue = new ManagedQueue(this, this.dataDir);
    for (const aside of this.queue.store.movedAside) this.warnings.push(`a managed queue file could not be read and was moved to ${aside}; check the managed queue in Settings`);
    if (this.runs.movedAside) this.warnings.push(`the list of runs could not be read and was moved to ${this.runs.movedAside}`);
    this.runs.onActivity = (run, previous) => {
      noteActivity(this, run, previous);
      // An agent that stops working may free one of the autopilot's slots: a queued task need not wait
      // for the next sync. The pass itself decides; it does nothing without flags.
      if ((previous === "working" || previous === "needs_input") && (run.activity === "stopped" || run.activity === "failed" || run.activity === "waiting")) {
        void this.autopilot?.pass(undefined, true).catch((error: unknown) => console.error(`dashboard: autopilot pass failed: ${String(error)}`));
      }
    };
    this.runs.onActivityError = (error) => console.error(`dashboard: task event not recorded: ${(error as Error)?.message ?? error}`);
    this.starts = new Runner({
      store: this.runs,
      paseo: () => this.paseo,
      log: (message) => console.error(`dashboard: ${message}`),
      isLive: (run) => this.isLive(run),
      release: (run) => this.releaseFailedStart(run),
      onAgent: (run) => void this.follower.follow(run),
      ...this.options.starts,
    });
    const bridge = new AgentToolsBridge({
      dataDir: this.dataDir,
      runByToken: (token) => [...(this.runs?.runs.values() ?? [])].find((run) => sameToken(run.token, token)),
      handle: (run, tool, args) => handleTool(this, run, tool, args),
      planByToken: (token) => this.planCallers.find(token),
      handlePlan: (caller, tool, args) => handlePlanTool(this, caller, tool, args, { enabled: () => planToolsOn(this.dataDir) }),
      coordinatorByToken: (token) => this.coordinatorCallers.find(token),
      handleCoordinator: (caller, tool, args) => handleCoordinatorTool(this, caller, tool, args),
      log: (message) => console.error(`dashboard: ${message}`),
    });
    try {
      await bridge.start();
      this.bridge = bridge;
    } catch (error) {
      this.warnings.push(`agent tools are off: ${(error as Error).message}`);
    }
    if (this.paseo) this.starts.recover();
    this.timer = setInterval(() => void this.syncAll(), this.options.fetchIntervalMs ?? 60_000);
    this.timer.unref?.();
    void this.syncAll();
  }

  private openSpace(record: SpaceRecord): void {
    const dir = join(this.dataDir, "spaces", record.key);
    const sync = new SpaceSync({
      root: join(dir, "repo"),
      branch: record.branch,
      journalPath: join(dir, "journal.json"),
      runner: this.runner,
      timeouts: this.options.timeouts,
      onClaimDecided: (_task, runId, won) => this.starts?.claimDecided(runId, won),
      authorize: (op) => (this.delegation ? this.delegation.objection(record.key, op) : "delegation is not available"),
      onDelegated: (op, outcome) => {
        // A record that cannot be saved never stops the plan's sync.
        try {
          this.delegation?.settle(op, outcome);
        } catch (error) {
          console.error(`dashboard: delegation record not updated: ${(error as Error)?.message ?? error}`);
        }
      },
    });
    this.spaces.set(record.key, { record, sync });
  }

  private saveRegistry(): void {
    writeJsonFile(join(this.dataDir, "spaces.json"), this.registry);
  }

  /** One pass of the fetch loop; overlapping ticks are skipped, and one space's failure stays its own. */
  async syncAll(): Promise<void> {
    if (this.syncing || !this.owner) return;
    this.syncing = true;
    try {
      for (const { sync } of this.spaces.values()) {
        await sync.sync().catch((error: unknown) => {
          sync.state.error = String((error as Error).message);
        });
      }
      // With the plans fresh: what the autopilot may start now (server/autopilot.ts).
      await this.autopilot?.pass().catch((error: unknown) => console.error(`dashboard: autopilot pass failed: ${String(error)}`));
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Connects a plan repository. An empty repository, or one that holds only the files a forge
   * creates with a new repository (README, LICENSE, .gitignore), becomes a space when a key and
   * name are given: the plugin writes `space.yaml` and pushes it to the default branch (D13).
   */
  async addSpace(input: { remote: string; key?: string; name?: string }): Promise<{ key: string }> {
    await this.start();
    if (!this.owner) throw new Error(this.ownerReason);
    const staging = join(this.dataDir, "spaces", `.adding-${opaqueId("s")}`);
    mkdirSync(join(this.dataDir, "spaces"), { recursive: true });
    try {
      await git(this.runner, join(this.dataDir, "spaces"), ["clone", "--quiet", "--", input.remote, staging], NETWORK_MS);
      const head = await this.runner.run(staging, ["rev-parse", "--verify", "HEAD"], 10_000);
      const empty = head.code !== 0;
      // `branch --show-current` gives the full branch name, never one shortened to `heads/<name>`.
      const branch = empty ? "main" : (await git(this.runner, staging, ["branch", "--show-current"], 10_000)).trim();
      // The branch name comes from the remote and later goes into fetch and push refspecs; it is
      // checked before anything is written or pushed.
      const valid = await this.runner.run(staging, ["check-ref-format", "--branch", branch], 10_000);
      if (valid.code !== 0 || !SAFE_BRANCH.test(branch)) {
        throw new Error(`the plan repository's default branch ${JSON.stringify(branch)} is not a usable branch name`);
      }
      if (empty) {
        await this.initialize(staging, input, branch, true);
      } else if (!existsSync(join(staging, "space.yaml"))) {
        await this.refuseUnlessForgeFiles(staging);
        await this.initialize(staging, input, branch, false);
      }
      const plan = loadPlan(staging);
      if (!plan.space) throw new Error(plan.problems.find((p) => p.path === "space.yaml")?.reason ?? "not a plan repository");
      const key = plan.space.key;
      if (this.spaces.has(key)) throw new Error(`space ${key} is already connected`);
      if (this.disconnecting.has(key)) throw new Error(`space ${key} is being disconnected; connect it again once that is over`);
      // A directory left from an earlier connection keeps its journal: its operations replay on top
      // of the new clone (I1). Only the clone is replaced.
      const dir = join(this.dataDir, "spaces", key);
      mkdirSync(dir, { recursive: true });
      rmSync(join(dir, "repo"), { recursive: true, force: true });
      renameSync(staging, join(dir, "repo"));
      const record: SpaceRecord = { key, name: plan.space.name, remote: input.remote, branch, added: new Date().toISOString(), mapping: {}, overrides: {} };
      // A record that could not be opened earlier is replaced, not duplicated.
      this.registry.spaces = [...this.registry.spaces.filter((r) => r.key !== key), record];
      this.saveRegistry();
      this.openSpace(record);
      return { key };
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Disconnects a space from this machine (05-architecture.md, Disconnecting a space): the plan
   * repository and its remote are not touched; this machine's clone and journal of the space, and its
   * finished run records, are deleted. Refused, with the reason, while anything of the space is not on
   * origin yet or a run of this machine (`host`) still holds or is starting one of its tasks.
   */
  async removeSpace(asked: string, host: string): Promise<{ key: string }> {
    await this.start();
    if (!this.owner) throw new Error(this.ownerReason);
    const key = asked.trim().toUpperCase();
    if (this.disconnecting.has(key)) throw new Error(`space ${key} is being disconnected already`);
    const entry = this.spaces.get(key);
    if (!entry) throw new Error(`no space ${key} is connected`);
    const objection = this.disconnectObjection(entry, host);
    if (objection) throw new Error(objection);
    // First no new call can resolve the space; a call that already did and writes now is either in
    // the queue before the check below (and makes it refuse) or refused by the closed space.
    this.disconnecting.add(key);
    this.spaces.delete(key);
    try {
      const late = await entry.sync.closeUnless(() => this.disconnectObjection(entry, host)).catch((error: unknown) => String((error as Error)?.message ?? error));
      if (late) {
        this.restoreSpace(entry);
        throw new Error(late);
      }
      this.registry.spaces = this.registry.spaces.filter((r) => r.key !== key);
      this.saveRegistry();
      try {
        this.delegation?.forgetSpace(key);
      } catch (error) {
        this.warnings.push(`space ${key} was disconnected, but its delegated permissions are removed only until the plugin restarts, since saving failed: ${(error as Error).message}`);
      }
      try {
        this.queue?.store.forgetSpace(key);
      } catch (error) {
        this.warnings.push(`space ${key} was disconnected, but its managed queue is removed only until the plugin restarts, since saving failed: ${(error as Error).message}`);
      }
      // Its Laconote projects are free for another space, and a reconnect starts unmapped.
      try {
        this.releaseStore?.forgetSpace(key);
      } catch (error) {
        this.warnings.push(`space ${key} was disconnected, but its release context mapping could not be removed: ${(error as Error).message}`);
      }
      // Only finished runs are left (the check refused any other); their records go with the space.
      const runs = this.runs;
      const gone = [...(runs?.runs.values() ?? [])].filter((run) => run.space === key);
      for (const run of gone) runs?.runs.delete(run.run_id);
      if (gone.length) runs?.save();
      const dir = join(this.dataDir, "spaces", key);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        this.warnings.push(`space ${key} was disconnected, but ${dir} could not be deleted: ${(error as Error).message}`);
      }
      return { key };
    } finally {
      this.disconnecting.delete(key);
    }
  }

  /** Puts a space whose disconnect was refused back in its place in the list. */
  private restoreSpace(entry: { record: SpaceRecord; sync: SpaceSync }): void {
    const order = this.registry.spaces.map((r) => r.key);
    const all = [...this.spaces.entries(), [entry.record.key, entry] as const].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    this.spaces.clear();
    for (const [key, value] of all) this.spaces.set(key, value);
  }

  /**
   * Why a space cannot be disconnected now, with what to do; undefined when nothing is in the way.
   * In the way: journal entries not on origin yet (pending operations, claims in flight or undecided;
   * I1, I5), live runs of this machine (I3, I4), and run records with an unfinished start or an
   * undecided claim, which `Runner.recover()` would drive at the next start. Abandoned claims are not
   * in the way: they leave the journal only if they show up on origin, so most never do.
   */
  private disconnectObjection({ record, sync }: { record: SpaceRecord; sync: SpaceSync }, host: string): string | undefined {
    const reasons: string[] = [];
    const name = (id: string) => {
      const entity = sync.plan.entities.get(id)?.entity;
      return entity ? `${id} «${entity.title}»` : id;
    };
    // While the last sync failed, nothing pending can be pushed. An undecided claim is decided only by
    // a fetch that read origin (I5), so it is stuck only when the fetch failed, not just the push.
    const error = sync.state.error;
    const blocked = error
      ? `${error.startsWith("push declined") ? `the plan repository ${record.remote} refused the push` : `the plan repository ${record.remote} could not be reached`} (${error}); restore access to it and sync before disconnecting`
      : undefined;
    const undecided = (task: string) =>
      blocked && !error!.startsWith("push ")
        ? `whether the start of ${name(task)} landed cannot be decided: ${blocked}`
        : `whether the start of ${name(task)} landed is not decided yet; wait for the next syncs to decide it`;
    const entries = sync.journalEntries;
    const pending = entries.filter((entry) => entry.op.kind !== "claim").map((entry) => entry.op);
    if (pending.length) {
      const listed = pending.slice(0, 5).map(describeOp).join(", ");
      const what = `${pending.length} change${pending.length === 1 ? "" : "s"} (${listed}${pending.length > 5 ? `, and ${pending.length - 5} more` : ""})`;
      reasons.push(
        blocked
          ? `${what} cannot be pushed: ${blocked}`
          : `${what} ${pending.length === 1 ? "is" : "are"} not on the plan repository yet; sync now and disconnect once ${pending.length === 1 ? "it is" : "they are"} pushed`,
      );
    }
    // One reason per task: a start shows in the journal, in the run records and in the plan.
    const tasks = new Map<string, string>();
    const add = (task: string, reason: string) => {
      if (!tasks.has(task)) tasks.set(task, reason);
    };
    for (const { op, inflight } of entries) {
      if (op.kind !== "claim") continue;
      add(op.id, inflight ? `the start of ${name(op.id)} is being claimed right now; wait for it to finish` : undecided(op.id));
    }
    for (const run of this.runs?.runs.values() ?? []) {
      if (run.space !== record.key) continue;
      const last = run.attempts.at(-1);
      const task = sync.plan.entities.get(run.task)?.entity;
      if (run.claim === "undecided") add(run.task, undecided(run.task));
      else if (last && last.state !== "done" && last.state !== "failed") add(run.task, `the start of ${name(run.task)} is still creating its workspace or agent; wait until it is done or failed`);
      else if (task?.type === "task" && task.run_id === run.run_id && !task.run_ended) add(run.task, `${name(run.task)} has a live run on this machine; release it or let it finish first`);
    }
    for (const { entity } of sync.plan.entities.values()) {
      if (entity.type === "task" && hasLiveRun(entity) && entity.run_host === host) add(entity.id, `${name(entity.id)} has a live run on this machine; release it or let it finish first`);
    }
    reasons.push(...tasks.values());
    return reasons.length ? `${record.name} (${record.key}) was not disconnected: ${reasons.join("; ")}.` : undefined;
  }

  /**
   * Refuses a repository without `space.yaml` unless every entry at its root is a regular file that
   * a forge creates with a new repository. A directory, symlink or submodule counts as other
   * content, so the `.gitignore` append below never writes outside the clone. Only the root is
   * listed: any directory there is already a refusal, and a big repository stays a short listing.
   */
  private async refuseUnlessForgeFiles(root: string): Promise<void> {
    const listing = await git(this.runner, root, ["ls-tree", "-z", "HEAD"], 10_000);
    const other: string[] = [];
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const mode = entry.slice(0, entry.indexOf(" "));
      const path = entry.slice(tab + 1);
      const regular = mode === "100644" || mode === "100755";
      if (!regular || !(FORGE_FILE.test(path) || path === ".gitignore")) other.push(path);
    }
    if (other.length === 0) return;
    const shown = other.slice(0, 3).map((path) => JSON.stringify(path)).join(", ");
    const more = other.length > 3 ? ` and ${other.length - 3} more` : "";
    throw new Error(
      `this is not a plan repository: it has no space.yaml and holds ${shown}${more}; a new space can be made only from an empty repository or one with nothing but a README, LICENSE or .gitignore`,
    );
  }

  /**
   * Writes a new space into the clone and pushes it to `branch`. An empty repository gets its first
   * commit on a new branch; otherwise the space goes on top of the existing commit, the files
   * already there stay, and the plugin's line is appended to an existing `.gitignore`.
   */
  private async initialize(root: string, input: { key?: string; name?: string }, branch: string, empty: boolean): Promise<void> {
    const key = input.key?.trim().toUpperCase() ?? "";
    const name = input.name?.trim() ?? "";
    if (!SPACE_KEY_PATTERN.test(key) || !name) {
      const what = empty ? "the repository is empty" : "the repository holds only a README, LICENSE or .gitignore";
      throw new Error(`${what}: give a key (2-6 capital letters) and a name to make it a space`);
    }
    // Checked before the push, so a key already in use never lands in another repository.
    if (this.spaces.has(key)) throw new Error(`space ${key} is already connected`);
    if (this.disconnecting.has(key)) throw new Error(`space ${key} is being disconnected; connect it again once that is over`);
    writeFileSync(
      join(root, "space.yaml"),
      `schema: paseo-dashboard/1\nkey: ${key}\nname: ${JSON.stringify(name)}\nprojects: {}\ndefaults:\n  priority: medium\n`,
    );
    const ignore = join(root, ".gitignore");
    const current = existsSync(ignore) ? readFileSync(ignore) : Buffer.alloc(0);
    if (!current.toString("utf8").split(/\r?\n/).includes(IGNORE_LINE)) {
      const separator = current.length > 0 && current[current.length - 1] !== 0x0a ? "\n" : "";
      appendFileSync(ignore, `${separator}${IGNORE_LINE}\n`);
    }
    mkdirSync(join(root, "views"), { recursive: true });
    for (const [path, text] of Object.entries(VIEW_FILES)) writeFileSync(join(root, path), text);
    if (empty) await git(this.runner, root, ["checkout", "--quiet", "-b", branch], 10_000);
    // Only the plugin's own paths, forced: the repository's `.gitignore` or the user's global
    // excludes could otherwise keep `space.yaml` out of the commit while the push still succeeds.
    await git(this.runner, root, ["add", "--force", "--", "space.yaml", ".gitignore", ...Object.keys(VIEW_FILES)], 10_000);
    await git(this.runner, root, [...COMMIT_CONFIG, "commit", "--quiet", "-m", `dashboard: create space ${key}`], 10_000);
    await git(this.runner, root, ["push", "--quiet", "-u", "origin", `HEAD:${branch}`], NETWORK_MS);
  }

  /** Each mapped Paseo project's checkout on this machine (runtime only, refreshed with the mapping). */
  readonly projectRoots = new Map<string, string>();

  /** Learns where this machine's Paseo projects are checked out, without touching the mapping. */
  addProjectRoots(local: LocalProject[]): void {
    for (const project of local) if (project.rootPath) this.projectRoots.set(project.projectId, project.rootPath);
  }

  /** This machine's Paseo projects as last read; the mapping is recomputed from them. */
  private local: LocalProject[] | undefined;

  /**
   * Stores which local Paseo project each project key of each space maps to. Without a list it
   * reuses the last one read; before any was read it leaves the stored mapping alone, so a fresh
   * process never maps every project to nothing.
   */
  updateMapping(given?: LocalProject[]): void {
    const local = given ?? this.local;
    if (!local) return;
    this.local = local;
    this.addProjectRoots(local);
    for (const { record, sync } of this.spaces.values()) {
      record.mapping = mapProjects(sync.plan.space?.projects ?? {}, local, record.overrides);
    }
    this.saveRegistry();
  }

  /** The Paseo project on this machine whose origin is this remote, as last read. */
  localProjectByRemote(remote: string): LocalProject | undefined {
    const wanted = normalizeRemote(remote);
    return this.local?.find((project) => project.remote && normalizeRemote(project.remote) === wanted);
  }

  /** Maps a project key of a space to a Paseo project by hand, or back to matching by remote. */
  setOverride(space: string, project: string, localProject: string | undefined): void {
    const entry = this.spaces.get(space);
    if (!entry) throw new Error(`no space ${space}`);
    if (localProject) entry.record.overrides[project] = localProject;
    else delete entry.record.overrides[project];
    this.updateMapping();
    this.saveRegistry();
  }

  /**
   * After a turn of a run's agent ended: its PR/MR, the files it touched and what it waits on are read
   * again. A turn that ended while a sub-agent works is no news for the user: its event is kept read.
   */
  async turnEnded(run: RunRecord): Promise<void> {
    this.checkPrs(run);
    void this.follower.turnEnded(run.run_id);
    await this.waits.probe(run, true);
    if (run.activity === "waiting" && subAgentsAtWork(this, run)) this.events?.quiet(run.run_id, run.activityAt);
  }

  /** The checks of a run's own open PR/MR as the forge has them now; undefined without one or an answer. */
  private async ownChecks(run: RunRecord): Promise<string | undefined> {
    const seen = this.prs.seen.get(run.task);
    if (!seen || seen.run_id !== run.run_id || (seen.state !== "open" && seen.state !== "draft")) return undefined;
    const project = this.spaces.get(run.space)?.sync.plan.space?.projects[run.project];
    const root = this.projectRoots.get(run.projectId);
    if (!project || !root) return undefined;
    const forge = this.forge;
    const details = await prDetails(root, project.remote, seen.url, (command, args, cwd, timeoutMs) => forge.exec(command as "gh" | "glab", args, cwd, timeoutMs));
    return details.checks?.state;
  }

  stop(): void {
    this.tracker.stop();
    this.follower.stop();
    this.prs.stop();
    this.issues.stop();
    this.merged.stop();
    this.webHosts.stop();
    this.mirror.stop();
    this.releases.stop();
    this.bridge?.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lock.release();
  }
}
