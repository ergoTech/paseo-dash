import type { PaseoApi } from "../paseo.ts";
import type { McpServerConfig, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { STARTED_CARD } from "../../shared/timeline.ts";
import type { Attempt, RunRecord, RunStore } from "./runs.ts";
import type { AgentSettings } from "./profiles.ts";

/**
 * Turns a won claim into a worktree workspace and an agent (05-architecture.md, Starting a task).
 * Every step is persisted before it is sent, and each attempt sends exactly the requests it stored,
 * under its own idempotency key (I6), so a reload or a lost answer resends the same thing and Paseo
 * returns what it already made. A failed or unclear step is reconciled from Paseo (the run's label,
 * the workspace it made) before anything is declared failed.
 */

export const LABEL_RUN = "dashboard.run";

export interface LaunchInput {
  run_id: string;
  space: string;
  task: string;
  title: string;
  project: string;
  projectId: string;
  branch: string;
  base: string | undefined;
  /** A new worktree (branched off, or a checkout of the existing branch), or the previous run's workspace. */
  workspace?: { kind: "new"; action: "branch-off" | "checkout" } | { kind: "reuse"; workspaceId: string };
  prompt: string;
  settings: AgentSettings;
  started: string;
  /** The agent tools bridge for this run, when available, and the token it carries. */
  tools?: { server: McpServerConfig; policy: ToolPolicy; token: string };
}

export interface RunnerOptions {
  store: RunStore;
  paseo: () => PaseoApi | undefined;
  now?: () => Date;
  log?: (message: string) => void;
  /**
   * Whether the plan still holds this run as the task's live run; false stops a recovered start
   * before it creates anything, undefined (plan not loaded) lets it go on.
   */
  isLive?: (run: RunRecord) => boolean | undefined;
  /** How often to re-read a new workspace whose branch is not known yet. */
  branchChecks?: number;
  branchCheckDelayMs?: number;
  /**
   * Ends the claim of a start that failed before Paseo was asked for its agent: nothing can run
   * under that run, so the task goes back to be started again instead of staying held.
   */
  release?: (run: RunRecord) => void;
  /**
   * The run has its agent. Paseo starts the first turn as it creates the agent, before the run knows
   * the agent's id, so that turn's start hook cannot find the run: what follows the agent starts here.
   */
  onAgent?: (run: RunRecord) => void;
}

export class Runner {
  private readonly options: RunnerOptions;
  private readonly driving = new Set<string>();

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  private get store(): RunStore {
    return this.options.store;
  }

  private stamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * Records the run and its first attempt, then drives it in the background. A run whose claim is
   * still undecided is only recorded; `claimDecided` starts or drops it.
   */
  launch(input: LaunchInput, claim: "won" | "undecided" = "won"): RunRecord {
    const attempt: Attempt = {
      n: 1,
      key: `dashboard:${input.run_id}:1`,
      workspaceRequest:
        input.workspace?.kind === "reuse"
          ? { reuse: input.workspace.workspaceId }
          : {
              // Named as people read it, like the agent: "<task id> · <task title>"; the branch stays ASCII.
              title: input.title,
              source:
                input.workspace?.action === "checkout"
                  ? { kind: "worktree", projectId: input.projectId, action: "checkout", refName: input.branch }
                  : {
                      kind: "worktree",
                      projectId: input.projectId,
                      action: "branch-off",
                      branchName: input.branch,
                      ...(input.base ? { baseBranch: input.base } : {}),
                    },
            },
      ...(input.workspace?.kind === "reuse" ? { workspaceId: input.workspace.workspaceId } : {}),
      agentRequest: {
        title: input.title,
        prompt: input.prompt,
        labels: { dashboard: "1", "dashboard.space": input.space, "dashboard.task": input.task, [LABEL_RUN]: input.run_id },
        config: {
          provider: input.settings.provider,
          ...(input.settings.modeId ? { modeId: input.settings.modeId } : {}),
          ...(input.settings.thinkingOptionId ? { thinkingOptionId: input.settings.thinkingOptionId } : {}),
          ...(input.settings.featureValues ? { featureValues: input.settings.featureValues } : {}),
          ...(input.tools ? { mcpServers: { dashboard: input.tools.server }, toolPolicy: input.tools.policy } : {}),
        },
      },
      state: "pending",
    };
    const run: RunRecord = {
      run_id: input.run_id,
      space: input.space,
      task: input.task,
      project: input.project,
      projectId: input.projectId,
      branch: input.branch,
      started: input.started,
      attempts: [attempt],
      claim,
      ...(input.workspace?.kind === "reuse" ? { workspaceId: input.workspace.workspaceId } : {}),
      ...(input.tools ? { token: input.tools.token } : {}),
      activity: "launching",
      activityAt: this.stamp(),
      asked: {
        ...(input.settings.modeId ? { modeId: input.settings.modeId } : {}),
        mode: input.settings.mode,
        ...(input.settings.thinkingOptionId ? { effortId: input.settings.thinkingOptionId } : {}),
        effort: input.settings.effort,
      },
    };
    this.store.put(run);
    if (claim === "won") this.drive(run);
    return run;
  }

  /** A claim decided by a later fetch (I5): the start goes on when it landed, and is dropped when not. */
  claimDecided(runId: string, won: boolean): void {
    const run = this.store.runs.get(runId);
    if (!run || run.claim !== "undecided") return;
    if (run.adopted) {
      // A tracked workspace has nothing to create: the run is kept when it landed and dropped when not.
      if (!won) return this.store.remove(runId);
      run.claim = "won";
      return this.store.save();
    }
    if (won) {
      run.claim = "won";
      this.store.save();
      this.drive(run);
      return;
    }
    const attempt = run.attempts.at(-1);
    if (attempt) this.fail(run, attempt, "The claim did not land in the plan repo; nothing was started.");
  }

  /** Runs whose last attempt did not finish are driven again with the requests they stored. */
  recover(): void {
    for (const run of this.store.runs.values()) {
      const last = run.attempts.at(-1);
      if (run.claim === "won" && last && last.state !== "done" && last.state !== "failed") this.drive(run);
    }
  }

  private drive(run: RunRecord): void {
    if (this.driving.has(run.run_id)) return;
    this.driving.add(run.run_id);
    void this.step(run)
      .catch((error: unknown) => this.log(`run ${run.run_id}: ${(error as Error).message}`))
      .finally(() => this.driving.delete(run.run_id));
  }

  private async step(run: RunRecord): Promise<void> {
    const paseo = this.options.paseo();
    const attempt = run.attempts.at(-1);
    if (!attempt) return;
    if (!paseo) {
      this.log(`run ${run.run_id}: waiting for Paseo to connect`);
      return;
    }
    // A start resumed after a reload may find the task released or taken meanwhile.
    if (this.options.isLive?.(run) === false) {
      return this.fail(run, attempt, "The task is no longer held by this run (released or changed meanwhile); nothing more was started.");
    }
    try {
      // The branch the creation answer reports. Paseo fills it from the worktree it just made, while
      // a later read of the workspace only has it once the daemon's git watcher has looked.
      let reported: string | undefined;
      if (!attempt.workspaceId) {
        attempt.state = "workspace";
        this.store.save();
        const create = () => paseo.workspaces.create({ ...(attempt.workspaceRequest as object), idempotencyKey: attempt.key } as never);
        // Asked again with the same key and request (I6): a lost answer gets what Paseo made or is
        // still making. A recorded "outcome unknown" fails again, and then the workspace is looked for.
        const workspace: { id: string; current?: () => unknown } = await create()
          .catch(() => create())
          .catch(async (error: unknown) => {
            const found = await this.findWorkspace(paseo, run).catch(() => undefined);
            if (found) return { id: found };
            throw error;
          });
        attempt.workspaceId = workspace.id;
        run.workspaceId = workspace.id;
        this.store.save();
        reported = branchIn(workspace.current?.());
      }
      const actual = reported || (await this.branchOf(paseo, attempt.workspaceId));
      if (actual !== run.branch) {
        // Nothing may run on the wrong branch, or on one Paseo did not name: PR/MR tracking keys on
        // run_branch. Only a workspace this attempt made is archived; the previous run's, being
        // reused, may hold its work.
        const reused = "reuse" in attempt.workspaceRequest;
        const archived = reused
          ? "the previous run's workspace was left as it is"
          : await paseo.workspaces
              .archive(attempt.workspaceId)
              .then(() => "it was archived")
              .catch(() => "archive it in Paseo");
        const released = this.options.release ? " Its claim is being released back to todo so the task can be started again." : "";
        return this.fail(
          run,
          attempt,
          actual
            ? `Paseo made the workspace on branch ${actual} instead of ${run.branch}, so nothing was started and ${archived}. ${run.branch} is probably checked out in another worktree; the extra branch ${actual} stays in the repository.${released}`
            : `Paseo did not report which branch workspace ${attempt.workspaceId} is on, so nothing was started and ${archived}.${released}`,
          true,
        );
      }
      if (!attempt.agentId) {
        attempt.state = "agent";
        this.store.save();
        const agent = await paseo.workspaces.ref(attempt.workspaceId).agents.create({ ...(attempt.agentRequest as object), idempotencyKey: `${attempt.key}:agent` } as never);
        attempt.agentId = agent.id;
        run.agentId = agent.id;
      }
      attempt.state = "done";
      this.store.setActivity(run, "working", this.stamp());
      this.options.onAgent?.(run);
      await this.card(paseo, run).catch((error: unknown) => this.log(`run ${run.run_id}: timeline card: ${(error as Error).message}`));
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // Unclear or failed: whatever Paseo made under this run is adopted before giving up (I6).
      const found = await this.reconcile(paseo, run).catch(() => undefined);
      if (found?.agentId) {
        attempt.workspaceId ??= found.workspaceId;
        attempt.agentId = found.agentId;
        run.workspaceId = found.workspaceId ?? run.workspaceId;
        run.agentId = found.agentId;
        attempt.state = "done";
        this.store.setActivity(run, "working", this.stamp());
        this.options.onAgent?.(run);
        await this.card(paseo, run).catch(() => undefined);
        return;
      }
      // Before the agent step the agent was never asked for; past it, one may yet appear.
      const beforeAgent = attempt.state !== "agent";
      const orphan = !attempt.workspaceId && attempt.state === "workspace" ? " A workspace Paseo may have made for it stays in Paseo." : "";
      const released = beforeAgent && this.options.release ? `${orphan} Its claim is being released back to todo so the task can be started again.` : "";
      const end = released && !/[.!?]$/.test(message) ? "." : "";
      // Said as the step that failed: Paseo refusing the worktree (a branch git holds elsewhere) is not an agent failing.
      const step = attempt.state === "workspace" && !attempt.workspaceId ? `Creating the workspace on ${run.branch} failed` : "Starting the agent failed";
      this.fail(run, attempt, `${step}: ${message}${end}${released}`, beforeAgent);
    }
  }

  /** The workspace's checked-out branch; an empty answer means "not known yet" and is asked again. */
  private async branchOf(paseo: PaseoApi, workspaceId: string): Promise<string> {
    const tries = this.options.branchChecks ?? 5;
    for (let i = 0; i < tries; i += 1) {
      const branch = branchIn(await paseo.workspaces.ref(workspaceId).refresh());
      if (branch) return branch;
      await new Promise((resolve) => setTimeout(resolve, this.options.branchCheckDelayMs ?? 1_000));
    }
    return "";
  }

  /** The workspace an unclear creation made, if exactly one fits (see `pickWorkspace`). */
  private async findWorkspace(paseo: PaseoApi, run: RunRecord): Promise<string | undefined> {
    const listed = await paseo.workspaces.list({});
    const taken = new Set([...this.store.runs.values()].filter((r) => r.run_id !== run.run_id && r.workspaceId).map((r) => r.workspaceId!));
    return pickWorkspace(listed.entries as WorkspaceEntry[], run, taken);
  }

  /** An agent created for this run, found by its label and accepted only in the run's workspace. */
  async reconcile(paseo: PaseoApi, run: RunRecord): Promise<{ agentId?: string; workspaceId?: string } | undefined> {
    const listed = await paseo.agents.list({ filter: { labels: { [LABEL_RUN]: run.run_id }, includeArchived: true } } as never);
    for (const entry of listed.entries as { agent?: { id: string; workspaceId?: string | null } }[]) {
      const agent = entry.agent;
      if (!agent) continue;
      const attempt = run.attempts.find((a) => a.workspaceId && a.workspaceId === agent.workspaceId);
      if (attempt) return { agentId: agent.id, workspaceId: agent.workspaceId ?? undefined };
    }
    return undefined;
  }

  /** `release`: the start never asked Paseo for an agent, so its claim ends with it. */
  private fail(run: RunRecord, attempt: Attempt, error: string, release = false): void {
    attempt.state = "failed";
    attempt.error = error;
    if (release && this.options.release) run.released = true;
    this.store.setActivity(run, "failed", this.stamp(), { error });
    this.log(`run ${run.run_id}: ${error}`);
    if (release) this.options.release?.(run);
  }

  private async card(paseo: PaseoApi, run: RunRecord): Promise<void> {
    if (!run.agentId) return;
    await paseo.agents.ref(run.agentId).timeline.append({
      type: "plugin",
      id: `dashboard-start-${run.run_id}`,
      kind: STARTED_CARD.kind,
      version: STARTED_CARD.version,
      data: { task: run.task, space: run.space, branch: run.branch, run: run.run_id },
    });
  }
}

/** The checked-out branch a workspace descriptor reports; empty when it does not say yet. */
function branchIn(descriptor: unknown): string {
  return (descriptor as { gitRuntime?: { currentBranch?: string | null } | null } | null | undefined)?.gitRuntime?.currentBranch ?? "";
}

export interface WorkspaceEntry {
  id: string;
  projectId?: string | null;
  title?: string | null;
  name?: string | null;
  createdAt?: string | null;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
}

/**
 * The workspace an unclear creation made: in the run's project, titled and checked out as the run
 * asked, created after the run started (so a person's older workspace on that branch is never
 * taken), and not another run's. Two such workspaces are ambiguous and nothing is adopted.
 */
export function pickWorkspace(entries: WorkspaceEntry[], run: RunRecord, takenByOtherRuns: Set<string>): string | undefined {
  // The title stored in the run's request, as Paseo keeps it (trimmed); `<project>:<branch>` when none is stored.
  const asked = run.attempts?.at(-1)?.workspaceRequest.title;
  const title = typeof asked === "string" && asked.trim() ? asked.trim() : `${run.project}:${run.branch}`;
  const matches = entries.filter(
    (w) =>
      w.projectId === run.projectId &&
      (w.title ?? w.name) === title &&
      w.gitRuntime?.currentBranch === run.branch &&
      !w.archivingAt &&
      Date.parse(w.createdAt ?? "") >= Date.parse(run.started) &&
      !takenByOtherRuns.has(w.id),
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}
