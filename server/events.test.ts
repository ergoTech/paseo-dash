import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./api/testing.ts";
import { startTask } from "./api/writes.ts";
import { Dashboard } from "./dashboard.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, eventOf, listEvents, markEventsRead, planFileUrl } from "./events.ts";
import { readOverview } from "./overview.ts";
import { FakeHooks, settled } from "./runner/testing.ts";

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

test("a finished turn, a failure and a permission request each make one event with the task, chat, time and reason", async () => {
  const t = await started();
  try {
    t.agent.history.push({ type: "assistant_message", text: "Login test fixed; PR is next.", turnId: "t1" });
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t1", outcome: { kind: "completed" }, timeline: [] }));
    assert.deepEqual(listEvents(t.s.dashboard, {}).events.map((e) => [e.kind, e.summary]), [["finished", ""]]);
    // The reply is read after the hook, and goes on that turn's event.
    await settled(() => listEvents(t.s.dashboard, {}).events[0]!.summary !== "", 1_000);
    await t.hooks.fire("agent.turn_started", t.event({ turnId: "t2" }));
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q1", name: "Bash", kind: "tool", detail: { type: "shell", command: "npm test" } } }));
    await t.hooks.fire("agent.permission_resolved", t.event({ requestId: "q1", resolution: { behavior: "allow" } }));
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t2", outcome: { kind: "failed", error: { message: "rate limited" } }, timeline: [] }));

    const read = listEvents(t.s.dashboard, {});
    assert.equal(read.error, "");
    assert.deepEqual(
      read.events.map((e) => [e.kind, e.task_id, e.chat_id, e.summary]),
      [
        ["finished", "TST-FX001", t.agent.id, "Login test fixed; PR is next."],
        ["needs_input", "TST-FX001", t.agent.id, "asks to run: npm test"],
        ["failed", "TST-FX001", t.agent.id, "rate limited"],
      ],
    );
    const first = read.events[0]!;
    assert.equal(first.title, "Fix flaky login test");
    assert.equal(first.space, "TST");
    assert.equal(first.status, "in_progress");
    assert.ok(!Number.isNaN(Date.parse(first.at)));
    assert.deepEqual([read.unread, read.latest, read.more], [3, 3, false]);
    // What follows the read travels with it: mark them read through the newest shown, in the space asked.
    assert.equal(read.next, "once told, mark_events_read with through 3");
    assert.equal(listEvents(t.s.dashboard, { space: "TST" }).next, 'once told, mark_events_read with through 3 and space "TST"');
    // Marking read takes every unread event up to through: never past an unread one not shown.
    assert.equal(listEvents(t.s.dashboard, { history: true, limit: 2 }).next, undefined, "history shows 3 and 2; 1 is unread and not shown");
    assert.equal(listEvents(t.s.dashboard, { after: 1 }).next, undefined, "1 is unread and not shown");
    assert.equal(listEvents(t.s.dashboard, { limit: 2 }).next, "once told, mark_events_read with through 2");
    assert.equal(listEvents(t.s.dashboard, { after: 3 }).next, undefined, "nothing shown, nothing to do");
    // A later turn's reply never goes on an earlier turn's event.
    assert.equal(t.s.dashboard.events!.fill(t.run.run_id, first.at, "Something else."), false);
    assert.equal(readOverview(t.s.dashboard, {}).counts.events, 3);
  } finally {
    t.stop();
  }
});

