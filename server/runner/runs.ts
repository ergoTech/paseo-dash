import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../json-file.ts";

/**
 * Runtime state of the runs started on this machine (`plugin-data/dashboard/runs.json`, 0600): the
 * start job's attempts with the exact requests each one sends (I6), the workspace and agent it
 * created, and what the agent is doing. Only this machine knows it; the plan repo has the run's
 * coarse state (03-model.md, Run activity).
 */

export const ACTIVITIES = ["launching", "working", "waiting", "needs_input", "failed", "stopped"] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** What a `needs_input` agent waits on: a permission (a tool, a plan, a mode) or its questions to the user. */
export const WAITING_KINDS = ["permission", "question"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

const attemptSchema = z.object({
  n: z.number().int().positive(),
  /** `dashboard:<run_id>:<n>`: one key per attempt, never reused with another request (I6). */
  key: z.string(),
  workspaceRequest: z.record(z.string(), z.unknown()),
  agentRequest: z.record(z.string(), z.unknown()),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  state: z.enum(["pending", "workspace", "agent", "done", "failed"]),
  error: z.string().optional(),
});
export type Attempt = z.output<typeof attemptSchema>;

/**
 * A workspace a person tracked as a task ("Track as task", 05-architecture.md, Tracking a Paseo
 * workspace as a task): no start job made it, and its agent has no dashboard tools.
 */
const adoptedSchema = z.object({
  /** Paseo's `workspaceKind`: only a `worktree` may ever be handed to a later start. */
  kind: z.string(),
  /** The workspace's directory when it was tracked. */
  directory: z.string(),
  /** The trunk when the workspace is on it: then no PR/MR, and "landed" is read instead. */
  trunk: z.string().optional(),
  /** The last landed reading of a trunk checkout. */
  landed: z
    .object({
      head: z.string(),
      clean: z.boolean(),
      landed: z.boolean(),
      at: z.string(),
      /** Paseo shows the workspace archived (or no longer has it). */
      archived: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
});
export type Adopted = z.output<typeof adoptedSchema>;

const runSchema = z.object({
  run_id: z.string(),
  space: z.string(),
  task: z.string(),
  project: z.string(),
  projectId: z.string(),
  branch: z.string(),
  started: z.string(),
  attempts: z.array(attemptSchema),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  /** `undecided` while the claim's push had no clear answer: nothing is created until it is won (I5). */
  claim: z.enum(["won", "undecided"]).default("won"),
  activity: z.enum(ACTIVITIES),
  activityAt: z.string(),
  /** The run's secret for the agent tools bridge; only its own agent has it. */
  token: z.string().optional(),
  /** A merge request URL the agent reported; checked against the run's branch before it counts. */
  reportedPr: z.string().optional(),
  /** The start failed before asking for its agent and released its own claim: its failure stays news. */
  released: z.boolean().optional(),
  /** What the agent asks the user for, while `needs_input`. */
  waitingFor: z.string().optional(),
  /** Whether that is a permission or questions, while `needs_input`; absent reads as a permission. */
  waitingKind: z.enum(WAITING_KINDS).optional(),
  /** The agent's latest reply, cut short. */
  lastMessage: z.string().optional(),
  error: z.string().optional(),
  adopted: adoptedSchema.optional(),
  /** When the dashboard stopped this run's agent after the run ended by a release (D23). */
  stoppedAt: z.string().optional(),
  /** When a person archived the run's workspace from the dashboard. */
  workspaceArchivedAt: z.string().optional(),
  /**
   * The mode and effort the start passed to `agents.create`, each id with where it came from as a
   * person hears it ("High (high, this Mac's default)"); absent for runs started before it was kept and tracked ones.
   */
  asked: z.object({ modeId: z.string().optional(), mode: z.string(), effortId: z.string().optional(), effort: z.string() }).optional(),
  /** What Paseo last reported the agent runs with: its current mode and its effective effort ids. */
  reported: z.object({ modeId: z.string().optional(), effortId: z.string().optional() }).optional(),
});
export type RunRecord = z.output<typeof runSchema>;

const fileSchema = z.object({ version: z.literal(1), runs: z.array(runSchema) });

export class RunStore {
  readonly runs = new Map<string, RunRecord>();
  readonly movedAside: string | undefined;
  /**
   * Told of every activity change, after the run holds it and before runs.json is saved (the task
   * events, server/events.ts). A listener that throws is reported and the run is saved all the same.
   */
  onActivity: ((run: RunRecord, previous: Activity) => void) | undefined;
  onActivityError: ((error: unknown) => void) | undefined;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const read = readJsonFile(path, fileSchema, () => ({ version: 1 as const, runs: [] }));
    for (const run of read.value.runs) this.runs.set(run.run_id, run);
    this.movedAside = read.movedAside;
  }

  save(): void {
    writeJsonFile(this.path, { version: 1, runs: [...this.runs.values()] });
  }

  put(run: RunRecord): void {
    this.runs.set(run.run_id, run);
    this.save();
  }

  /**
   * The run of this machine whose agent this is: the newest of them (the later one on a tie). A workspace tracked again after
   * its run ended keeps its agent, so an older, ended run may carry the same agent id.
   */
  byAgent(agentId: string): RunRecord | undefined {
    let newest: RunRecord | undefined;
    for (const run of this.runs.values()) if (run.agentId === agentId && (!newest || run.started >= newest.started)) newest = run;
    return newest;
  }

  /** The run of this machine in this workspace, adopted or started, newest first. */
  byWorkspace(workspaceId: string): RunRecord[] {
    return [...this.runs.values()]
      .filter((run) => run.workspaceId === workspaceId || run.attempts.some((a) => a.workspaceId === workspaceId))
      .sort((a, b) => b.started.localeCompare(a.started));
  }

  remove(runId: string): void {
    if (this.runs.delete(runId)) this.save();
  }

  /** The latest run of a task started on this machine. */
  byTask(task: string): RunRecord | undefined {
    let latest: RunRecord | undefined;
    for (const run of this.runs.values()) if (run.task === task && (!latest || run.started > latest.started)) latest = run;
    return latest;
  }

  setActivity(run: RunRecord, activity: Activity, at: string, extra: Partial<Pick<RunRecord, "waitingFor" | "waitingKind" | "lastMessage" | "error">> = {}): void {
    const previous = run.activity;
    run.activity = activity;
    run.activityAt = at;
    if (activity !== "needs_input") {
      delete run.waitingFor;
      delete run.waitingKind;
    }
    for (const [key, value] of Object.entries(extra) as [keyof typeof extra, RunRecord[keyof typeof extra]][]) {
      if (value === undefined) delete run[key];
      else Object.assign(run, { [key]: value });
    }
    try {
      this.onActivity?.(run, previous);
    } catch (error) {
      this.onActivityError?.(error);
    }
    this.save();
  }
}
