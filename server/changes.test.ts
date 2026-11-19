import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./api/testing.ts";
import { createTask, startTask, updateTask } from "./api/writes.ts";
import { changesToken } from "./changes.ts";
import { Dashboard } from "./dashboard.ts";
import { markEventsRead } from "./events.ts";
import { FakeHooks, settled } from "./runner/testing.ts";

/**
 * `dashboard.changes` (server/changes.ts): every way state gets written moves the token, and what
 * changes nothing leaves it. These run against the real plan repo fixture, so a write goes through
 * the journal, the commit and the reload a real one does.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

async function started() {
  const s = await setup({ profiles: [PROFILE] });
  const hooks = new FakeHooks(s.fake.api());
  const unhook = s.dashboard.tracker.register(hooks as never);
  await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => run.activity !== "launching");
  const agent = s.fake.agents.get(run.agentId!)!;
  const event = (extra: Record<string, unknown> = {}) => ({ agent: { id: agent.id, workspaceId: agent.workspaceId, provider: "claude", cwd: "/", parentAgentId: null, title: null }, ...extra });
  return { s, hooks, run, agent, event, stop: () => (unhook.forEach((off) => off()), s.stop()) };
}

/** Settles what a write started in the background, so a read compares finished states. */
async function quiet(s: Awaited<ReturnType<typeof setup>>) {
  for (const { sync } of s.dashboard.spaces.values()) await sync.sync();
}

test("a plan operation moves the token", async () => {
  const s = await setup();
  try {
    await quiet(s);
    let before = changesToken(s.dashboard);
    const created = await createTask(s.ctx, { title: "New one", space: "TST", project: "core" } as never);
    assert.ok(!("error" in created) || !created.error, JSON.stringify(created));
    await quiet(s);
    assert.notEqual(changesToken(s.dashboard), before, "create");

    before = changesToken(s.dashboard);
    await updateTask(s.ctx, { task: "TST-TASK1", title: "Renamed" } as never);
    await quiet(s);
    assert.notEqual(changesToken(s.dashboard), before, "update");
  } finally {
    s.stop();
  }
});

test("a commit another machine pushed moves the token once it is fetched, and a fetch of nothing does not", async () => {
  const s = await setup();
  try {
    await quiet(s);
    const before = changesToken(s.dashboard);
    await quiet(s);
    assert.equal(changesToken(s.dashboard), before, "the fetch reloaded the plan; nothing in it changed");
    s.f.external("anna", (root) => {
      const path = join(root, s.dashboard.spaces.get("TST")!.sync.plan.entities.get("TST-TASK1")!.path);
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: in_review"));
    });
    assert.equal(changesToken(s.dashboard), before, "not fetched yet");
    await quiet(s);
    assert.notEqual(changesToken(s.dashboard), before, "fetched");
  } finally {
    s.stop();
  }
});

test("a run's activity moves the token, and so does what the agent reported later", async () => {
  const t = await started();
  try {
    await quiet(t.s);
    let before = changesToken(t.s.dashboard);
    t.s.dashboard.runs!.setActivity(t.run, "needs_input", new Date().toISOString(), { waitingFor: "Bash" });
    assert.notEqual(changesToken(t.s.dashboard), before, "activity");

    before = changesToken(t.s.dashboard);
    t.run.lastMessage = "Tests pass.";
    t.s.dashboard.runs!.save();
    assert.notEqual(changesToken(t.s.dashboard), before, "last message");

    before = changesToken(t.s.dashboard);
    t.run.reportedPr = "https://github.com/acme/core/pull/1";
    t.s.dashboard.runs!.save();
    assert.notEqual(changesToken(t.s.dashboard), before, "reported PR");
  } finally {
    t.stop();
  }
});

test("a landed reading moves the token only when what it says changed", async () => {
  const t = await started();
  try {
    await quiet(t.s);
    const reading = { head: "abc", clean: true, landed: false, archived: false };
    t.run.adopted = { kind: "worktree", directory: "/w", trunk: "main", landed: { ...reading, at: "2026-11-03T10:00:00.000Z" } };
    const before = changesToken(t.s.dashboard);
    t.run.adopted.landed = { ...reading, at: "2026-11-03T10:00:10.000Z" };
    assert.equal(changesToken(t.s.dashboard), before, "only the time of the reading");
    t.run.adopted.landed = { ...reading, landed: true, at: "2026-11-03T10:00:20.000Z" };
    assert.notEqual(changesToken(t.s.dashboard), before, "it landed");
  } finally {
    t.stop();
  }
});

