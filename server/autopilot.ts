import { z } from "zod";
import { hasLiveRun, type Task } from "../shared/model.ts";
import { MAX_RUNNING_CAP } from "../shared/ui.ts";
import type { Dashboard } from "./dashboard.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";
import { planStart } from "./api/reads.ts";
import { humanWork, humanWorkOf, isHumanWorkRefusal, sortTasks, taskSection } from "./api/view.ts";
import { startTask, type WriteContext } from "./api/writes.ts";
import { flat, type RunActivity, runActivity } from "./needs.ts";
import type { RunRecord } from "./runner/runs.ts";
import { backoffMs, isRateLimit, readUsage, resetFrom } from "./rate-limit.ts";

/**
 * The cautious autopilot (D24): a person lets this Mac start one task as soon as it is ready, or the
 * tasks of one project (line) one after another. There is no autopilot for everything; "Start next"
 * is a button. The flags are this machine's (plugin-data/dashboard/autopilot.json), never the plan's,
 * so a collaborator's machine never starts work on its own tokens.
 *
 * A pass runs after each sync of the plans and starts at most one task:
 * - only what an ordinary start would start (todo, nothing it waits for, its project mapped here,
 *   no live run), in the order of every task list (sortTasks);
 * - never a task its labels mark as a person's work (the space's `defaults.human_labels`);
 * - a project's next task only while no run of that project is live, on any machine;
 * - only while fewer than `max_running` runs of this machine take a place (holdsPlace): an agent at
 *   work or a start under way does; an agent Paseo reports gone (`stopped`), a failed one and a task in
 *   review whose agent waits for the person's acceptance do not (JOBBY-AH5Z0, 2026-11-15);
 * - no start while a provider's usage limit holds (server/rate-limit.ts): after an agent's turn fails
 *   on it, until its reset, or a bounded backoff when nothing says when that is;
 * - only instructions the person has seen as they are now: a brief someone else changed since waits
 *   until it is opened once, so another person's text never runs with this person's rights unseen;
 * - a start that fails, an agent it started that fails (other than on a usage limit), or a person's
 *   release of a run it started pauses the flag with the reason.
 * A task's flag is spent by its start; a project's stays.
 *
 * A new task created ready gets a task flag (server/auto-start.ts, JOBBY-H3ZEX); this file also keeps
 * this Mac's start defaults (`start`), which every start reads.
 *
 * A set of tasks the user confirmed through ChatGPT (start_tasks, 06-god-mode.md) leaves what cannot
 * start at once here as task flags, in starting order. Such a flag keeps the hashes of the
 * instructions the read-back covered: those count as seen for it, and a change after the yes waits
 * until the task is opened once, as any other unseen text does.
 */

const flagSchema = z.object({ space: z.string(), paused: z.string().optional() });
const fileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(
    flagSchema.extend({
      task: z.string(),
      /** The instruction hashes a read-back through ChatGPT covered; a start of this flag records none of them as seen. */
      accepted: z.array(z.string()).optional(),
    }),
  ),
  projects: z.array(flagSchema.extend({ project: z.string() })),
  max_running: z.number().int().min(1).max(MAX_RUNNING_CAP),
  /** Runs this autopilot started, for pausing a project whose agent then fails. */
  started: z.array(
    z.object({
      run_id: z.string(),
      space: z.string(),
      task: z.string(),
      title: z.string(),
      project: z.string(),
      at: z.string(),
      /** Its failure or release already paused the project (or found it off). */
      settled: z.boolean().optional(),
    }),
  ),
  /** A usage limit an agent's turn met: no start until `until` (server/rate-limit.ts). */
  limit: z
    .object({
      /** No start before this (ISO). */
      until: z.string(),
      /** The failed turn's time: the same failure is counted once. */
      at: z.string(),
      task: z.string(),
      run_id: z.string(),
      /** Where `until` comes from, as a person reads it. */
      source: z.string(),
      /** Holds in a row that met the limit: the backoff grows with them. */
      strikes: z.number().int().min(1),
      /** The hold is over and the usage report, read once after it, did not extend it. */
      checked: z.boolean().optional(),
    })
    .optional(),
  /** The latest usage-limit failure counted, kept after a hold is cleared: no failure is counted twice. */
  limit_seen: z.string().optional(),
  /**
   * How tasks start on this Mac (JOBBY-H3ZEX): whether a new task created ready asks the autopilot to
   * start it, and the mode and effort every start passes when nothing more specific names one.
   */
  start: z
    .object({
      new_tasks: z.boolean(),
      mode: z.string(),
      /** Mode ids mean different things per provider (Codex's `auto` is its "Default Permissions"): the mode is this provider's only. */
      mode_provider: z.string(),
      effort: z.string(),
      /** Claude's model and effort picked per task (server/runner/model-policy.ts); absent in files written before it: on. */
      auto_model: z.boolean().optional(),
    })
    .optional(),
});
export type AutopilotFile = z.output<typeof fileSchema>;