test("repeated checks, hooks and reconcile passes do not repeat an event; marking read is idempotent", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q1", name: "Edit", kind: "tool" } }));
    t.agent.status = "idle";
    t.agent.pendingPermissions = [{ name: "Edit", kind: "tool" }];
    // The reconcile pass sees the same request the hook did, twice over.
    await t.s.dashboard.tracker.reconcile();
    await t.s.dashboard.tracker.reconcile();
    assert.deepEqual(listEvents(t.s.dashboard, {}).events.map((e) => e.kind), ["needs_input"]);
    // Reads do not consume: asking again gives the same unread event.
    assert.equal(listEvents(t.s.dashboard, {}).events.length, 1);

    const marked = markEventsRead(t.s.dashboard, { through: 1 });
    assert.deepEqual(marked, { ok: true, marked: 1, unread: 0, error: "" });
    assert.deepEqual(markEventsRead(t.s.dashboard, { through: 1 }), { ok: true, marked: 0, unread: 0, error: "" });
    assert.deepEqual(listEvents(t.s.dashboard, {}).events, []);
    // The history still shows it, read.
    assert.deepEqual(listEvents(t.s.dashboard, { history: true }).events.map((e) => [e.id, e.unread]), [[1, false]]);
    assert.equal(markEventsRead(t.s.dashboard, { through: 1, space: "nope" }).ok, false);
  } finally {
    t.stop();
  }
});

test("events missed while the plugin was down are read after it is back, once, from a cursor", async () => {
  const t = await started();
  const dataDir = t.s.dashboard.dataDir;
  let again: Dashboard | undefined;
  try {
    t.agent.history.push({ type: "assistant_message", text: "Before the reload.", turnId: "t1" });
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t1", outcome: { kind: "completed" }, timeline: [] }));
    const cursor = listEvents(t.s.dashboard, {}).latest;
    assert.equal(cursor, 1);
    // The plugin goes away (reload, daemon restart); meanwhile the agent works again and fails.
    t.stop();
    t.agent.status = "error";
    t.agent.lastError = "context window exceeded";

    again = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000 });
    again.attach(t.s.fake.api());
    await again.start();
    await again.tracker.reconcile();
    await again.tracker.reconcile();
    const missed = listEvents(again, { after: cursor });
    assert.deepEqual(
      missed.events.map((e) => [e.id, e.kind, e.task_id, e.chat_id, e.summary]),
      [[2, "failed", "TST-FX001", t.agent.id, "context window exceeded"]],
    );
    // Nothing from before the cursor comes again, and the first event kept its id.
    assert.deepEqual(listEvents(again, {}).events.map((e) => e.id), [1, 2]);
  } finally {
    again?.stop();
  }
});

test("a run that is over: its events read as read, and its agent makes no new ones", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t1", outcome: { kind: "completed" }, timeline: [] }));
    assert.equal(listEvents(t.s.dashboard, {}).unread, 1);
    await t.s.sync().record([{ op_id: "op-release", kind: "release", id: "TST-FX001", run_id: t.run.run_id, to: "done", at: "2026-10-26T11:00:00Z" }]).outcomes;
    assert.equal(t.s.task("TST-FX001")?.status, "done");
    const read = listEvents(t.s.dashboard, {});
    assert.deepEqual([read.events.length, read.unread], [0, 0], "nothing about a finished task waits for anyone");
    assert.deepEqual(listEvents(t.s.dashboard, { history: true }).events.map((e) => [e.kind, e.unread, e.status]), [["finished", false, "done"]], "still in the history");
    assert.equal(readOverview(t.s.dashboard, {}).counts.events, 0);

    // Someone goes on talking to the agent after the task is done.
    await t.hooks.fire("agent.turn_started", t.event({ turnId: "t2" }));
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t2", outcome: { kind: "completed" }, timeline: [] }));
    assert.equal(t.run.activity, "waiting", "the activity is still followed");
    assert.equal(t.s.dashboard.events!.events.length, 1, "no new event");
  } finally {
    t.stop();
  }
});

