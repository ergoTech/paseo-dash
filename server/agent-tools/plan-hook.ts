import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import type { Dashboard } from "../dashboard.ts";
import type { PaseoApi } from "../paseo.ts";
import { delegationMayApply } from "../delegation/store.ts";
import { planToolsOn } from "../plan-tools-settings.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { originOf, PLAN_SERVER, scopeOf, takesMcpServers } from "./plan.ts";

/** The coordinator tools' MCP server name in the agent. */
export const COORDINATOR_SERVER = "dashboard_coordinator";

/**
 * The `agent.session_open` hook that gives an agent the plan tools (server/agent-tools/plan.ts), and
 * a coordinator the coordinator tools (server/delegation/tools.ts) while it holds a permission for
 * its repository's project.
 * Paseo runs it at every open of every agent's session (create, resume, refresh, import), and an
 * error here would fail that open, so it never throws and gives up quietly after OPEN_WAIT_MS.
 *
 * Launch-only: the server is not saved with the agent, so turning the switch off or removing the
 * plugin leaves nothing behind in agents' configurations. Paseo 0.14 sends `mcpServers` in the
 * request and takes them back; an older daemon sends none, and then nothing is added.
 */

type SessionOpen = PluginBeforeRequests["agent.session_open"] & { mcpServers?: Record<string, McpServerConfig> };

type Hooked = Pick<Dashboard, "dataDir" | "owner" | "bridge" | "planCallers" | "coordinatorCallers" | "delegation" | "spaces" | "attach" | "start">;

/** How long an open waits for the plan before it goes on without the tools. */
export const OPEN_WAIT_MS = 4_000;

export interface PlanHookOptions {
  origin?: (cwd: string) => Promise<string | undefined>;
  waitMs?: number;
  log?: (message: string) => void;
}

export async function openPlanTools(
  dashboard: Hooked,
  request: SessionOpen,
  paseo: PaseoApi | undefined,
  options: PlanHookOptions = {},
): Promise<SessionOpen | undefined> {
  try {
    if (request.purpose !== "interactive" || !request.mcpServers || !takesMcpServers(request.provider)) return undefined;
    const plan = planToolsOn(dashboard.dataDir);
    if (!plan && !delegationMayApply(dashboard.dataDir, request.agentId)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), options.waitMs ?? OPEN_WAIT_MS)));
    const work = (async () => {
      if (paseo) dashboard.attach(paseo);
      await dashboard.start();
      const bridge = dashboard.bridge;
      // Only the copy that owns the data answers the tools, and only it adds them: two installed
      // copies adding the same server would fail the open.
      if (!dashboard.owner || !bridge) return undefined;
      const remote = await (options.origin ?? originOf)(request.cwd);
      if (!remote) return undefined;
      const servers: Record<string, McpServerConfig> = {};
      if (plan && scopeOf(dashboard, remote).length > 0) {
        servers[PLAN_SERVER] = bridge.forPlan(dashboard.planCallers.mint(request.agentId, request.cwd, remote));
      }
      const grant = dashboard.delegation?.grantOf(request.agentId);
      const granted = grant ? dashboard.spaces.get(grant.space)?.sync.plan.space?.projects[grant.project] : undefined;
      if (granted && normalizeRemote(granted.remote) === normalizeRemote(remote)) {
        servers[COORDINATOR_SERVER] = bridge.forCoordinator(dashboard.coordinatorCallers.mint(request.agentId, request.cwd, remote));
      }
      return Object.keys(servers).length ? { ...request, mcpServers: { ...request.mcpServers, ...servers } } : undefined;
    })();
    work.catch(() => undefined);
    return await Promise.race([work, late]).finally(() => clearTimeout(timer));
  } catch (error) {
    options.log?.(`plan tools not given to agent ${request.agentId}: ${(error as Error)?.message ?? error}`);
    return undefined;
  }
}