export const DEFAULT_MAX_RUNNING = 3;
/**
 * This Mac's start defaults until a person changes them: a new ready task starts at once, in Claude's
 * "Auto mode" with effort "High". A provider or model without that id falls through, saying so
 * (server/runner/profiles.ts).
 */
export const DEFAULT_START = { new_tasks: true, mode: "auto", mode_provider: "claude", effort: "high", auto_model: true } as const;
export type StartDefaults = { new_tasks: boolean; mode: string; mode_provider: string; effort: string; auto_model: boolean };
/**
 * A flag no finished pass has checked: Paseo Dash just woke up (daemon or plugin restart) and has not
 * synced the plans yet, or the flag was set after the last pass.
 */
export const NOT_CHECKED = "not checked yet: the autopilot checks after the next sync of the plans";
/** A flag the last pass did not reach: it stopped at an earlier flag, as a pass acts on one task at most. */
export const NOT_REACHED = "waits: the autopilot acts on one task per check; this one comes at a later check";
const KEEP_STARTED = 20;
/** A limit met again this soon after the last hold ended is the same limit still there: the next hold is longer. */
const STRIKES_FOR_MS = 6 * 3_600_000;

/** The provider of the run's agent, as `agents.create` was asked for it (`claude/claude-opus-5-5`: claude). */
function providerOf(run: RunRecord | undefined): string {
  const asked = (run?.attempts.at(-1)?.agentRequest.config as { provider?: unknown } | undefined)?.provider;
  return (typeof asked === "string" ? asked : "claude").split("/")[0]!;
}

/** A live run of this Mac, with what its agent does as `overview.running` says it, and whether `running` counts it. */
export interface CountedRun {
  space: string;
  task: string;
  title: string;
  status: string;
  activity: RunActivity;
  holds_place: boolean;
}

/**
 * Whether a live run of this Mac takes one of the autopilot's places: its agent works, asks for a
 * permission mid-turn or is being started, or it waits for a reply while the task is in progress
 * (the conversation goes on). Not an agent Paseo reports gone (closed, archived, or no longer known
 * to it: `stopped`), nor a failed one, nor one waiting while its task is in review: those run nothing
 * until a person acts, and their need says what to do. A state Paseo has not confirmed yet after a
 * restart or a reconnect is the one last recorded until the tracker reads the agent again, so an
 * agent recorded at work keeps its place until then.
 */
export function holdsPlace(run: Pick<RunRecord, "activity">, task: Pick<Task, "status">): boolean {
  switch (run.activity) {
    case "launching":
    case "working":
    case "needs_input":
      return true;
    case "waiting":
      return task.status === "in_progress";
    default:
      return false;
  }
}

/** A task flag the autopilot has nothing left to do for: it finished, was canceled, or is held or in review. */
function spent(task: Task): boolean {
  return task.status === "done" || task.status === "canceled" || task.status === "review" || task.status === "in_progress" || hasLiveRun(task);
}

export interface AutopilotFlag {
  space: string;
  task?: string;
  project?: string;
  title: string;
  /** What it waits for or why it is paused, as a person reads it; "" when nothing held it back at the last pass. */
  state: string;
  paused: boolean;
}

