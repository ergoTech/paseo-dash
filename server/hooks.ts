import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";

/**
 * Lifecycle hooks under the names the host knows. Paseo 0.15 renamed them and registers them with
 * `addHook`; `on` and `before` stay as deprecated aliases, "removed after 2027-04-30" in its SDK's
 * declarations. The plugin still supports Paseo from 0.13, whose hosts have only `on` and `before`, so
 * it uses `addHook` when the host has it and the old names otherwise. The SDK pinned for typechecking
 * (0.13) has no `addHook`; its shape here is the 0.15 SDK's.
 */

type EventName = Parameters<PluginLifecycleRegistration["on"]>[0];
type RequestName = Parameters<PluginLifecycleRegistration["before"]>[0];

/** The 0.15 names of the hooks, as its SDK maps the old ones. */
export const HOOK_NAMES: Record<EventName | RequestName, string> = {
  "agent.turn_started": "agent.turn.before",
  "agent.turn_ended": "agent.turn.after",
  "agent.permission_requested": "agent.permission.before",
  "agent.permission_resolved": "agent.permission.after",
  "agent.created": "agent.create.after",
  "agent.closed": "agent.close.after",
  "agent.archived": "agent.archive.after",
  "workspace.created": "workspace.create.after",
  "workspace.archived": "workspace.archive.after",
  "agent.create": "agent.create.before",
  "agent.session_open": "agent.open.before",
  "workspace.create": "workspace.create.before",
};

/** 0.15's registration: the payload is the old event (or `{ request }`), and the handler returns a promise. */
type AddHook = (name: string, handler: (payload: unknown, context: unknown) => Promise<unknown>) => () => void;

function addHookOf(server: PluginLifecycleRegistration): AddHook | undefined {
  const add = (server as { addHook?: unknown }).addHook;
  return typeof add === "function" ? (add as AddHook).bind(server) : undefined;
}

/** `server.on(name, handler)`, through `addHook` where the host has it. */
export function onHook<Name extends EventName>(server: PluginLifecycleRegistration, name: Name, handler: Parameters<typeof server.on<Name>>[1]): () => void {
  const add = addHookOf(server);
  if (!add) return server.on(name, handler);
  const call = handler as (event: unknown, context: unknown) => unknown;
  return add(HOOK_NAMES[name], async (payload, context) => {
    await call(payload, context);
  });
}

/** `server.before(name, handler)`, through `addHook` where the host has it. */
export function beforeHook<Name extends RequestName>(server: PluginLifecycleRegistration, name: Name, handler: Parameters<typeof server.before<Name>>[1]): () => void {
  const add = addHookOf(server);
  if (!add) return server.before(name, handler);
  const call = handler as (input: unknown, context: unknown) => unknown;
  return add(HOOK_NAMES[name], async (payload, context) => (await call(payload, context)) ?? undefined);
}
