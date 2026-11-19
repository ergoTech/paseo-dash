import { test } from "node:test";
import assert from "node:assert/strict";
import { getTask } from "../api/reads.ts";
import { setup } from "../api/testing.ts";
import { startTask } from "../api/writes.ts";
import { readOverview } from "../overview.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHooks, settled } from "../runner/testing.ts";
import { activityOf, describeRequest } from "./tracker.ts";
import { listEvents } from "../events.ts";
import { taskCodeMap, taskView } from "../views.ts";
import { readBoard } from "../api/reads.ts";
import { readMap } from "../map/read.ts";
import { glyphFor } from "../map/read.ts";
import type { Task } from "../../shared/model.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

async function started(extra: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ profiles: [PROFILE], ...extra });
  const hooks = new FakeHooks(s.fake.api());
  const unhook = s.dashboard.tracker.register(hooks as never);
  await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => run.activity !== "launching");
  const agent = s.fake.agents.get(run.agentId!)!;
  const event = (extra: Record<string, unknown> = {}) => ({ agent: { id: agent.id, workspaceId: agent.workspaceId, provider: "claude", cwd: "/", parentAgentId: null, title: null }, ...extra });
  return { s, hooks, run, agent, event, stop: () => (unhook.forEach((off) => off()), s.stop()) };
}

test("lifecycle hooks move this machine's run between working, needs input, waiting, failed and stopped", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q1", name: "Bash", kind: "tool", title: "Run npm test -- totp" } }));
    assert.deepEqual([t.run.activity, t.run.waitingFor], ["needs_input", "Run npm test -- totp"]);
    const overview = readOverview(t.s.dashboard, {});
    assert.deepEqual(overview.needs_you, [{ task: "TST-FX001", title: "Fix flaky login test", why: "Run npm test -- totp", next: "answer it in the agent's chat", chat_id: t.agent.id, kind: "permission", space: "TST", since: t.run.activityAt }]);
    assert.equal(overview.counts.needs_you, 1);
    assert.equal(getTask(t.s.ctx, { task: "TST-FX001" }).activity, "needs your answer on this Mac: Run npm test -- totp");

    await t.hooks.fire("agent.permission_resolved", t.event({ requestId: "q1", resolution: { behavior: "allow" } }));
    assert.equal(t.run.activity, "working");
    assert.equal(t.run.waitingFor, undefined);

    t.agent.history.push({ type: "assistant_message", text: "Old reply." }, { type: "user_message", text: "Go on" }, { type: "assistant_message", text: "Enroll and verify are done." }, { type: "assistant_message", text: "Recovery codes next." });
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: null, outcome: { kind: "completed" }, timeline: [] }));
    assert.equal(t.run.activity, "waiting");
    await settled(() => Boolean(t.run.lastMessage), 1_000);
    assert.equal(t.run.lastMessage, "Enroll and verify are done.\nRecovery codes next.");
    assert.equal(getTask(t.s.ctx, { task: "TST-FX001" }).last_message, "Enroll and verify are done.\nRecovery codes next.");
    // The agent ended its turn while the task is in progress: it waits for the user, often with a question.
    assert.deepEqual(
      readOverview(t.s.dashboard, {}).needs_you.map((n) => [n.kind, n.why]),
      [["answer", "the agent waits: Enroll and verify are done. Recovery codes next."]],
    );
    // The map and the lists mark it as waiting for the person, as Needs you lists it.
    const mark = () => glyphFor(t.s.dashboard, t.s.sync().plan, t.s.task("TST-FX001") as Task);
    assert.equal(mark(), "needs_you");

    await t.hooks.fire("agent.turn_ended", t.event({ turnId: null, outcome: { kind: "failed", error: { message: "rate limited" } }, timeline: [] }));
    assert.deepEqual([t.run.activity, t.run.error], ["failed", "rate limited"]);
    await t.hooks.fire("agent.turn_started", t.event({ turnId: "t2" }));
    assert.equal(t.run.activity, "working");
    assert.equal(mark(), "working");
    await t.hooks.fire("agent.archived", t.event({ archivedAt: "2026-10-26T11:00:00Z" }));
    assert.equal(t.run.activity, "stopped");
    assert.equal(mark(), "needs_you", "an agent gone while the task is open waits for the person");
    assert.equal(readOverview(t.s.dashboard, {}).running.find((r) => r.task === "TST-FX001")?.activity, "stopped", "not reported as failed");
    // A tracked trunk checkout's agent ending is its normal end: not a mark of trouble.
    t.run.adopted = { trunk: "main" } as typeof t.run.adopted;
    assert.equal(mark(), "elsewhere");
  } finally {
    t.stop();
  }
});