export class Autopilot {
  private file: AutopilotFile;
  private current: Promise<void> | undefined;
  /** A change asked for a pass while one was under way, which read the flags and the limit before it: one more follows. */
  private again = false;
  /** Per flag: why it did not start, gathered by the pass under way; "" for the flag that started a task. */
  private readonly waits = new Map<string, string>();
  /**
   * The last finished pass's `waits`: a read during a pass never sees it half filled. Every flag that
   * pass reached has an entry, so a flag without one was not checked.
   */
  private shown = new Map<string, string>();

  private readonly dashboard: Dashboard;
  private readonly path: string;
  /** The clock of the usage-limit hold; a test sets its own. */
  now: () => Date = () => new Date();

  constructor(dashboard: Dashboard, path: string) {
    this.dashboard = dashboard;
    this.path = path;
    this.file = readJsonFile(path, fileSchema, () => ({ version: 1 as const, tasks: [], projects: [], max_running: DEFAULT_MAX_RUNNING, started: [] })).value;
  }

  private save(): void {
    writeJsonFile(this.path, this.file);
  }

  set(input: { space: string; task?: string; project?: string; on: boolean; max_running?: number }): void {
    const space = input.space.trim().toUpperCase();
    if (input.task) {
      this.file.tasks = this.file.tasks.filter((f) => !(f.space === space && f.task === input.task));
      if (input.on) this.file.tasks.push({ space, task: input.task });
    }
    if (input.project) {
      this.file.projects = this.file.projects.filter((f) => !(f.space === space && f.project === input.project));
      if (input.on) this.file.projects.push({ space, project: input.project });
    }
    if (input.max_running) this.file.max_running = input.max_running;
    this.save();
  }

  /** This Mac's start defaults (DEFAULT_START until a person changes them). */
  startDefaults(): StartDefaults {
    return { ...DEFAULT_START, ...this.file.start };
  }

  /** Changes the start defaults given; the rest stay. They count for starts from now on. */
  setStartDefaults(input: Partial<StartDefaults>): void {
    const next = { ...this.startDefaults() };
    if (input.new_tasks !== undefined) next.new_tasks = input.new_tasks;
    if (input.mode && input.mode_provider) {
      next.mode = input.mode;
      next.mode_provider = input.mode_provider;
    }
    if (input.effort) next.effort = input.effort;
    if (input.auto_model !== undefined) next.auto_model = input.auto_model;
    this.file.start = next;
    this.save();
  }

  /**
   * Flags the tasks of a set the user confirmed, in the order given, each with the instructions the
   * confirmation covered. A task already flagged keeps its place; its accepted instructions are replaced.
   */
  queue(space: string, tasks: { task: string; accepted: string[] }[]): void {
    const key = space.trim().toUpperCase();
    for (const { task, accepted } of tasks) {
      const flag = this.file.tasks.find((f) => f.space === key && f.task === task);
      if (flag) flag.accepted = accepted;
      else this.file.tasks.push({ space: key, task, accepted });
    }
    this.save();
  }

  /** Why the task's flag on this Mac is paused; undefined when it has none or it is not paused. */
  pausedFlag(space: string, task: string): string | undefined {
    return this.file.tasks.find((f) => f.space === space.trim().toUpperCase() && f.task === task)?.paused;
  }

  /**
   * This machine's live runs, each with whether it takes a place under `max_running` (holdsPlace). A
   * claim of this Mac still being pushed has no run record yet and takes one as `launching`. A run
   * that takes none still holds its task until a person releases it; overview's needs_you says how.
   */
  private live(): CountedRun[] {
    const live: CountedRun[] = [];
    const known = new Set<string>();
    for (const run of this.dashboard.runs?.runs.values() ?? []) {
      known.add(run.run_id);
      if (run.claim !== "won" || this.dashboard.isLive(run) !== true) continue;
      const task = this.task(run.space, run.task);
      if (task) live.push({ space: run.space, task: task.id, title: task.title, status: task.status, activity: runActivity(this.dashboard, task), holds_place: holdsPlace(run, task) });
    }
    for (const [space, { sync }] of this.dashboard.spaces) {
      for (const { op } of sync.journalEntries) {
        if (op.kind !== "claim" || known.has(op.run.run_id)) continue;
        const task = this.task(space, op.id);
        if (task?.run_id === op.run.run_id && !task.run_ended) live.push({ space, task: task.id, title: task.title, status: task.status, activity: "launching", holds_place: true });
      }
    }
    return live;
  }

