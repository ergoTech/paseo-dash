import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { userInfo } from "node:os";
import type { activityTrackRpc } from "../shared/activity.ts";
import { briefText, ownerError, type WriteContext } from "./api/writes.ts";
import { localHost } from "./api/view.ts";
import { taskBody } from "./plan/document.ts";
import { newId, opaqueId } from "./plan/ids.ts";
import { trunkNames } from "./runner/branch.ts";
import type { RunRecord } from "./runner/runs.ts";
import { localProjects } from "./spaces/local.ts";
import { SAFE_BRANCH } from "./sync/git.ts";
import { activityOf } from "./tracker/tracker.ts";

/**
 * "Track as task" (05-architecture.md, Tracking a Paseo workspace as a task): a person takes an open
 * Paseo workspace of a line into the plan. The task is created as todo and claimed in one operation
 * decided from origin (I5); the run is stored in runs.json before the claim, with the workspace and
 * agent read from Paseo now, so the tracker follows it as it follows a started run. Nothing is created
 * in Paseo and nothing is changed on the workspace or its agent.
 */

type Track = RpcOutput<typeof activityTrackRpc>;

/** Paseo 0.13's workspace descriptor, the fields read here. */
interface Descriptor {
  id: string;
  projectId?: string;
  name?: string;
  title?: string | null;
  workspaceKind?: string;
  workspaceDirectory?: string;
  projectRootPath?: string;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
}

interface AgentEntry {
  agent?: { id: string; workspaceId?: string | null; archivedAt?: string | null; status?: string | null; pendingPermissions?: unknown[] | null };
}

/** Pages of a project's agents read to find the workspace's agent. */
const AGENT_PAGES = 5;

/** One adoption of a workspace at a time, so two taps cannot make two tasks. */
const adopting = new WeakMap<object, Map<string, Promise<Track>>>();

export function trackWorkspace(ctx: WriteContext, input: RpcInput<typeof activityTrackRpc>): Promise<Track> {
  let running = adopting.get(ctx.dashboard);
  if (!running) adopting.set(ctx.dashboard, (running = new Map()));
  const key = input.workspace_id.trim();
  const busy = running.get(key);
  if (busy) return busy.then((answer) => (answer.ok ? { ...answer, existing: true } : answer));
  const work = track(ctx, input).finally(() => running!.delete(key));
  running.set(key, work);
  return work;
}

/**
 * The task a run of this machine in this workspace stands for, if any (de-duplication). A tracked
 * run that ended no longer holds its workspace: a long-lived checkout tracked once can be tracked
 * again for new work. A worktree the dashboard made stays its task's.
 */
export function trackedTask(ctx: WriteContext, workspaceId: string): RunRecord | undefined {
  return ctx.dashboard.runs
    ?.byWorkspace(workspaceId)
    .find(
      (run) =>
        run.claim === "undecided" ||
        (ctx.dashboard.spaces.get(run.space)?.sync.plan.entities.get(run.task)?.entity.type === "task" && (!run.adopted || ctx.dashboard.isLive(run) !== false)),
    );
}