const QUESTIONS = {
  questions: [
    { header: "Release", question: "Ship it today?", options: [{ label: "Yes (Recommended)" }, { label: "No" }] },
    { header: "Daemon", question: "Restart the daemon?", options: [{ label: "Now" }, { label: "Later" }] },
  ],
};

test("an agent's questions read as question in needs you and events, apart from its permissions", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q1", name: "AskUserQuestion", kind: "question", title: "Question", input: QUESTIONS } }));
    assert.deepEqual([t.run.activity, t.run.waitingFor, t.run.waitingKind], ["needs_input", "2 questions: Release, Daemon", "question"]);
    assert.deepEqual(
      readOverview(t.s.dashboard, {}).needs_you.map((n) => [n.kind, n.why]),
      [["question", "2 questions: Release, Daemon"]],
    );
    await t.hooks.fire("agent.permission_resolved", t.event({ requestId: "q1", resolution: { behavior: "allow" } }));
    assert.deepEqual([t.run.activity, t.run.waitingKind], ["working", undefined]);
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q2", name: "Bash", kind: "tool", detail: { type: "shell", command: "npm test" } } }));
    assert.deepEqual(readOverview(t.s.dashboard, {}).needs_you.map((n) => n.kind), ["permission"]);
    assert.deepEqual(
      listEvents(t.s.dashboard, {}).events.map((e) => [e.kind, e.summary]),
      [
        ["question", "2 questions: Release, Daemon"],
        ["needs_input", "asks to run: npm test"],
      ],
    );
  } finally {
    t.stop();
  }
});

test("hooks of agents this plugin did not start change nothing; an archived workspace stops its run", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.permission_requested", { agent: { id: "someone-elses-agent" }, request: { id: "q", name: "Bash", kind: "tool" } });
    assert.equal(t.run.activity, "working");
    await t.hooks.fire("workspace.archived", { workspace: { id: t.agent.workspaceId, projectId: "prj_core", cwd: "/", name: null, archivedAt: "x" } });
    assert.equal(t.run.activity, "stopped");
  } finally {
    t.stop();
  }
});

test("reconciliation reads missed changes from the agents' own snapshots", async () => {
  const t = await started();
  try {
    t.agent.status = "idle";
    t.agent.pendingPermissions = [{ name: "Edit", kind: "tool" }];
    await t.s.dashboard.tracker.reconcile();
    assert.deepEqual([t.run.activity, t.run.waitingFor], ["needs_input", "Edit"]);
    // A question asked while the plugin was away is told apart from the permission it replaces.
    t.agent.pendingPermissions = [{ name: "request_user_input", kind: "question", input: { questions: [QUESTIONS.questions[0]] } }];
    await t.s.dashboard.tracker.reconcile();
    assert.deepEqual([t.run.activity, t.run.waitingFor, t.run.waitingKind], ["needs_input", "Release: Ship it today?", "question"]);
    t.agent.pendingPermissions = [];
    // As live: a prompt sent by another agent is no user message, but the turn ids tell the replies apart.
    t.agent.history.push({ type: "assistant_message", text: "Earlier turn.", turnId: "t1" }, { type: "tool_call", turnId: "t2" }, { type: "assistant_message", text: "Done for now.", turnId: "t2" });
    await t.s.dashboard.tracker.reconcile();
    assert.deepEqual([t.run.activity, t.run.lastMessage], ["waiting", "Done for now."]);
    t.agent.gone = true;
    await t.s.dashboard.tracker.reconcile();
    assert.equal(t.run.activity, "stopped");
  } finally {
    t.stop();
  }
});