  read(): { flags: AutopilotFlag[]; max_running: number; running: number; runs: CountedRun[]; started: AutopilotFile["started"]; limit: { until: string; source: string } } {
    const flags: AutopilotFlag[] = [
      // A flag whose task finished or started some other way waits for nothing; the next pass drops it.
      ...this.file.tasks.flatMap((f) => {
        const task = this.task(f.space, f.task);
        if (task && spent(task)) return [];
        return [{ space: f.space, task: f.task, title: task?.title ?? f.task, state: f.paused ?? this.shown.get(`t:${f.space}:${f.task}`) ?? NOT_CHECKED, paused: Boolean(f.paused) }];
      }),
      ...this.file.projects.map((f) => ({ space: f.space, project: f.project, title: f.project, state: f.paused ?? this.shown.get(`p:${f.space}:${f.project}`) ?? NOT_CHECKED, paused: Boolean(f.paused) })),
    ];
    const runs = this.live();
    const limit = this.file.limit && Date.parse(this.file.limit.until) > this.now().getTime() ? { until: this.file.limit.until, source: this.file.limit.source } : { until: "", source: "" };
    return { flags, max_running: this.file.max_running, running: runs.filter((r) => r.holds_place).length, runs, started: [...this.file.started].reverse(), limit };
  }

  /** Clears a pause: the next pass may start again. */
  resume(space: string, key: { task?: string; project?: string }): void {
    for (const f of this.file.tasks) if (f.space === space && f.task === key.task) delete f.paused;
    for (const f of this.file.projects) if (f.space === space && f.project === key.project) delete f.paused;
    this.save();
  }

  private task(space: string, id: string): Task | undefined {
    const entity = this.dashboard.spaces.get(space)?.sync.plan.entities.get(id)?.entity;
    return entity?.type === "task" ? entity : undefined;
  }

  /**
   * One pass: pauses what failed, then starts at most one task. A pass asked for meanwhile is that one;
   * with `again` (a person changed a flag or the limit), one more pass follows it, so the change acts
   * now rather than after the next sync.
   */
  pass(ctx: WriteContext = { dashboard: this.dashboard }, again = false): Promise<void> {
    if (this.current) {
      if (again) this.again = true;
      return this.current;
    }
    if (!this.dashboard.owner || !this.dashboard.paseo) return Promise.resolve();
    if (!this.file.tasks.length && !this.file.projects.length) return Promise.resolve();
    this.current = this.run(ctx).finally(() => {
      this.current = undefined;
      if (!this.again) return;
      this.again = false;
      void this.pass(ctx).catch(() => undefined);
    });
    return this.current;
  }

  /**
   * A pass that reads the flags as they are now, awaited: a pass under way read them before, so the
   * one it is followed by (`again`) is awaited too.
   */
  async passNow(ctx: WriteContext = { dashboard: this.dashboard }): Promise<void> {
    const under = this.current;
    await this.pass(ctx, true);
    if (under && this.current) await this.current;
  }

  /** A pass that throws publishes nothing: the last finished pass's states stay. */
  private async run(ctx: WriteContext): Promise<void> {
    const stopped = await this.check(ctx);
    if (stopped) for (const key of this.flagKeys()) if (!this.waits.has(key)) this.waits.set(key, NOT_REACHED);
    this.shown = new Map(this.waits);
  }

  private flagKeys(): string[] {
    return [...this.file.tasks.map((f) => `t:${f.space}:${f.task}`), ...this.file.projects.map((f) => `p:${f.space}:${f.project}`)];
  }

