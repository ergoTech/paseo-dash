import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { beforeHook, HOOK_NAMES, onHook } from "./hooks.ts";

/** A 0.15 host: `addHook` with the new names, and the deprecated `on` and `before` that must not be used. */
function newHost() {
  const added = new Map<string, (payload: unknown, context: unknown) => Promise<unknown>>();
  const old: string[] = [];
  const host = {
    addHook(name: string, handler: (payload: unknown, context: unknown) => Promise<unknown>) {
      added.set(name, handler);
      return () => added.delete(name);
    },
    on(name: string) {
      old.push(name);
      return () => {};
    },
    before(name: string) {
      old.push(name);
      return () => {};
    },
  };
  return { host: host as unknown as PluginLifecycleRegistration, added, old };
}

test("on a host with addHook, hooks register under the new names and get the same payload", async () => {
  const { host, added, old } = newHost();
  const seen: unknown[] = [];
  const off = onHook(host, "agent.turn_started", (event) => {
    seen.push(event);
  });
  beforeHook(host, "agent.session_open", ({ request }) => ({ ...request, env: { ...request.env, A: "1" } }));
  assert.deepEqual([...added.keys()], ["agent.turn.before", "agent.open.before"]);
  assert.deepEqual(old, [], "the deprecated registrations are not used");
  const event = { agent: { id: "a1" }, turnId: "t1" };
  await added.get("agent.turn.before")!(event, {});
  assert.deepEqual(seen, [event]);
  const request = { agentId: "a1", env: {} };
  assert.deepEqual(await added.get("agent.open.before")!({ request }, {}), { agentId: "a1", env: { A: "1" } });
  off();
  assert.equal(added.has("agent.turn.before"), false, "the remover is addHook's");
});

test("a before hook that changes nothing answers undefined, as addHook expects", async () => {
  const { host, added } = newHost();
  beforeHook(host, "agent.session_open", () => undefined);
  assert.equal(await added.get("agent.open.before")!({ request: {} }, {}), undefined);
});

test("on a host without addHook (Paseo 0.13, 0.14), the old registrations are used", () => {
  const names: string[] = [];
  const host = {
    on: (name: string) => (names.push(`on:${name}`), () => {}),
    before: (name: string) => (names.push(`before:${name}`), () => {}),
  } as unknown as PluginLifecycleRegistration;
  onHook(host, "agent.turn_ended", () => {});
  beforeHook(host, "agent.session_open", () => undefined);
  assert.deepEqual(names, ["on:agent.turn_ended", "before:agent.session_open"]);
});

test("the names are the 0.15 SDK's own map of the old ones", () => {
  // As `legacyEvents` and `legacyRequests` in @getpaseo/plugin 0.15.4's dist/server/lifecycle.d.ts.
  assert.deepEqual(HOOK_NAMES, {
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
  });
});
