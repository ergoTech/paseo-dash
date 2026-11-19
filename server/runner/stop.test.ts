import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../api/testing.ts";
import { archiveWorkspace, releaseTask, startTask } from "../api/writes.ts";
import { taskView } from "../views.ts";
import { settled } from "./testing.ts";
import { cliStopper } from "./stop.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

test("a release stops this Mac's agent once; archiving its workspace is a separate step", async () => {
  const stopped: string[] = [];
  const s = await setup({ profiles: [PROFILE] }, { stopAgent: async (id) => (stopped.push(id), { ok: true, error: "" }) });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity === "working");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).actions.archive, false, "a live run's workspace is its run's");
    const released = await releaseTask(s.ctx, { task: "TST-FX001", to: "canceled" });
    assert.equal(released.ok, true, released.error);
    assert.equal(released.agent, "its agent on this Mac is stopped; its chat stays");
    assert.deepEqual(stopped, [run.agentId]);
    assert.ok(run.stoppedAt);
    // The reconcile pass that sees the run over does not stop it again.
    await s.dashboard.tracker.reconcile();
    assert.deepEqual(stopped, [run.agentId]);
    assert.deepEqual(s.fake.archived, [], "nothing is archived by the release");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).actions.archive, true);
    // An earlier run that reused the same workspace: one archive, both remembered.
    const earlier = { ...run, run_id: "r-earlier", started: "2026-10-01T00:00:00.000Z", agentId: undefined };
    s.dashboard.runs!.put(earlier);
    const archived = await archiveWorkspace(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([archived.ok, archived.archived], [true, 1], archived.error);
    assert.deepEqual(s.fake.archived, [run.workspaceId]);
    assert.ok(s.dashboard.runs!.runs.get("r-earlier")!.workspaceArchivedAt);
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).actions.archive, false);
    assert.match((await archiveWorkspace(s.ctx, { task: "TST-FX001" })).error, /No workspace/);
    assert.match((await archiveWorkspace(s.ctx, { task: "TST-TASK1" })).error, /is todo; its next start may reuse the workspace/);
  } finally {
    s.stop();
  }
});

test("a release made on another machine stops this Mac's agent once the plan shows it", async () => {
  const stopped: string[] = [];
  const s = await setup({ profiles: [PROFILE] }, { stopAgent: async (id) => (stopped.push(id), { ok: false, error: "the Paseo CLI was not found" }) });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity === "working");
    // Someone else's release reaches this clone as a plan change.
    await s.sync().record([{ op_id: "op-elsewhere", kind: "release", id: "TST-FX001", run_id: run.run_id, to: "todo", at: new Date().toISOString() }]).outcomes;
    await s.dashboard.tracker.reconcile();
    await settled(() => stopped.length > 0);
    assert.deepEqual(stopped, [run.agentId], "tried once; a failure is logged, not retried on every pass");
    await s.dashboard.tracker.reconcile();
    assert.equal(stopped.length, 1);
  } finally {
    s.stop();
  }
});

test("another machine's release to done, or one made long ago, stops nothing here", async () => {
  const stopped: string[] = [];
  const s = await setup({ profiles: [PROFILE] }, { stopAgent: async (id) => (stopped.push(id), { ok: true, error: "" }) });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity === "working");
    // A release to done reads like a merge in the plan: the agent may well still be talked to.
    await s.sync().record([{ op_id: "op-done", kind: "release", id: "TST-FX001", run_id: run.run_id, to: "done", at: new Date().toISOString() }]).outcomes;
    await s.dashboard.tracker.reconcile();
    assert.deepEqual(stopped, []);

    await startTask(s.ctx, { task: "TST-TASK1", profile: "Review" });
    const old = s.dashboard.runs!.byTask("TST-TASK1")!;
    await settled(() => old.activity === "working");
    // Released long before this machine looked: history from before stops existed, not news.
    await s.sync().record([{ op_id: "op-old", kind: "release", id: "TST-TASK1", run_id: old.run_id, to: "todo", at: "2026-01-01T00:00:00Z" }]).outcomes;
    await s.dashboard.tracker.reconcile();
    assert.deepEqual(stopped, []);
    assert.ok(old.stoppedAt, "and not looked at again");
  } finally {
    s.stop();
  }
});

test("the CLI stopper tries the next place when one has no paseo, and says why it failed", async () => {
  const calls: string[] = [];
  const stop = cliStopper(async (command, args) => {
    calls.push(`${command} ${args.slice(0, 3).join(" ")}`);
    return command === "missing" ? { code: 1, stdout: "", stderr: "spawn missing ENOENT" } : { code: 0, stdout: "{}" };
  }, ["missing", "/opt/paseo"]);
  assert.deepEqual(await stop("a1"), { ok: true, error: "" });
  assert.deepEqual(calls, ["missing agent stop a1", "/opt/paseo agent stop a1"]);
  const none = cliStopper(async () => ({ code: 1, stdout: "", stderr: "spawn x ENOENT" }), ["x"]);
  assert.match((await none("a1")).error, /not found.*stop the agent in its chat/);
  const refused = cliStopper(async () => ({ code: 2, stdout: "", stderr: "Agent not found: a1\nmore" }), ["paseo"]);
  assert.equal((await refused("a1")).error, "paseo agent stop failed: Agent not found: a1");
});