async function track(ctx: WriteContext, input: RpcInput<typeof activityTrackRpc>): Promise<Track> {
  const fail = (error: string, kind: Track["kind"] = ""): Track => ({ ok: false, id: "", existing: false, kind, error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const { dashboard } = ctx;
  const runs = dashboard.runs;
  if (!runs) return fail("Paseo Dash has not started");
  const space = dashboard.spaces.get(input.space.trim().toUpperCase());
  if (!space) return fail(`No space ${input.space}.`);
  const project = space.sync.plan.space?.projects[input.project];
  if (!project) return fail(`${space.record.name} has no project ${input.project}.`);
  const projectId = space.record.mapping[input.project];
  if (!projectId) return fail(`Project ${input.project} is not mapped on this Mac.`);
  const workspaceId = input.workspace_id.trim();

  const known = trackedTask(ctx, workspaceId);
  if (known?.claim === "undecided") return fail("The workspace is being tracked already; whether its task landed in the plan is decided by the next sync. Try again in a minute.");
  if (known) return { ok: true, id: known.task, existing: true, kind: known.adopted?.trunk ? "trunk" : "branch", error: "" };

  const paseo = dashboard.paseo;
  if (!paseo) return fail("Paseo has not connected to Paseo Dash yet.");
  const workspace = (await paseo.workspaces
    .ref(workspaceId)
    .refresh()
    .catch(() => undefined)) as Descriptor | null | undefined;
  if (workspace === undefined) return fail("Paseo did not answer about the workspace; try again.");
  if (!workspace || workspace.archivingAt) return fail("The workspace is not open in Paseo any more.");
  if (workspace.projectId !== projectId) return fail(`The workspace is not in the Paseo project ${input.project} maps to on this Mac.`);
  const branch = workspace.gitRuntime?.currentBranch ?? "";
  // The branch goes into git and gh/glab commands and the plan: it is checked as any plan branch is.
  if (!branch) return fail("The workspace is not on a branch (Paseo does not know its branch yet, or its HEAD is detached).");
  if (!SAFE_BRANCH.test(branch)) return fail(`The workspace's branch ${JSON.stringify(branch)} is not a usable branch name.`);

  if (!dashboard.projectRoots.has(projectId)) dashboard.addProjectRoots(await localProjects(paseo).catch(() => []));
  const root = dashboard.projectRoots.get(projectId);
  const trunks = await trunkNames(dashboard.git, root, [project.trunk]);
  const trunk = trunks.includes(branch) ? branch : undefined;
  const kind: Track["kind"] = trunk ? "trunk" : "branch";
  const directory = workspace.workspaceDirectory || workspace.projectRootPath || "";
  if (trunk && !directory) return fail("Paseo does not say where the checkout is, so whether it landed cannot be read.", kind);

  // The workspace's newest agent that is not archived; a workspace without one is tracked all the same.
  // Paseo's agent list filters by project, not by workspace: pages are read until the workspace's
  // agent shows up or the list ends (at most AGENT_PAGES).
  let agent: AgentEntry["agent"];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < AGENT_PAGES && !agent; page += 1) {
      const listed = (await paseo.agents.list({
        filter: { projectKeys: [projectId] },
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      } as never)) as unknown as { entries: AgentEntry[]; pageInfo?: { nextCursor?: string | null; hasMore?: boolean } };
      agent = listed.entries.map((entry) => entry.agent).find((a) => a && a.workspaceId === workspaceId && !a.archivedAt);
      cursor = listed.pageInfo?.nextCursor ?? undefined;
      if (!listed.pageInfo?.hasMore || !cursor) break;
    }
  } catch (error) {
    return fail(`Paseo's agents could not be read: ${String((error as Error)?.message ?? error)}`, kind);
  }

  const now = (ctx.now ?? (() => new Date()))();
  const host = ctx.host ?? localHost();
  const name = (workspace.title || workspace.name || `${input.project}:${branch}`).replace(/\s+/g, " ").trim();
  const title = (input.title ?? "").trim() || name;
  const follows = trunk ? `whether its commits landed on origin/${trunk}` : "its PR/MR";
  const brief = [
    `Tracked from the Paseo workspace «${name}» on ${host}, branch \`${branch}\`${trunk ? " (the trunk)" : ""}.`,
    `Its agent has no Paseo Dash tools: progress comes from the agent's state in Paseo and from ${follows}.`,
  ].join("\n\n");
  const id = newId(space.record.key, space.sync.takenIds());
  const priority = space.sync.plan.space?.defaults.priority;
  // On the trunk, `base` names it in the plan, so every machine (not only this one, which knows the
  // run) sees the run is on the trunk: no PR/MR is looked for, and a later start never continues on it.
  const fields = { title, status: "todo", project: input.project, ...(priority ? { priority } : {}), ...(trunk ? { base: trunk } : {}) };
  const runFields = {
    run_id: opaqueId("r"),
    run_by: (await space.sync.gitUser()) || userInfo().username,
    run_host: host,
    run_branch: branch,
    run_started: now.toISOString(),
  };
  const activity: ReturnType<typeof activityOf> = agent ? activityOf(agent as Parameters<typeof activityOf>[0]) : { activity: "stopped" };
  // Stored before the claim, so a claim decided later (I5) and a second tap both find it.
  const run: RunRecord = {
    run_id: runFields.run_id,
    space: space.record.key,
    task: id,
    project: input.project,
    projectId,
    branch,
    started: runFields.run_started,
    attempts: [],
    workspaceId,
    ...(agent ? { agentId: agent.id } : {}),
    claim: "undecided",
    activity: activity.activity,
    activityAt: now.toISOString(),
    ...(activity.waitingFor ? { waitingFor: activity.waitingFor } : {}),
    ...(activity.waitingKind ? { waitingKind: activity.waitingKind } : {}),
    adopted: { kind: workspace.workspaceKind ?? "", directory, ...(trunk ? { trunk } : {}) },
  };
  runs.put(run);
  const claim = await space.sync.claim(id, runFields, undefined, { fields, body: `\n${taskBody(briefText(brief), [])}` });
  if (claim.result === "won") {
    run.claim = "won";
    runs.save();
    if (trunk) void dashboard.refreshLanded(run);
    else dashboard.checkPrs(run);
    return { ok: true, id, existing: false, kind, error: "" };
  }
  if (claim.result === "unknown") throw new Error(claim.reason);
  runs.remove(run.run_id);
  return fail(claim.reason, kind);
}