test("snapshots and permission requests read as activities and short reasons", () => {
  assert.deepEqual(activityOf({ status: "error", lastError: "quota" }), { activity: "failed", error: "quota" });
  assert.deepEqual(activityOf({ status: "running", archivedAt: "x" }), { activity: "stopped" });
  assert.equal(describeRequest({ title: `a\n${"b".repeat(300)}` }).length, 200);
  assert.equal(describeRequest({ name: "Bash", kind: "tool", detail: { type: "shell", command: "git status --short" } }), "asks to run: git status --short");
  assert.equal(describeRequest({ name: "Edit", kind: "tool", input: { description: "Fix the parser" } }), "Edit: Fix the parser");
  assert.equal(describeRequest({ name: "AskUserQuestion", kind: "question", input: QUESTIONS }), "2 questions: Release, Daemon");
  // Questions only count on a question request; one without them is worded as any other request.
  assert.equal(describeRequest({ name: "Edit", kind: "tool", title: "Edit a.ts", input: QUESTIONS }), "Edit a.ts");
  assert.equal(describeRequest({ name: "AskUserQuestion", kind: "question", title: "Question", input: { questions: [] } }), "Question");
  assert.deepEqual(activityOf({ status: "running", pendingPermissions: [{ name: "AskUserQuestion", kind: "question", input: QUESTIONS }] }), {
    activity: "needs_input",
    waitingFor: "2 questions: Release, Daemon",
    waitingKind: "question",
  });
  assert.equal(activityOf({ status: "running", pendingPermissions: [{ name: "Edit", kind: "tool" }] }).waitingKind, "permission");
});

test("a reconcile pass that read before a hook does not write its older snapshot over the hook", async () => {
  let release: () => void = () => undefined;
  let holding = false;
  const t = await started({
    beforeAgentRefresh: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
  });
  try {
    holding = true;
    const pass = t.s.dashboard.tracker.reconcile();
    await t.hooks.fire("agent.permission_requested", t.event({ request: { id: "q", name: "Bash", kind: "tool", detail: { type: "shell", command: "rm -rf build" } } }));
    holding = false;
    release();
    await pass;
    assert.deepEqual([t.run.activity, t.run.waitingFor], ["needs_input", "asks to run: rm -rf build"]);
  } finally {
    t.stop();
  }
});

test("a failed turn stays failed while the agent idles, until its next turn starts, which also clears the old reply", async () => {
  const t = await started();
  try {
    t.agent.history.push({ type: "assistant_message", text: "Half done.", turnId: "t1" });
    await t.hooks.fire("agent.turn_ended", t.event({ turnId: "t1", outcome: { kind: "failed", error: { message: "rate limited" } }, timeline: [] }));
    t.agent.status = "idle";
    await t.s.dashboard.tracker.reconcile();
    assert.deepEqual([t.run.activity, t.run.error], ["failed", "rate limited"]);
    await settled(() => Boolean(t.run.lastMessage), 1_000);
    await t.hooks.fire("agent.turn_started", t.event({ turnId: "t2" }));
    assert.deepEqual([t.run.activity, t.run.lastMessage], ["working", undefined]);
  } finally {
    t.stop();
  }
});

test("a start that failed on a stray branch keeps its reason when Paseo reports the workspace archived", async () => {
  const s = await setup({ profiles: [PROFILE], actualBranch: (b) => `${b}-1` });
  const hooks = new FakeHooks(s.fake.api());
  const unhook = s.dashboard.tracker.register(hooks as never);
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    await hooks.fire("workspace.archived", { workspace: { id: s.fake.archived[0], projectId: "prj_core", cwd: "/", name: null, archivedAt: "x" } });
    assert.equal(run.activity, "failed");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).activity, /instead of feat\/login/);
  } finally {
    unhook.forEach((off) => off());
    s.stop();
  }
});

test("a run the plan no longer holds is not reconciled", async () => {
  const t = await started();
  try {
    t.s.f.external("anna", (root) => {
      const path = `${root}/tasks/TST-FX001-fix-flaky-login-test.md`;
      writeFileSync(path, readFileSync(path, "utf8").replace(/run_id: .*\n/, "run_id: r-someone-else\n"));
    });
    await t.s.sync().sync();
    t.agent.status = "idle";
    await t.s.dashboard.tracker.reconcile();
    assert.equal(t.run.activity, "working", "left as it was");
  } finally {
    t.stop();
  }
});

