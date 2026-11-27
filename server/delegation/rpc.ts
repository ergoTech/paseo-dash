import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  delegationAgentsRpc,
  delegationEnableRpc,
  delegationGrantRpc,
  delegationLogRpc,
  delegationReadRpc,
  delegationRevokeRpc,
  ShownDelegationEntry,
} from "../../shared/delegation.ts";
import { originOf, takesMcpServers } from "../agent-tools/plan.ts";
import type { Dashboard } from "../dashboard.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import type { DelegationStore } from "./store.ts";

/**
 * The owner's side of delegation (shared/delegation.ts): the Settings and task screens. Registered,
 * never described to God Mode, and answered only by the copy that owns the data.
 */

/** Entries the screens show. */
const SHOWN = 30;
/** Open agents asked about, newest first, and distinct working directories whose origin is read. */
const AGENTS = 100;
const DIRECTORIES = 40;

type Answer = { ok: boolean; error: string };

export interface DelegationRpcOptions {
  origin?: (cwd: string) => Promise<string | undefined>;
}

function owned(dashboard: Dashboard): DelegationStore | string {
  return dashboard.owner && dashboard.delegation ? dashboard.delegation : dashboard.ownerReason || "Paseo Dash has not started";
}

function shown(dashboard: Dashboard, store: DelegationStore, task?: string): ShownDelegationEntry[] {
  return store
    .entries(task)
    .slice(0, SHOWN)
    .map((entry) => ({
      ...entry,
      pending: Boolean(dashboard.spaces.get(entry.space)?.sync.journalEntries.some(({ op }) => op.op_id === entry.op_id)),
    }));
}

export function readDelegation(dashboard: Dashboard): RpcOutput<typeof delegationReadRpc> {
  const store = owned(dashboard);
  if (typeof store === "string") return { enabled: false, revision: 0, paused: "", grants: [], projects: [], changes: [], error: store };
  const state = store.state();
  const projects = [...dashboard.spaces.values()].flatMap(({ record, sync }) =>
    Object.keys(sync.plan.space?.projects ?? {}).map((project) => ({ space: record.key, name: record.name, project })),
  );
  return { ...state, projects, changes: shown(dashboard, store), error: "" };
}

export function readDelegationLog(dashboard: Dashboard, input: RpcInput<typeof delegationLogRpc>): RpcOutput<typeof delegationLogRpc> {
  const store = owned(dashboard);
  if (typeof store === "string") return { changes: [], error: store };
  return { changes: shown(dashboard, store, input.task.toUpperCase()), error: "" };
}

function saving(dashboard: Dashboard, change: (store: DelegationStore) => string | undefined): Answer {
  const store = owned(dashboard);
  if (typeof store === "string") return { ok: false, error: store };
  try {
    const refused = change(store);
    return { ok: !refused, error: refused ?? "" };
  } catch (error) {
    return { ok: false, error: `not saved: ${String((error as Error)?.message ?? error)}` };
  }
}

/** What was taken back counts even when saving it failed; the answer says so. */
function takingBack(answer: Answer): Answer {
  return answer.ok || !answer.error.startsWith("not saved") ? answer : { ok: false, error: `taken back until the plugin restarts, but ${answer.error}` };
}

export function enableDelegation(dashboard: Dashboard, input: RpcInput<typeof delegationEnableRpc>): Answer {
  const answer = saving(dashboard, (store) => void store.setEnabled(input.enabled));
  return input.enabled ? answer : takingBack(answer);
}

export function revokeDelegation(dashboard: Dashboard, input: RpcInput<typeof delegationRevokeRpc>): Answer {
  return takingBack(saving(dashboard, (store) => (store.revoke(input.grant, input.action) ? undefined : "no such permission")));
}

interface Candidate {
  id: string;
  title: string;
  provider: string;
  mode: string;
  cwd: string;
}