  /**
   * Checks the flags in order and gives each one it reaches a state (a paused one keeps its pause).
   * True when it stopped at a flag it acted on (a start, a failed start, a flag turned off meanwhile)
   * before reaching the rest.
   */
  private async check(ctx: WriteContext): Promise<boolean> {
    this.pauseFailed();
    this.waits.clear();
    // Started or finished some other way, paused or not: such a flag has nothing left to do, also
    // while the limit is full.
    const left = this.file.tasks.filter((f) => {
      const task = this.task(f.space, f.task);
      return !task || !spent(task);
    });
    if (left.length !== this.file.tasks.length) {
      this.file.tasks = left;
      this.save();
    }
    const limited = await this.limitHold();
    const all = (text: string) => {
      for (const f of this.file.tasks) if (!f.paused) this.waits.set(`t:${f.space}:${f.task}`, text);
      for (const f of this.file.projects) if (!f.paused) this.waits.set(`p:${f.space}:${f.project}`, text);
    };
    if (limited) {
      all(limited);
      return false;
    }
    const at = this.live().filter((r) => r.holds_place);
    if (at.length >= this.file.max_running) {
      all(`waits: ${at.length} runs of this Mac are at work (the autopilot's limit is ${this.file.max_running}): ${at.map((r) => r.task).join(", ")}`);
      return false;
    }
    for (const flag of [...this.file.tasks]) {
      const task = this.task(flag.space, flag.task);
      const key = `t:${flag.space}:${flag.task}`;
      if (flag.paused) continue;
      if (!task) {
        this.waits.set(key, "waits: the task is not in the plan");
        continue;
      }
      if (await this.tryStart(ctx, flag.space, task, key, "task", flag.accepted)) return true;
    }
    for (const flag of [...this.file.projects]) {
      if (flag.paused) continue;
      const key = `p:${flag.space}:${flag.project}`;
      const plan = this.dashboard.spaces.get(flag.space)?.sync.plan;
      if (!plan) {
        this.waits.set(key, `waits: space ${flag.space} is not open on this Mac`);
        continue;
      }
      const tasks = [...plan.entities.values()].map((l) => l.entity).filter((e): e is Task => e.type === "task" && e.project === flag.project);
      const busy = tasks.find(hasLiveRun);
      if (busy) {
        const idle = busy.status === "in_progress" && runActivity(this.dashboard, busy) === "stopped";
        this.waits.set(key, idle ? `waits: ${busy.id} «${busy.title}» holds this project with no agent at work: release it (to done when finished) to go on` : `waits: ${busy.id} «${busy.title}» runs in this project`);
        continue;
      }
      const ready = sortTasks(tasks.map((task) => ({ plan, task }))).map(({ task }) => task).filter((t) => taskSection(plan, t) === "ready");
      if (!ready.length) {
        this.waits.set(key, "waits: no task of this project is ready");
        continue;
      }
      const people = ready.filter((t) => humanWork(plan, t));
      const passed = people.length ? humanWorkOf(people.map((task) => ({ plan, task }))) : "";
      for (const task of ready.filter((t) => !people.includes(t))) {
        if (!(await this.tryStart(ctx, flag.space, task, key, "project"))) continue;
        if (passed && this.waits.get(key) === "") this.waits.set(key, `started ${task.id}; passed over ${passed}`);
        return true;
      }
      if (passed) this.waits.set(key, people.length === ready.length ? `waits: only a person's work is ready: ${passed}` : `${this.waits.get(key)}; passed over ${passed}`);
    }
    return false;
  }

