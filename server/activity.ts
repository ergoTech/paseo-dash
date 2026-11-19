import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { type ActiveWorkspace, type activityRpc, BUSY_STATUSES, type PastWorkspace, WORKSPACE_STATUSES } from "../shared/activity.ts";
import type { Dashboard, SpaceRecord } from "./dashboard.ts";
import type { Plan } from "./plan/load.ts";
import type { PaseoApi } from "./paseo.ts";

/**
 * Work in Paseo the plan does not hold (shared/activity.ts): the open workspaces of each Paseo
 * project and its archived ones, minus every workspace a dashboard task runs in. Read from Paseo at
 * most every FRESH_MS and kept, so the map, read again whenever the changes token moves, reads the last answer and never
 * waits for Paseo.
 */

const FRESH_MS = 10_000;
/** Archived workspaces kept per project: the line's recent past, not its whole history. */
export const PAST_LIMIT = 30;
const PAGE = 200;
/** Pages read per list; a daemon with more open workspaces than this shows the first ones. */
const MAX_PAGES = 5;
/** Archived agents read, newest first: enough for each line's recent past. */
const AGENT_PAGES = 3;

export interface ProjectActivity {
  active: ActiveWorkspace[];
  past: PastWorkspace[];
}

export interface ActivitySnapshot {
  /** By Paseo project id. */
  byProject: Map<string, ProjectActivity>;
  readAt: string;
}

/** The fields of Paseo 0.13's workspace descriptor and agent list entry this reads. */
interface WorkspaceEntry {
  id: string;
  projectId: string;
  name: string;
  status: string;
  statusEnteredAt?: string | null;
  createdAt?: string;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
  githubRuntime?: { pullRequest?: { url?: string; state?: string; isMerged?: boolean } | null } | null;
}

interface AgentEntry {
  agent: { id: string; title: string | null; workspaceId?: string; archivedAt?: string | null; labels?: Record<string, string> };
  project?: { projectKey: string; workspaceName?: string | null; checkout?: { currentBranch?: string | null } } | null;
}

interface Page<T> {
  entries: T[];
  pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
}

async function pages<T>(read: (cursor: string | undefined) => Promise<Page<T>>, max: number): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const page = await read(cursor);
    out.push(...page.entries);
    cursor = page.pageInfo?.nextCursor ?? undefined;
    if (!page.pageInfo?.hasMore || !cursor) break;
  }
  return out;
}

const RANK = new Map<string, number>(WORKSPACE_STATUSES.map((status, index) => [status, index]));

/** Waiting for you or failed first, then working, then idle; newest first within each. */
export function sortActive(list: ActiveWorkspace[]): ActiveWorkspace[] {
  return [...list].sort((a, b) => RANK.get(a.status)! - RANK.get(b.status)! || b.since.localeCompare(a.since));
}

/**
 * The snapshot from Paseo's lists. `own` are the workspaces dashboard tasks run in; agents the
 * dashboard created (label `dashboard`) mark theirs too, so a run this machine forgot still counts.
 */
export function buildActivity(workspaces: WorkspaceEntry[], agents: AgentEntry[], own: Set<string>, readAt: string): ActivitySnapshot {
  const mine = new Set(own);
  for (const { agent } of agents) if (agent.labels?.dashboard === "1" && agent.workspaceId) mine.add(agent.workspaceId);
  const byProject = new Map<string, ProjectActivity>();
  const of = (projectId: string) => {
    let entry = byProject.get(projectId);
    if (!entry) byProject.set(projectId, (entry = { active: [], past: [] }));
    return entry;
  };
  const open = new Set<string>();
  for (const w of workspaces) {
    if (w.archivingAt) continue;
    open.add(w.id);
    if (mine.has(w.id) || !RANK.has(w.status)) continue;
    const pr = w.githubRuntime?.pullRequest;
    of(w.projectId).active.push({
      workspace_id: w.id,
      title: w.name,
      branch: w.gitRuntime?.currentBranch ?? "",
      status: w.status as ActiveWorkspace["status"],
      since: w.statusEnteredAt ?? w.createdAt ?? "",
      pr_url: pr?.url ?? "",
      pr_state: pr ? (pr.isMerged ? "merged" : (pr.state ?? "").toLowerCase()) : "",
    });
  }
  // A workspace with several archived agents is one entry, dated by its latest.
  const pastOf = new Map<string, { projectId: string; item: PastWorkspace }>();
  for (const { agent, project } of agents) {
    if (!agent.archivedAt || !project?.projectKey || agent.labels?.dashboard === "1") continue;
    if (agent.workspaceId && (mine.has(agent.workspaceId) || open.has(agent.workspaceId))) continue;
    const key = agent.workspaceId ?? `agent:${agent.id}`;
    const known = pastOf.get(key);
    if (known && known.item.archived_at >= agent.archivedAt) continue;
    pastOf.set(key, {
      projectId: project.projectKey,
      item: {
        workspace_id: agent.workspaceId ?? "",
        title: project.workspaceName || agent.title || "untitled",
        branch: project.checkout?.currentBranch ?? "",
        archived_at: agent.archivedAt,
      },
    });
  }
  for (const { projectId, item } of pastOf.values()) of(projectId).past.push(item);
  for (const entry of byProject.values()) {
    entry.active = sortActive(entry.active);
    entry.past = entry.past.sort((a, b) => b.archived_at.localeCompare(a.archived_at)).slice(0, PAST_LIMIT);
  }
  return { byProject, readAt };
}

export class ActivityReader {
  private snapshot: ActivitySnapshot | undefined;
  private readAtMs = 0;
  private inflight: Promise<ActivitySnapshot> | undefined;
  lastError = "";