test("needs you: one item per task, most urgent kind first, and a space's changes that cannot be pushed", async () => {
  const t = await started();
  try {
    const kinds = () => readOverview(t.s.dashboard, {}).needs_you.map((n) => [n.kind, n.task, n.why]);
    const run = t.run;
    const store = t.s.dashboard.runs!;
    const live = () => t.s.task("TST-FX001")!;

    store.setActivity(run, "failed", "2026-10-26T10:00:00Z", { error: "the turn failed:\n  rate limited" });
    assert.deepEqual(kinds(), [["failed", "TST-FX001", "the turn failed: rate limited"]], "a reason is one line");
    store.setActivity(run, "stopped", "2026-10-26T10:01:00Z");
    assert.deepEqual(kinds(), [["stopped", "TST-FX001", "its agent is gone while the task is still open"]]);
    // A tracked checkout on the trunk ends with its workspace archived: not a gone agent, nor a
    // failure, yet only the user moves its task on, by whether its work landed.
    run.adopted = { kind: "checkout", trunk: "main" } as never;
    assert.deepEqual(kinds(), [["checkout", "TST-FX001", "its agent is gone, a tracked checkout's normal end; not checked yet whether it landed on origin/main"]]);
    run.adopted = undefined;
    // A closed PR/MR while the agent still works on the task is not yet the user's to decide.
    store.setActivity(run, "working", "2026-10-26T10:01:30Z");
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#6", state: "closed", url: "https://github.com/acme/core/pull/6", note: "closed without a merge" });
    assert.deepEqual(kinds(), []);
    store.setActivity(run, "waiting", "2026-10-26T10:01:40Z", { lastMessage: "Two questions:\n1. keep the old API?\n2. which release?" });
    assert.deepEqual(kinds(), [["answer", "TST-FX001", "the agent waits: Two questions: 1. keep the old API? 2. which release?"]], "the agent's questions come before the closed PR/MR");
    t.s.dashboard.prs.seen.delete("TST-FX001");

    // In review without a PR/MR: the user accepts or sends it back; an agent between turns is not asked about.
    await t.s.sync().record([{ op_id: "op-review", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:02:00Z" }]).outcomes;
    assert.equal(live().status, "review");
    assert.deepEqual(kinds(), [["accept", "TST-FX001", "the agent reported the work done without a PR/MR: accept it or send it back"]]);
    run.reportedPr = "https://github.com/acme/core/pull/7";
    assert.deepEqual(kinds(), [["accept", "TST-FX001", "the agent reported https://github.com/acme/core/pull/7; its state is not known yet (is gh or glab logged in here?)"]]);
    // An open PR/MR waits for its merge on the forge: under review, not needs you.
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url: "https://github.com/acme/core/pull/7" });
    assert.deepEqual(kinds(), []);
    const MERGED = "merged with 1 acceptance line not ticked; archive the run's workspace or mark the task done when the work is complete";
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "merged", url: "https://github.com/acme/core/pull/7", note: MERGED });
    assert.deepEqual(kinds(), [["merged", "TST-FX001", `#7 ${MERGED}`]]);
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "closed", url: "https://github.com/acme/core/pull/7", note: "closed without a merge; the task stays where it is" });
    assert.deepEqual(kinds(), [["closed", "TST-FX001", "#7 closed without a merge; the task stays where it is"]]);
    // A permission request still comes first for the same task.
    store.setActivity(run, "needs_input", "2026-10-26T10:03:00Z", { waitingFor: "asks to run: npm test" });
    assert.deepEqual(kinds(), [["permission", "TST-FX001", "asks to run: npm test"]]);
    // The run's own merge says more than an agent that waits or is gone after it; a closed one more than a gone agent.
    await t.s.sync().record([{ op_id: "op-back", kind: "transition", id: "TST-FX001", to: "in_progress", run_id: run.run_id, at: "2026-10-26T10:02:30Z" }]).outcomes;
    assert.equal(live().status, "in_progress");
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "merged", url: "https://github.com/acme/core/pull/7", note: MERGED });
    store.setActivity(run, "waiting", "2026-10-26T10:02:40Z", { lastMessage: "Done; one line needs a live check." });
    assert.deepEqual(kinds(), [["merged", "TST-FX001", `#7 ${MERGED}`]]);
    store.setActivity(run, "stopped", "2026-10-26T10:02:50Z");
    assert.deepEqual(kinds(), [["merged", "TST-FX001", `#7 ${MERGED}`]], "a merged PR, not «its agent is gone»");
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "closed", url: "https://github.com/acme/core/pull/7", note: "closed without a merge; the task stays where it is" });
    assert.deepEqual(kinds(), [["closed", "TST-FX001", "#7 closed without a merge; the task stays where it is"]]);
    await t.s.sync().record([{ op_id: "op-review-again", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:02:55Z" }]).outcomes;
    assert.equal(live().status, "review");
    store.setActivity(run, "needs_input", "2026-10-26T10:03:00Z", { waitingFor: "asks to run: npm test" });
    assert.deepEqual(kinds(), [["permission", "TST-FX001", "asks to run: npm test"]]);
    // A PR/MR seen for an earlier run is not this run's.
    store.setActivity(run, "working", "2026-10-26T10:04:00Z");
    run.reportedPr = undefined;
    t.s.dashboard.prs.seen.set("TST-FX001", { run_id: "r-old", label: "#3", state: "merged", url: "https://github.com/acme/core/pull/3" });
    assert.deepEqual(kinds(), [["accept", "TST-FX001", "the agent reported the work done without a PR/MR: accept it or send it back"]]);

    // A failed fetch alone heals by itself; changes that cannot be pushed need the user, before the task.
    const state = t.s.sync().state;
    state.conflicts.push({ op_id: "op-x", kind: "set", id: "TST-FX001", reason: "someone changed the title meanwhile", at: "2026-10-26T10:05:00Z" });
    state.error = "git fetch: connection refused";
    state.pending = 0;
    assert.deepEqual(kinds().map((k) => k[0]), ["accept"], "a conflict is counted under spaces, a fetch error alone is not listed");
    state.pending = 2;
    const overview = readOverview(t.s.dashboard, {});
    assert.deepEqual(
      overview.needs_you.map((n) => [n.kind, n.task, n.space, n.title, n.why]),
      [
        ["sync", "", "TST", "Test space", "2 changes not pushed: git fetch: connection refused"],
        ["accept", "TST-FX001", "TST", "Fix flaky login test", "the agent reported the work done without a PR/MR: accept it or send it back"],
      ],
    );
    assert.deepEqual([overview.counts.needs_you, overview.spaces[0]?.needs_you, overview.spaces[0]?.conflicts], [2, 2, 1]);
    state.conflicts.length = 0;
    state.error = undefined;
    state.pending = 0;
  } finally {
    t.stop();
  }
});