  /**
   * The wait text while a usage limit holds every start, else "". A turn of this Mac's agents that
   * failed on a limit after the last one counted starts a hold, counted from the failure: until the
   * reset its error names, else the one Paseo's usage report gives for the agent's provider, else a
   * backoff that grows with each hold in a row (a failure long before now holds no more). Once a
   * hold is over, the usage report (where Paseo has it on) is read once and may extend it; else the
   * next start tries, and a start that meets the limit again holds longer. An agent that finished a
   * turn after the hold ended shows the limit gone: the backoff starts over.
   */
  private async limitHold(): Promise<string> {
    const now = this.now();
    let limit = this.file.limit;
    let hit: RunRecord | undefined;
    for (const run of this.dashboard.runs?.runs.values() ?? []) {
      if (run.activity !== "failed" || !isRateLimit(run.error) || run.activityAt <= (this.file.limit_seen ?? limit?.at ?? "")) continue;
      if (!hit || run.activityAt > hit.activityAt) hit = run;
    }
    if (hit) {
      const at = new Date(hit.activityAt);
      // Another agent meeting the limit during a hold is the same hold; one after it ended, soon, a strike more.
      const during = limit !== undefined && at.getTime() < Date.parse(limit.until);
      const strikes = !limit ? 1 : during ? limit.strikes : at.getTime() - Date.parse(limit.until) < STRIKES_FOR_MS ? limit.strikes + 1 : 1;
      const named = resetFrom(hit.error, at);
      const usage = named ? undefined : await readUsage(this.dashboard.paseo, providerOf(hit), now);
      const why = `the agent of ${hit.task} met a usage limit: ${flat(hit.error ?? "")}`;
      const [until, source] = named
        ? [named, `${why}; it resets then, as the error says`]
        : usage && "resetsAt" in usage
          ? [usage.resetsAt, `${why}; Paseo's usage report says ${usage.window} resets then`]
          : [
              new Date(at.getTime() + backoffMs(strikes)),
              `${why}; no reset time known (Paseo's usage report: ${usage && "unavailable" in usage ? usage.unavailable : "nothing used up"}), so ${backoffMs(strikes) / 60_000} min after it, longer each time a start meets the limit again`,
            ];
      limit = during && Date.parse(limit!.until) >= until.getTime() ? { ...limit!, at: hit.activityAt } : { until: until.toISOString(), at: hit.activityAt, task: hit.task, run_id: hit.run_id, source, strikes };
      this.file.limit = limit;
      this.file.limit_seen = hit.activityAt;
      this.save();
      if (Date.parse(limit.until) > now.getTime()) console.error(`dashboard: autopilot holds starts until ${limit.until}: ${limit.source}`);
    }
    if (!limit) return "";
    if (Date.parse(limit.until) <= now.getTime()) {
      const until = limit.until;
      const provider = providerOf(this.dashboard.runs?.runs.get(limit.run_id));
      // An agent of the same provider that finished a turn since the hold ended: the limit is gone, the backoff starts over.
      if ([...(this.dashboard.runs?.runs.values() ?? [])].some((run) => (run.activity === "waiting" || run.activity === "needs_input") && run.activityAt > until && providerOf(run) === provider)) {
        delete this.file.limit;
        this.save();
        return "";
      }
      if (limit.checked) return "";
      const usage = await readUsage(this.dashboard.paseo, provider, now);
      limit = "resetsAt" in usage ? { ...limit, until: usage.resetsAt.toISOString(), source: `${limit.source}; then Paseo's usage report said ${usage.window} resets later` } : { ...limit, checked: true };
      this.file.limit = limit;
      this.save();
      if (limit.checked) return "";
    }
    return `waits: a usage limit holds every start until ${limit.until} (${limit.source})`;
  }

