import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import type { Dashboard } from "../dashboard.ts";
import type { PaseoApi } from "../paseo.ts";
import { planToolsOn } from "../plan-tools-settings.ts";
import { originOf, PLAN_SERVER, scopeOf, takesMcpServers } from "./plan.ts";

/**
 * The `agent.session_open` hook that gives an agent the plan tools (server/agent-tools/plan.ts).
 * Paseo runs it at every open of every agent's session (create, resume, refresh, import), and an
 * error here would fail that open, so it never throws and gives up quietly after OPEN_WAIT_MS.
 *
 * Launch-only: the server is not saved with the agent, so turning the switch off or removing the
 * plugin leaves nothing behind in agents' configurations. Paseo 0.14 sends `mcpServers` in the
 * request and takes them back; an older daemon sends none, and then nothing is added.
 */

type SessionOpen = PluginBeforeRequests["agent.session_open"] & { mcpServers?: Record<string, McpServerConfig> };

type Hooked = Pick<Dashboard, "dataDir" | "owner" | "bridge" | "planCallers" | "spaces" | "attach" | "start">;

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
    if (!planToolsOn(dashboard.dataDir)) return undefined;
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
      if (!remote || scopeOf(dashboard, remote).length === 0) return undefined;
      const token = dashboard.planCallers.mint(request.agentId, request.cwd, remote);
      return { ...request, mcpServers: { ...request.mcpServers, [PLAN_SERVER]: bridge.forPlan(token) } };
    })();
    work.catch(() => undefined);
    return await Promise.race([work, late]).finally(() => clearTimeout(timer));
  } catch (error) {
    options.log?.(`plan tools not given to agent ${request.agentId}: ${(error as Error)?.message ?? error}`);
    return undefined;
  }
}