test("needs you: the oldest first within a kind, and counts beyond the excerpt of ten", async () => {
  const t = await started();
  try {
    const store = t.s.dashboard.runs!;
    // Twelve tasks of this space, each with this machine's run waiting for a permission.
    const plan = t.s.sync().plan;
    const base = plan.entities.get("TST-FX001")!;
    for (let i = 0; i < 12; i++) {
      const id = `TST-W${String(i).padStart(4, "0")}`;
      plan.entities.set(id, { ...base, entity: { ...base.entity, id, title: `Waiting ${i}`, run_id: `r-w${i}` } as typeof base.entity });
      store.put({ ...t.run, run_id: `r-w${i}`, task: id, agentId: `a-w${i}`, activity: "needs_input", activityAt: `2026-10-26T11:${String(59 - i).padStart(2, "0")}:00Z`, waitingFor: `ask ${i}` });
    }
    const overview = readOverview(t.s.dashboard, {});
    assert.equal(overview.needs_you.length, 10, "an excerpt");
    assert.equal(overview.counts.needs_you, 12);
    assert.equal(overview.spaces[0]?.needs_you, 12, "the space's own count, not the excerpt's");
    assert.deepEqual(overview.needs_you.slice(0, 2).map((n) => n.task), ["TST-W0011", "TST-W0010"], "the one waiting longest first");
  } finally {
    t.stop();
  }
});