  /** Starts `task` when an ordinary start would and its instructions are seen as they are; true when it started. */
  private async tryStart(ctx: WriteContext, space: string, task: Task, key: string, by: "task" | "project", accepted: string[] = []): Promise<boolean> {
    if (taskSection(this.dashboard.spaces.get(space)!.sync.plan, task) !== "ready") {
      this.waits.set(key, `waits: ${task.id} is ${taskSection(this.dashboard.spaces.get(space)!.sync.plan, task)}`);
      return false;
    }
    const human = humanWork(this.dashboard.spaces.get(space)!.sync.plan, task);
    if (human) {
      this.waits.set(key, `waits: ${task.id}: ${human}; start it from its own screen to give it to an agent`);
      return false;
    }
    const plan = await planStart(ctx, { task: task.id });
    if (!("found" in plan)) {
      this.waits.set(key, `waits: ${plan.error}`);
      return false;
    }
    const unseen = plan.instructions.filter((part) => part.state !== "unchanged" && !accepted.includes(part.hash));
    if (unseen.length) {
      this.waits.set(key, `waits: open ${task.id} once: ${unseen.map((p) => p.name).join(", ")} ${unseen.length === 1 ? "is" : "are"} not seen by you as ${unseen.length === 1 ? "it is" : "they are"} now`);
      return false;
    }
    // The person may have turned the flag off, or it was paused, while this pass read git.
    if (!this.flagOn(key)) return true;
    // A read-back through ChatGPT is not the person seeing the text in Paseo: it marks nothing seen.
    const started = await startTask(ctx, { task: task.id }, { seen: plan.instructions.map((part) => part.hash), recordSeen: !accepted.length, automatic: true }).catch((error: unknown) => ({ ok: false, error: String((error as Error)?.message ?? error), id: task.id }));
    if (!started.ok) {
      if (/instructions changed after the confirmation/.test(started.error)) this.waits.set(key, `waits: ${task.id}'s instructions changed while the autopilot read them; open it once`);
      // A label that arrived with the claim's fetch: a person's work waits, nothing failed.
      else if (isHumanWorkRefusal(started.error, task.id)) this.waits.set(key, `waits: ${started.error}`);
      else this.pause(space, key, `paused: starting ${task.id} failed: ${started.error}`);
      return true;
    }
    const run = this.dashboard.runs?.byTask(task.id);
    this.file.started = [...this.file.started, { run_id: run?.run_id ?? "", space, task: task.id, title: task.title, project: task.project ?? "", at: new Date().toISOString() }].slice(-KEEP_STARTED);
    if (by === "task") this.file.tasks = this.file.tasks.filter((f) => !(f.space === space && f.task === task.id));
    this.save();
    this.waits.set(key, "");
    console.error(`dashboard: autopilot started ${task.id} «${task.title}»`);
    return true;
  }

  /** The flag behind `key` is still set and not paused. */
  private flagOn(key: string): boolean {
    return (
      this.file.tasks.some((f) => `t:${f.space}:${f.task}` === key && !f.paused) || this.file.projects.some((f) => `p:${f.space}:${f.project}` === key && !f.paused)
    );
  }

  private pause(space: string, key: string, reason: string): void {
    for (const f of this.file.tasks) if (`t:${f.space}:${f.task}` === key) f.paused = reason;
    for (const f of this.file.projects) if (`p:${f.space}:${f.project}` === key) f.paused = reason;
    this.save();
    console.error(`dashboard: autopilot ${reason}`);
  }

  /**
   * A project waits for the person once a run the autopilot started there failed, live or ended since,
   * or was released by a person back to todo or canceled: the next start would repeat what they stopped.
   */
  private pauseFailed(): void {
    for (const entry of this.file.started) {
      if (entry.settled) continue;
      const run = this.dashboard.runs?.runs.get(entry.run_id);
      if (!run) continue;
      const task = this.task(entry.space, entry.task);
      const over = this.dashboard.isLive(run) === false;
      const released = over && task?.run_id === run.run_id && (task.status === "todo" || task.status === "canceled");
      // A usage limit is no one's stop: the hold (limitHold) waits for its reset instead of a pause,
      // also when the start itself met it and released its own claim.
      const limited = run.activity === "failed" && isRateLimit(run.error) && (run.released === true || !released);
      const why = limited ? "" : run.activity === "failed" ? `the agent of ${entry.task} failed: ${run.error ?? "no reason given"}` : released ? `${entry.task} was released back to ${task!.status}` : "";
      if (!why) {
        if (over) {
          entry.settled = true;
          this.save();
        }
        continue;
      }
      entry.settled = true;
      const flag = this.file.projects.find((f) => f.space === entry.space && f.project === entry.project && !f.paused);
      if (flag) this.pause(entry.space, `p:${flag.space}:${flag.project}`, `paused: ${why}`);
      else this.save();
    }
  }

}