/** The open agents whose repository is this project's and whose provider takes the tools. */
async function candidates(dashboard: Dashboard, remote: string, options: DelegationRpcOptions): Promise<Candidate[]> {
  const paseo = dashboard.paseo;
  if (!paseo) throw new Error("Paseo is not connected yet; try again in a moment");
  const page = (await paseo.agents.list({
    filter: { includeArchived: false },
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: AGENTS },
  } as never)) as unknown as {
    entries: { agent: { id: string; title?: string | null; provider?: string; currentModeId?: string | null; cwd?: string; archivedAt?: string | null } }[];
  };
  const open = page.entries
    .map(({ agent }) => ({
      id: agent.id,
      title: agent.title ?? "",
      provider: agent.provider ?? "",
      mode: agent.currentModeId ?? "",
      cwd: agent.cwd ?? "",
      archived: Boolean(agent.archivedAt),
    }))
    .filter((agent) => !agent.archived && agent.cwd && takesMcpServers(agent.provider));
  const directories = [...new Set(open.map((agent) => agent.cwd))].slice(0, DIRECTORIES);
  const wanted = normalizeRemote(remote);
  const matching = new Set<string>();
  await Promise.all(
    directories.map(async (cwd) => {
      const origin = await (options.origin ?? originOf)(cwd);
      if (origin && normalizeRemote(origin) === wanted) matching.add(cwd);
    }),
  );
  return open.filter((agent) => matching.has(agent.cwd)).map(({ archived: _archived, ...agent }) => agent);
}

function projectOf(dashboard: Dashboard, space: string, project: string): { key: string; remote: string } | string {
  const found = dashboard.spaces.get(space.toUpperCase());
  if (!found) return `no space ${space}`;
  const projects = found.sync.plan.space?.projects ?? {};
  if (!Object.hasOwn(projects, project)) return `no project ${project} in ${found.record.key}`;
  return { key: found.record.key, remote: projects[project]!.remote };
}

export async function listDelegationAgents(
  dashboard: Dashboard,
  input: RpcInput<typeof delegationAgentsRpc>,
  options: DelegationRpcOptions = {},
): Promise<RpcOutput<typeof delegationAgentsRpc>> {
  const store = owned(dashboard);
  if (typeof store === "string") return { agents: [], error: store };
  const project = projectOf(dashboard, input.space, input.project);
  if (typeof project === "string") return { agents: [], error: project };
  try {
    return { agents: await candidates(dashboard, project.remote, options), error: "" };
  } catch (error) {
    return { agents: [], error: `Paseo's agents could not be read: ${String((error as Error)?.message ?? error)}` };
  }
}

const CHANGED = "the permissions changed meanwhile; look at them and save again";

/**
 * Gives a permission only to an open agent working in that project's repository, and only from the
 * rules as the screen showed them: a revocation made elsewhere in between is never undone.
 */
export async function grantDelegation(
  dashboard: Dashboard,
  input: RpcInput<typeof delegationGrantRpc>,
  options: DelegationRpcOptions = {},
): Promise<Answer> {
  const store = owned(dashboard);
  if (typeof store === "string") return { ok: false, error: store };
  const project = projectOf(dashboard, input.space, input.project);
  if (typeof project === "string") return { ok: false, error: project };
  if (store.state().revision !== input.revision) return { ok: false, error: CHANGED };
  let found: Candidate | undefined;
  try {
    found = (await candidates(dashboard, project.remote, options)).find((agent) => agent.id === input.agent);
  } catch (error) {
    return { ok: false, error: `Paseo's agents could not be read: ${String((error as Error)?.message ?? error)}` };
  }
  if (!found) return { ok: false, error: `no open agent ${input.agent} works in the repository of project ${input.project}` };
  const agent = found;
  return saving(dashboard, (own) => {
    // Asked again: Paseo and git answered slowly enough for a revocation or a disconnect.
    if (own.state().revision !== input.revision) return CHANGED;
    const still = projectOf(dashboard, project.key, input.project);
    if (typeof still === "string") return still;
    own.put({ agent: agent.id, title: agent.title, space: project.key, project: input.project, actions: input.actions });
    return undefined;
  });
}