test("a started turn follows the agent's timeline: the task screen shows its latest call and the files it changed", async () => {
  const t = await started();
  try {
    await t.hooks.fire("agent.turn_started", t.event({ turnId: "turn-1" }));
    await settled(() => t.s.fake.subscribers.has(t.agent.id));
    const send = t.s.fake.subscribers.get(t.agent.id)!;
    const item = (status: string) => ({ type: "tool_call", callId: "c1", name: "apply_patch", status, detail: { type: "edit", filePath: "src/login.ts" }, error: null });
    // Later than any git read of the test, so the edit counts whatever git answers in the fake cwd.
    const start = Date.now() + 3_600_000;
    send({ agentId: t.agent.id, event: { type: "timeline", provider: "codex", item: item("running"), timestamp: new Date(start).toISOString() } });
    send({ agentId: t.agent.id, event: { type: "timeline", provider: "codex", item: item("completed"), timestamp: new Date(start + 18).toISOString() } });
    const live = taskView(t.s.dashboard, { task: "TST-FX001" }).run?.live;
    assert.deepEqual(live?.now, { op: "edit", target: "src/login.ts", status: "completed", at: new Date(start).toISOString() });
    assert.deepEqual(live?.changed, ["src/login.ts"]);
    assert.equal(live?.more, 0);
    // The board's card and the map's station show the same latest call.
    const expected = { op: "edit", target: "src/login.ts", at: new Date(start).toISOString() };
    const board = await readBoard(t.s.ctx, {});
    const card = board.columns.flatMap((c) => c.tasks).find((c) => c.id === "TST-FX001");
    assert.deepEqual(card?.live, expected);
    const map = readMap(t.s.dashboard, { space: "TST" });
    const station = map.stations.flatMap((s) => s.tasks).find((task) => task.id === "TST-FX001");
    assert.deepEqual(station?.live, expected);
    // A task without a followed run has none.
    assert.ok(board.columns.flatMap((c) => c.tasks).filter((c) => c.id !== "TST-FX001").every((c) => c.live === undefined));
  } finally {
    t.stop();
  }
});

test("a started run is followed from its agent's creation, before any hook, since its first turn starts with it", async () => {
  const t = await started();
  try {
    await settled(() => t.s.fake.subscribers.has(t.agent.id));
    assert.ok(t.s.dashboard.follower.isFollowing(t.run.run_id));
  } finally {
    t.stop();
  }
});

test("a reconcile pass follows a run's agent that no hook announced (after a reload), and drops it once stopped", async () => {
  const t = await started();
  try {
    t.agent.status = "idle";
    await t.s.dashboard.tracker.reconcile();
    await settled(() => t.s.fake.subscribers.has(t.agent.id));
    assert.ok(t.s.dashboard.follower.isFollowing(t.run.run_id));
    t.agent.archivedAt = "2026-11-13T15:00:00.000Z";
    await t.s.dashboard.tracker.reconcile();
    assert.equal(t.s.dashboard.follower.isFollowing(t.run.run_id), false);
    assert.equal(t.s.fake.subscribers.has(t.agent.id), false);
  } finally {
    t.stop();
  }
});

test("two runs of one project that change the same file show each other on the task screen, the board, the map and tasks.get", async () => {
  const t = await started();
  try {
    await settled(() => t.s.fake.subscribers.has(t.agent.id));
    // A second run of the same Paseo project, as another started task would have.
    const second = { ...t.run, run_id: "r-second", task: "TST-DEP01", agentId: "agent-second", attempts: [] } as typeof t.run;
    t.s.dashboard.runs!.runs.set(second.run_id, second);
    // Its task holds it as its live run, as a start's claim would have written. Said through isLive,
    // not by editing the loaded plan in memory: a background sync may replace that plan at any time.
    const isLive = t.s.dashboard.isLive.bind(t.s.dashboard);
    t.s.dashboard.isLive = (run) => (run.run_id === "r-second" ? true : isLive(run));
    await t.s.dashboard.follower.follow(second, "/");
    const edit = (callId: string) => ({ type: "tool_call", callId, name: "Edit", status: "completed", detail: { type: "edit", filePath: "/src/login.ts" }, error: null });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    t.s.fake.subscribers.get(t.agent.id)!({ agentId: t.agent.id, event: { type: "timeline", provider: "claude", item: edit("c1"), timestamp: later } });
    t.s.fake.subscribers.get("agent-second")!({ agentId: "agent-second", event: { type: "timeline", provider: "claude", item: edit("c2"), timestamp: later } });
    const expected = [{ task: "TST-DEP01", files: ["src/login.ts"], more: 0 }];
    assert.deepEqual(taskView(t.s.dashboard, { task: "TST-FX001" }).run?.live?.overlaps, expected);
    const board = await readBoard(t.s.ctx, {});
    assert.deepEqual(board.columns.flatMap((c) => c.tasks).find((c) => c.id === "TST-FX001")?.overlaps, expected);
    const map = readMap(t.s.dashboard, { space: "TST" });
    assert.deepEqual(map.stations.flatMap((s) => s.tasks).find((task) => task.id === "TST-FX001")?.overlaps, expected);
    assert.equal(getTask(t.s.ctx, { task: "TST-FX001" }).shares_files_with, "TST-DEP01: login.ts");
    assert.equal(getTask(t.s.ctx, { task: "TST-ST001" }).shares_files_with, undefined);
  } finally {
    t.stop();
  }
});