test("a start whose claim never landed keeps its failed event; a run another one replaced is over; a task the plan lacks is not", async () => {
  const t = await started();
  try {
    const store = t.s.dashboard.runs!;
    // Another run of the same task whose claim lost: the plan never held it.
    store.put({ ...t.run, run_id: "r-lost", agentId: undefined, workspaceId: undefined, claim: "undecided", activity: "launching" });
    store.setActivity(store.runs.get("r-lost")!, "failed", "2026-10-26T11:00:00Z", { error: "The claim did not land in the plan repo; nothing was started." });
    assert.deepEqual(
      listEvents(t.s.dashboard, {}).events.map((e) => [e.kind, e.chat_id, e.unread]),
      [["failed", "", true]],
      "the only word that the start did nothing",
    );

    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t1", outcome: { kind: "completed" }, timeline: [] }));
    assert.equal(listEvents(t.s.dashboard, {}).unread, 2);
    // The plan now holds a later run of the task: the one that was held before is over.
    const plan = t.s.sync().plan;
    const loaded = plan.entities.get("TST-FX001")!;
    plan.entities.set("TST-FX001", { ...loaded, entity: { ...loaded.entity, run_id: "r-next" } as typeof loaded.entity });
    assert.deepEqual(listEvents(t.s.dashboard, {}).events.map((e) => [e.kind, e.chat_id]), [["failed", ""]], "only the lost start's failure is left");
    // A task the plan lacks (a file that does not parse) is not known to be over.
    plan.entities.delete("TST-FX001");
    assert.equal(listEvents(t.s.dashboard, {}).unread, 2);
    plan.entities.set("TST-FX001", loaded);
  } finally {
    t.stop();
  }
});

test("only changes into finished, failed, needs input or a question make events", () => {
  assert.equal(eventOf("working", "waiting"), "finished");
  assert.equal(eventOf("needs_input", "waiting"), "finished");
  assert.equal(eventOf("failed", "waiting"), undefined);
  assert.equal(eventOf("waiting", "waiting"), undefined);
  assert.equal(eventOf("working", "needs_input"), "needs_input");
  assert.equal(eventOf("working", "needs_input", "permission"), "needs_input");
  assert.equal(eventOf("working", "needs_input", "question"), "question");
  assert.equal(eventOf("needs_input", "needs_input", "question"), undefined);
  assert.equal(eventOf("needs_input", "needs_input"), undefined);
  assert.equal(eventOf("launching", "failed"), "failed");
  assert.equal(eventOf("failed", "failed"), undefined);
  assert.equal(eventOf("working", "stopped"), undefined);
  assert.equal(eventOf("waiting", "working"), undefined);
});

test("a task's link is its file on the plan repository's forge", () => {
  assert.equal(planFileUrl("git@github.com:acme/plan.git", "main", "tasks/LAC-7K3QX-totp.md"), "https://github.com/acme/plan/blob/main/tasks/LAC-7K3QX-totp.md");
  assert.equal(planFileUrl("https://gitlab.example.com/team/plan", "release/2", "tasks/a b.md"), "https://gitlab.example.com/team/plan/-/blob/release/2/tasks/a%20b.md");
  assert.equal(planFileUrl("/tmp/plan.git", "main", "tasks/x.md"), "");
  assert.equal(planFileUrl("file:///tmp/plan.git", "main", "tasks/x.md"), "");
  assert.equal(planFileUrl("git@work-alias:team/plan.git", "main", "tasks/x.md"), "");
});

test("a reply read again for the same turn replaces the summary; another turn's never lands on it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dashboard-events-")), "events.json");
  const store = new EventStore(path);
  const base = { task: "TST-FX001", space: "TST", project: "core", run_id: "r1", chat_id: "a1", workspace_id: "w1", summary: "", title: "Fix" };
  store.record({ ...base, kind: "finished", at: "2026-10-27T10:00:00.000Z" });
  assert.equal(store.fill("r1", "2026-10-27T10:00:00.000Z", "Half a reply"), true);
  assert.equal(store.fill("r1", "2026-10-27T10:00:00.000Z", "The whole reply."), true);
  assert.equal(store.fill("r1", "2026-10-27T10:05:00.000Z", "A later turn."), false);
  assert.equal(new EventStore(path).events[0]!.summary, "The whole reply.");
});