  private readonly paseo: () => PaseoApi | undefined;
  private readonly own: () => Set<string>;
  private readonly now: () => number;

  constructor(paseo: () => PaseoApi | undefined, own: () => Set<string>, now: () => number = Date.now) {
    this.paseo = paseo;
    this.own = own;
    this.now = now;
  }

  /** The last snapshot read, however old; undefined before the first one. */
  last(): ActivitySnapshot | undefined {
    return this.snapshot;
  }

  /** The last snapshot at once; a stale one starts a refresh in the background. */
  peek(): ActivitySnapshot | undefined {
    if (this.now() - this.readAtMs >= FRESH_MS) void this.read().catch(() => undefined);
    return this.snapshot;
  }

  /** A snapshot no older than FRESH_MS; one read at a time. */
  read(): Promise<ActivitySnapshot> {
    // Within FRESH_MS of the last read the answer is that read's: its snapshot, or its failure (the
    // caller then shows `last()` with the error, never old data as if it were current).
    const fresh = this.now() - this.readAtMs < FRESH_MS;
    if (fresh && this.lastError) return Promise.reject(new Error(this.lastError));
    if (fresh && this.snapshot) return Promise.resolve(this.snapshot);
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<ActivitySnapshot> {
    const paseo = this.paseo();
    if (!paseo) throw new Error("Paseo has not connected to Paseo Dash yet");
    try {
      const workspaces = await pages<WorkspaceEntry>(
        (cursor) => paseo.workspaces.list({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } } as never) as unknown as Promise<Page<WorkspaceEntry>>,
        MAX_PAGES,
      );
      const agents = await pages<AgentEntry>(
        (cursor) =>
          paseo.agents.list({
            filter: { includeArchived: true },
            sort: [{ key: "updated_at", direction: "desc" }],
            page: { limit: PAGE, ...(cursor ? { cursor } : {}) },
          } as never) as unknown as Promise<Page<AgentEntry>>,
        AGENT_PAGES,
      );
      this.snapshot = buildActivity(workspaces, agents, this.own(), new Date(this.now()).toISOString());
      this.readAtMs = this.now();
      this.lastError = "";
      return this.snapshot;
    } catch (error) {
      this.lastError = String((error as Error)?.message ?? error);
      // Not again before FRESH_MS, also with nothing read yet: a failed read counts as a read.
      this.readAtMs = this.now();
      throw error;
    }
  }
}

/** The workspaces dashboard tasks run in, from this machine's runs; tracked ones only while their run lasts. */
export function runWorkspaces(dashboard: Dashboard): Set<string> {
  const ids = new Set<string>();
  for (const run of dashboard.runs?.runs.values() ?? []) {
    // A tracked workspace whose run ended is Paseo work like any other again (a checkout tracked once,
    // then done); a worktree the dashboard made for a task stays that task's.
    if (run.adopted && run.claim !== "undecided" && dashboard.isLive(run) === false) continue;
    if (run.workspaceId) ids.add(run.workspaceId);
    for (const attempt of run.attempts) if (attempt.workspaceId) ids.add(attempt.workspaceId);
  }
  return ids;
}

type ProjectsActivity = RpcOutput<typeof activityRpc>["projects"];

/**
 * Each space's projects (in space.yaml order) with their Paseo project's workspaces from the
 * snapshot. Spaces map projects independently, so two of them can name the same Paseo project: with
 * `across` (the all-spaces form) a workspace already listed under an earlier space's project is left
 * out of later ones; one space alone is listed as it always was.
 */
export function projectsActivity(spaces: { record: SpaceRecord; plan: Plan }[], snapshot: ActivitySnapshot, project?: string, across = false): ProjectsActivity {
  const listed = new Set<string>();
  const once = <T extends { workspace_id: string }>(items: T[]) =>
    items.filter((item) => {
      if (!across || !item.workspace_id) return true;
      if (listed.has(item.workspace_id)) return false;
      listed.add(item.workspace_id);
      return true;
    });
  const out: ProjectsActivity = [];
  for (const { record, plan } of spaces) {
    const projects = plan.space?.projects ?? {};
    for (const key of Object.keys(projects).filter((key) => !project || key === project)) {
      const local = record.mapping[key];
      const found = local ? snapshot.byProject.get(local) : undefined;
      out.push({ space: record.key, project: key, trunk: projects[key]?.trunk ?? "", active: once(found?.active ?? []), past: once(found?.past ?? []) });
    }
  }
  return out;
}

export async function listActivity(dashboard: Dashboard, input: RpcInput<typeof activityRpc>): Promise<RpcOutput<typeof activityRpc>> {
  const fail = (error: string) => ({ projects: [], read_at: "", error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  const asked = input.space?.trim() ?? "";
  const entries = asked ? [dashboard.spaces.get(asked.toUpperCase())].filter((e) => e !== undefined) : [...dashboard.spaces.values()];
  if (asked && entries.length === 0) return fail(`No space ${asked}.`);
  let snapshot: ActivitySnapshot | undefined;
  let error = "";
  try {
    snapshot = await dashboard.activity.read();
  } catch (failure) {
    // The last answer stays on screen, with the reason it may be old.
    error = `Paseo's workspaces could not be read: ${String((failure as Error)?.message ?? failure)}`;
    snapshot = dashboard.activity.last();
    if (!snapshot) return fail(error);
  }
  return {
    projects: projectsActivity(entries.map(({ record, sync }) => ({ record, plan: sync.plan })), snapshot, input.project || undefined, !asked),
    read_at: snapshot.readAt,
    error,
  };
}