test("a task event moves the token: a new one, the reply filled in later, and marking it read", async () => {
  const t = await started();
  try {
    await quiet(t.s);
    let before = changesToken(t.s.dashboard);
    const stored = t.s.dashboard.events!.record({
      kind: "finished",
      task: t.run.task,
      space: t.run.space,
      project: t.run.project,
      run_id: t.run.run_id,
      chat_id: "",
      workspace_id: "",
      at: "2026-11-03T10:00:00.000Z",
      summary: "",
      title: "Fix flaky login test",
    });
    assert.notEqual(changesToken(t.s.dashboard), before, "a new event");

    before = changesToken(t.s.dashboard);
    assert.ok(t.s.dashboard.events!.fill(stored.run_id, stored.at, "Login test fixed."));
    assert.notEqual(changesToken(t.s.dashboard), before, "its reply");

    before = changesToken(t.s.dashboard);
    markEventsRead(t.s.dashboard, { through: stored.id });
    assert.notEqual(changesToken(t.s.dashboard), before, "read");
  } finally {
    t.stop();
  }
});

test("a sync problem and its end move the token; the time of a good fetch does not", async () => {
  const s = await setup();
  try {
    await quiet(s);
    const sync = s.dashboard.spaces.get("TST")!.sync;
    const before = changesToken(s.dashboard);
    sync.state.lastFetchOk = "2026-11-03T10:00:00.000Z";
    assert.equal(changesToken(s.dashboard), before, "synced at");
    sync.state.error = "fatal: could not read from remote repository";
    assert.notEqual(changesToken(s.dashboard), before, "error");
    sync.state.error = undefined;
    assert.equal(changesToken(s.dashboard), before, "back to where it was");
  } finally {
    s.stop();
  }
});

test("the token carries no run secret and no plan text, and a copy that does not own the data has one too", async () => {
  const t = await started();
  try {
    await quiet(t.s);
    const before = changesToken(t.s.dashboard);
    assert.match(before, /^[\w-]{22}$/);
    t.run.token = "another-secret";
    assert.equal(changesToken(t.s.dashboard), before);

    const other = new Dashboard({ dataDir: t.s.dashboard.dataDir });
    await other.start();
    assert.equal(other.owner, false);
    assert.match(changesToken(other), /^[\w-]{22}$/);
    assert.notEqual(changesToken(other), before);
    other.stop();
  } finally {
    t.stop();
  }
});

test("what the forge trackers saw moves the token: a PR/MR view without a plan change, an issue's state", async () => {
  const s = await setup();
  try {
    await quiet(s);
    let before = changesToken(s.dashboard);
    s.dashboard.prs.seen.set("TST-TASK1", { run_id: "r1", label: "PR #1", state: "merged", url: "https://github.com/acme/core/pull/1", note: "2 lines unticked" });
    assert.notEqual(changesToken(s.dashboard), before, "PR view");

    before = changesToken(s.dashboard);
    const issue = { state: "open" as const, closedBy: [], at: "2026-11-03T10:00:00.000Z" };
    s.dashboard.issues.seen.set("acme/core#1", issue);
    assert.notEqual(changesToken(s.dashboard), before, "issue");
    before = changesToken(s.dashboard);
    s.dashboard.issues.seen.set("acme/core#1", { ...issue, at: "2026-11-03T10:15:00.000Z" });
    assert.equal(changesToken(s.dashboard), before, "only the time it was read");
  } finally {
    s.stop();
  }
});

test("a run history that finished reading moves the token", async () => {
  const s = await setup();
  try {
    await quiet(s);
    const before = changesToken(s.dashboard);
    const sync = s.dashboard.spaces.get("TST")!.sync;
    const loaded = sync.plan.entities.get("TST-TASK1")!;
    await s.dashboard.runHistory.read(sync.gitRunner, sync.root, "TST-TASK1", loaded.path);
    assert.notEqual(changesToken(s.dashboard), before);
    const read = changesToken(s.dashboard);
    await s.dashboard.runHistory.read(sync.gitRunner, sync.root, "TST-TASK1", loaded.path);
    assert.equal(changesToken(s.dashboard), read, "the same history again comes from the cache");
  } finally {
    s.stop();
  }
});
