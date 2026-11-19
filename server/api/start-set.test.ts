import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeGodModeSettings } from "../godmode-settings.ts";
import { readAutopilot } from "../queue.ts";
import { settled } from "../runner/testing.ts";
import { startCheck } from "./reads.ts";
import { START_RULES, startPlan, startSet } from "./start-set.ts";
import { setup } from "./testing.ts";
import { createTask, releaseTask, startTask, updateTask } from "./writes.ts";

/**
 * Starting tasks from ChatGPT by the user's permission (06-god-mode.md, Starting a set of tasks): what
 * each task of a named set does now, the one read-back for the set, and what the yes covers later.
 * The fixture (testing.ts): TST-TASK1, TST-TASK2 and TST-FX001 ready in core; TST-DEP01 waits for
 * TST-TASK1; TST-RD002 runs on anna's Mac; TST-ST001 is in site, not mapped here.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

type S = Awaited<ReturnType<typeof setup>>;

const decisions = (plan: Awaited<ReturnType<typeof startPlan>>) => Object.fromEntries(plan.tasks.map((t) => [t.id, t.decision]));
const flags = (s: S) => readAutopilot(s.ctx).flags.map((f) => f.task);

test("a task the user named starts at once, launching and not yet working, and the read-back is not taken for seeing the brief", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const plan = await startPlan(s.ctx, { tasks: ["TST-TASK1"] });
    assert.equal(plan.error, "");
    assert.equal(plan.rules, START_RULES);
    assert.equal(plan.asks_first, true, "this Mac reads starts back: the switch is off");
    assert.match(plan.permission, /read back first/);
    assert.deepEqual(plan.tasks.map((t) => [t.id, t.decision, t.order]), [["TST-TASK1", "can_start", 1]]);
    assert.equal(plan.start_now, "TST-TASK1 «one»");
    assert.equal(plan.after, "none");
    assert.equal(plan.not_started, "none");
    assert.match(plan.agents, / in Auto mode \(auto, /, "the agents' mode is said apart from the permission");
    assert.match(plan.instructions, /TST-TASK1: not seen by you yet/);

    const answer = await startSet(s.ctx, { tasks: ["TST-TASK1"] });
    assert.equal(answer.ok, true, answer.error);
    assert.deepEqual(answer.started.map((t) => [t.id, t.state]), [["TST-TASK1", "launching"]]);
    assert.deepEqual(answer.queued, []);
    assert.match(answer.note, /not working yet/);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    const again = await startPlan(s.ctx, { tasks: ["TST-TASK1"] });
    assert.equal(again.tasks[0]!.decision, "already_started", "a repeat finds it held and starts nothing");
    const seen = existsSync(join(s.dashboard.dataDir, "seen.json")) ? readFileSync(join(s.dashboard.dataDir, "seen.json"), "utf8") : "";
    assert.doesNotMatch(seen, /TST-TASK1/, "a ChatGPT start marks nothing seen");
  } finally {
    s.stop();
  }
});

test("a draft is not permission: it waits for the owner and does not start", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const draft = await createTask(s.ctx, { title: "An idea to think about" });
    assert.equal(draft.status, "inbox");
    const plan = await startPlan(s.ctx, { tasks: [draft.id] });
    assert.deepEqual(plan.tasks.map((t) => [t.decision, t.needs]), [["needs_owner", "draft"]]);
    assert.match(plan.tasks[0]!.next, /only if the user asks to start this draft itself/);
    const answer = await startSet(s.ctx, { tasks: [draft.id] });
    assert.equal(answer.ok, false);
    assert.match(answer.error, /Nothing of the set was started/);
    assert.equal(s.dashboard.runs!.runs.size, 0);
    const check = await startCheck(s.ctx, { task: draft.id });
    assert.equal(check.decision, "needs_owner");
  } finally {
    s.stop();
  }
});

test("a mixed set: prerequisites first, the independent ones together, the waiting one queued, the rest said and left", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const draft = await createTask(s.ctx, { title: "Loose idea" });
    const set = ["TST-DEP01", draft.id, "TST-TASK1", "TST-RD002", "TST-ST001", "TST-FX001", "no such task anywhere"];
    const plan = await startPlan(s.ctx, { tasks: set });
    assert.equal(plan.error, "");
    const by = decisions(plan);
    assert.equal(by["TST-TASK1"], "can_start");
    assert.equal(by["TST-FX001"], "can_start");
    assert.equal(by["TST-DEP01"], "after_prerequisites");
    assert.equal(by[draft.id], "needs_owner");
    assert.equal(by["TST-RD002"], "already_started", "anna's run holds it");
    assert.equal(by["TST-ST001"], "refused", "its project is not mapped here");
    assert.equal(by["no such task anywhere"], "refused");
    const order = Object.fromEntries(plan.tasks.map((t) => [t.id, t.order]));
    assert.deepEqual([order["TST-TASK1"], order["TST-FX001"], order["TST-DEP01"]], [1, 1, 2]);
    assert.deepEqual(plan.tasks.slice(0, 3).map((t) => t.order), [1, 1, 2], "what starts comes first, in starting order");
    assert.deepEqual(plan.tasks.find((t) => t.id === "TST-DEP01")!.waits_for, [{ id: "TST-TASK1", title: "one", status: "todo", in_set: true }]);
    assert.match(plan.after, /^TST-DEP01 «Blocked thing» after TST-TASK1$/);
    for (const field of [plan.start_now, plan.after, plan.not_started, plan.agents, plan.instructions]) assert.ok(field.length <= 200, field);

    const answer = await startSet(s.ctx, { tasks: set });
    assert.equal(answer.ok, true, answer.error);
    const going = [...answer.started.map((t) => t.id), ...answer.queued.map((t) => t.id)];
    assert.equal(answer.started[0]?.id, plan.tasks[0]!.id, "the first that can start starts in this call");
    assert.deepEqual(going.sort(), ["TST-DEP01", "TST-FX001", "TST-TASK1"]);
    assert.ok(answer.queued.some((t) => t.id === "TST-DEP01" && /TST-TASK1 \(todo\) to be done/.test(t.waits_for)));
    assert.deepEqual(answer.not_started.map((t) => t.id).sort(), [draft.id, "TST-RD002", "TST-ST001", "no such task anywhere"].sort());
    assert.ok(flags(s).includes("TST-DEP01"), "queued on this Mac's autopilot, as one task flag");
    assert.ok(!readAutopilot(s.ctx).flags.some((f) => f.project), "never a project's flag");
  } finally {
    s.stop();
  }
});

test("a task waiting for one nobody starts is blocked, said by start_check too, and start_task alone refuses what waits", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const plan = await startPlan(s.ctx, { tasks: ["TST-DEP01"] });
    assert.equal(plan.tasks[0]!.decision, "blocked");
    assert.match(plan.tasks[0]!.reason, /TST-TASK1 .*not started and not in this set/);
    const check = await startCheck(s.ctx, { task: "TST-DEP01" });
    assert.match(check.error, /blocked by TST-TASK1/);
    assert.equal(check.decision, "blocked");
    assert.match(check.waits_for, /TST-TASK1 «one» \(todo\)/);
    assert.equal(check.asks_first, true);
    assert.equal((await startSet(s.ctx, { tasks: ["TST-DEP01"] })).ok, false);
    assert.deepEqual(flags(s), [], "nothing queued past the permission");

    // Its prerequisite under way: it starts after it, but only from a set the user confirmed.
    assert.equal((await startTask(s.ctx, { task: "TST-TASK1" })).ok, true);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    assert.equal((await startCheck(s.ctx, { task: "TST-DEP01" })).decision, "after_prerequisites");
    assert.equal((await startTask(s.ctx, { task: "TST-DEP01" })).ok, false);
  } finally {
    s.stop();
  }
});

test("work in review waits for the owner's test and acceptance", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("anna", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: review"));
    });
    await s.sync().sync();
    const plan = await startPlan(s.ctx, { tasks: ["TST-FX001"] });
    assert.deepEqual(plan.tasks.map((t) => [t.decision, t.needs]), [["needs_owner", "review"]]);
    assert.match(plan.tasks[0]!.next, /never accept it for them/);
  } finally {
    s.stop();
  }
});

test("a queued task starts once its prerequisite is done, with the instructions the yes covered, and waits when they changed after it", async () => {
  for (const edited of [false, true]) {
    const s = await setup({ profiles: [PROFILE] });
    try {
      assert.equal((await startTask(s.ctx, { task: "TST-TASK1" })).ok, true);
      await settled(() => s.task("TST-TASK1")?.status === "in_progress");
      const answer = await startSet(s.ctx, { tasks: ["TST-DEP01"] });
      assert.deepEqual([answer.started, answer.queued.map((t) => t.id)], [[], ["TST-DEP01"]]);
      if (edited) assert.equal((await updateTask(s.ctx, { task: "TST-DEP01", brief: "Do something else entirely." })).ok, true);
      await s.dashboard.autopilot!.pass(s.ctx);
      assert.equal(s.task("TST-DEP01")?.status, "todo", "not before its prerequisite is done");
      assert.equal((await releaseTask(s.ctx, { task: "TST-TASK1", to: "done" })).ok, true);
      await s.dashboard.autopilot!.pass(s.ctx);
      if (edited) {
        assert.equal(s.task("TST-DEP01")?.status, "todo");
        assert.match(readAutopilot(s.ctx).flags.find((f) => f.task === "TST-DEP01")?.state ?? "", /open TST-DEP01 once/);
      } else {
        await settled(() => s.task("TST-DEP01")?.status === "in_progress");
        assert.deepEqual(flags(s), [], "the flag is spent by its start");
      }
    } finally {
      s.stop();
    }
  }
});

test("without asking, the set starts only while this Mac's switch is on", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const refused = await startSet(s.ctx, { tasks: ["TST-TASK1"], without_asking: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /without asking is off on this Mac/);
    assert.equal(s.dashboard.runs!.runs.size, 0);
    assert.equal(writeGodModeSettings(s.dashboard, { start_without_asking: true }).ok, true);
    const plan = await startPlan(s.ctx, { tasks: ["TST-TASK1"] });
    assert.equal(plan.asks_first, false);
    assert.match(plan.permission, /run at once/);
    const started = await startSet(s.ctx, { tasks: ["TST-TASK1"], without_asking: true });
    assert.equal(started.ok, true, started.error);
  } finally {
    s.stop();
  }
});

test("tasks waiting for each other are blocked; a prerequisite in review lets its dependent wait as it would outside the set", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("anna", (root) => {
      const path = (name: string) => join(root, "tasks", name);
      const edit = (name: string, from: string, to: string) => writeFileSync(path(name), readFileSync(path(name), "utf8").replace(from, to));
      edit("TST-TASK2-two.md", "status: todo", 'status: todo\ndepends_on: ["[[TST-FX001-fix-flaky-login-test]]"]');
      edit("TST-FX001-fix-flaky-login-test.md", "status: todo", 'status: todo\ndepends_on: ["[[TST-TASK2-two]]"]');
    });
    await s.sync().sync();
    const circle = await startPlan(s.ctx, { tasks: ["TST-TASK2", "TST-FX001"] });
    assert.deepEqual(circle.tasks.map((t) => t.decision), ["blocked", "blocked"]);
    assert.ok(circle.tasks.some((t) => /waits for it in turn/.test(t.reason)));

    s.f.external("anna", (root) => {
      const path = join(root, "tasks", "TST-TASK1-one.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: review"));
    });
    await s.sync().sync();
    const review = await startPlan(s.ctx, { tasks: ["TST-TASK1", "TST-DEP01"] });
    assert.deepEqual(review.tasks.map((t) => [t.id, t.decision]), [["TST-DEP01", "after_prerequisites"], ["TST-TASK1", "needs_owner"]]);
  } finally {
    s.stop();
  }
});

test("a paused flag stays paused, and an edited brief changes the read-back's instructions line", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    assert.equal((await startTask(s.ctx, { task: "TST-TASK1" })).ok, true);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    s.dashboard.autopilot!.queue("TST", [{ task: "TST-DEP01", accepted: [] }]);
    (s.dashboard.autopilot as unknown as { pause: (space: string, key: string, why: string) => void }).pause("TST", "t:TST:TST-DEP01", "paused: by a test");
    const before = await startPlan(s.ctx, { tasks: ["TST-DEP01"] });
    const answer = await startSet(s.ctx, { tasks: ["TST-DEP01"] });
    assert.equal(answer.ok, false);
    assert.match(answer.not_started[0]!.reason, /paused: by a test/);

    assert.equal((await updateTask(s.ctx, { task: "TST-DEP01", brief: "Another text." })).ok, true);
    const after = await startPlan(s.ctx, { tasks: ["TST-DEP01"] });
    assert.notEqual(after.instructions, before.instructions, "God Mode reads it back again");
  } finally {
    s.stop();
  }
});

test("a claim pushed without an answer is unclear, not refused; alone, it is unknown whether it took effect", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const sync = s.sync();
    sync.claim = (async () => ({ result: "unknown", reason: "the push did not answer" })) as unknown as typeof sync.claim;
    // Its dependent is still queued: the claim may land, and the autopilot starts it only once that is done.
    const mixed = await startSet(s.ctx, { tasks: ["TST-TASK1", "TST-DEP01"] });
    assert.equal(mixed.ok, true, mixed.error);
    assert.deepEqual(mixed.unclear.map((t) => t.id), ["TST-TASK1"]);
    assert.deepEqual(mixed.queued.map((t) => t.id), ["TST-DEP01"]);
    assert.deepEqual(mixed.not_started, []);
    await assert.rejects(startSet(s.ctx, { tasks: ["TST-FX001"] }), /the push did not answer/);
  } finally {
    s.stop();
  }
});