test("task.codemap draws the run's files from its checkout: the edited file, what it imports, and only files inside", async () => {
  const t = await started();
  const repo = mkdtempSync(join(tmpdir(), "dashboard-codemap-"));
  const outside = mkdtempSync(join(tmpdir(), "dashboard-codemap-outside-"));
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), 'export const a = 1;\n');
    writeFileSync(join(repo, "src/b.ts"), "export const b = 2;\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "src/a.ts"), 'import { b } from "./b";\nimport { s } from "./secret";\nimport { big } from "./big";\nexport const a = b;\n');
    // A link out of the checkout is not followed, and a file over the size limit is not read.
    writeFileSync(join(outside, "secret.ts"), 'import { x } from "./x";\n');
    symlinkSync(join(outside, "secret.ts"), join(repo, "src/secret.ts"));
    writeFileSync(join(repo, "src/big.ts"), `import { b } from "./b";\n${"// padding\n".repeat(30_000)}`);
    const follower = t.s.dashboard.follower;
    follower.unfollow(t.run.run_id);
    await follower.follow(t.run, repo);
    const send = t.s.fake.subscribers.get(t.agent.id)!;
    send({ agentId: t.agent.id, event: { type: "timeline", provider: "claude", item: { type: "tool_call", callId: "c1", name: "Read", status: "completed", detail: { type: "read", filePath: join(repo, "../outside.ts") }, error: null }, timestamp: new Date(Date.now() + 1000).toISOString() } });
    const map = taskCodeMap(t.s.dashboard, { task: "TST-FX001" });
    assert.equal(map.error, "");
    assert.equal(map.followed, true);
    const nodes = new Map(map.nodes.map((n) => [n.path, n]));
    assert.deepEqual(nodes.get("src/a.ts")?.imports, ["src/b.ts", "src/big.ts", "src/secret.ts"]);
    assert.equal(nodes.get("src/b.ts")?.state, "linked");
    // The link is a new file of the run, but what it points to outside the checkout is not read.
    assert.deepEqual(nodes.get("src/secret.ts")?.imports, []);
    assert.ok(!nodes.has("src/x.ts") && ![...nodes.keys()].some((p) => p.includes("outside")));
    // Over the size limit: listed, its imports not read.
    assert.deepEqual(nodes.get("src/big.ts")?.imports, []);
    assert.deepEqual(taskCodeMap(t.s.dashboard, { task: "TST-ST001" }), { followed: false, nodes: [], more: 0, error: "" });
  } finally {
    t.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("on a host with addHook the tracker's hooks are registered there, under the new names, and still move the run", async () => {
  const s = await setup({ profiles: [PROFILE] });
  const added = new Map<string, (payload: unknown, context: unknown) => Promise<unknown>>();
  const host = {
    addHook: (name: string, handler: (payload: unknown, context: unknown) => Promise<unknown>) => (added.set(name, handler), () => added.delete(name)),
    on: () => assert.fail("the deprecated on is not used"),
    before: () => assert.fail("the deprecated before is not used"),
  };
  const unhook = s.dashboard.tracker.register(host as never);
  try {
    assert.deepEqual([...added.keys()].sort(), [
      "agent.archive.after",
      "agent.close.after",
      "agent.permission.after",
      "agent.permission.before",
      "agent.turn.after",
      "agent.turn.before",
      "workspace.archive.after",
    ]);
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const agent = { id: run.agentId!, workspaceId: run.workspaceId, provider: "claude", cwd: "/", parentAgentId: null, title: null };
    await added.get("agent.permission.before")!({ agent, request: { id: "q1", name: "Bash", kind: "tool", title: "Run tests" } }, { paseo: s.fake.api() });
    assert.deepEqual([run.activity, run.waitingFor], ["needs_input", "Run tests"]);
  } finally {
    unhook.forEach((off) => off());
    s.stop();
  }
});
