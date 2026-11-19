import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spaceSchema } from "../shared/model.ts";
import { planStart, startCheck, uiStartCheck } from "./api/reads.ts";
import { startPlan, startSet } from "./api/start-set.ts";
import { setup } from "./api/testing.ts";
import { startTask } from "./api/writes.ts";
import { nextTask, readAutopilot, setAutopilot, startReady } from "./queue.ts";
import { settled } from "./runner/testing.ts";
import { featureView } from "./views.ts";
import { isHumanWorkRefusal } from "./api/view.ts";

/**
 * Labels that mark a person's work (the space's `defaults.human_labels`): nothing starts such a task on
 * its own, a start of that one task still can and says the label. The fixture (api/testing.ts):
 * TST-FX001 of feature TST-FEAT1, TST-TASK1 and TST-TASK2 of TST-FEAT0, all ready in core; TST-DEP01 waits for TST-TASK1.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const FILES: Record<string, string> = {
  "TST-FX001": "TST-FX001-fix-flaky-login-test.md",
  "TST-TASK1": "TST-TASK1-one.md",
  "TST-TASK2": "TST-TASK2-two.md",
};

const SPACE = { schema: "paseo-dashboard/1", key: "TST", name: "T" };

type S = Awaited<ReturnType<typeof setup>>;

function label(root: string, task: string, name = "manual"): void {
  const path = join(root, "tasks", FILES[task]!);
  writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", `status: todo\nlabels: [${name}]\n`));
}

function setting(root: string, value = "[manual, needs-owner]"): void {
  const path = join(root, "space.yaml");
  writeFileSync(path, `${readFileSync(path, "utf8").replace(/^defaults:.*\n(?:[ \t]+.*\n)*/m, "")}defaults:\n  human_labels: ${value}\n`);
}

/** A space with the setting, and the tasks named carrying `manual`. */
async function marked(...tasks: string[]): Promise<S> {
  const s = await setup({ profiles: [PROFILE] });
  s.f.external("ergo", (root) => {
    setting(root);
    for (const task of tasks) label(root, task);
  });
  await s.sync().sync();
  return s;
}

async function see(s: S, ...tasks: string[]) {
  for (const task of tasks) {
    const plan = await planStart(s.ctx, { task });
    assert.ok("found" in plan, "error" in plan ? plan.error : "");
    for (const part of plan.parts) s.dashboard.seen!.mark("TST", part);
  }
}

/** Anna's live run holds project core for the autopilot; a test of its project flag ends it first. */
async function endAnnasRun(s: S) {
  s.f.external("anna", (root) => {
    const path = join(root, "tasks", "TST-RD002-login-page-redesign.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("status: in_progress\n", "status: done\nrun_ended: 2026-10-26T09:00:00Z\n"));
  });
  await s.sync().sync();
}

const flag = (s: S, key: string) => readAutopilot(s.ctx).flags.find((f) => f.task === key || f.project === key);

test("without human_labels a label changes nothing: every path starts the task as it did", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("ergo", (root) => label(root, "TST-FX001"));
    await s.sync().sync();
    assert.deepEqual(s.task("TST-FX001")?.labels, ["manual"]);
    assert.deepEqual(s.sync().plan.space?.defaults.human_labels, []);

    assert.deepEqual(nextTask(s.ctx, {}), { task: "TST-FX001", title: "Fix flaky login test", space: "TST", passed_over: "", error: "" });
    const check = await startCheck(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([check.error, check.human, check.decision], ["", "", "can_start"]);
    assert.equal((await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false })).human, "");
    assert.deepEqual((await startPlan(s.ctx, { tasks: ["TST-FX001"] })).tasks.map((t) => [t.decision, t.needs]), [["can_start", ""]]);
    assert.equal(setAutopilot(s.ctx, { space: "TST", task: "TST-FX001", on: true }).ok, true);
    setAutopilot(s.ctx, { space: "TST", task: "TST-FX001", on: false });
    assert.equal(featureView(s.dashboard, { feature: "TST-FEAT1" }).phases.flat().find((t) => t.id === "TST-FX001")?.human, "");

    await see(s, "TST-FX001");
    const ready = await startReady(s.ctx, { feature: "TST-FEAT1", tasks: ["TST-FX001"] });
    assert.deepEqual([ready.started.map((t) => t.id), ready.skipped], [["TST-FX001"], []]);
    await settled(() => s.task("TST-FX001")?.status === "in_progress");
  } finally {
    s.stop();
  }
});

test("the setting reads a list, a single label or nothing; anything else reads as none and does not fail the space", () => {
  const defaults = (value: unknown) => spaceSchema.parse({ ...SPACE, defaults: { human_labels: value } }).defaults.human_labels;
  assert.deepEqual(defaults(["manual", "needs-owner"]), ["manual", "needs-owner"]);
  assert.deepEqual(defaults("manual"), ["manual"]);
  assert.deepEqual(defaults(null), []);
  assert.deepEqual(defaults({ manual: true }), []);
  assert.deepEqual(spaceSchema.parse(SPACE).defaults.human_labels, []);
});

test("Start next passes over a person's work and names it; with only such tasks it starts nothing and says why", async () => {
  const s = await marked("TST-FX001");
  try {
    const next = nextTask(s.ctx, {});
    assert.notEqual(next.task, "TST-FX001");
    assert.equal(next.error, "");
    assert.match(next.passed_over, /TST-FX001: label manual marks it as a person's work/);
  } finally {
    s.stop();
  }
  const all = await marked("TST-FX001", "TST-TASK1", "TST-TASK2");
  try {
    const next = nextTask(all.ctx, {});
    assert.equal(next.task, "");
    assert.match(next.error, /left to a person: .*TST-FX001.*label manual marks them as a person's work/);
  } finally {
    all.stop();
  }
});

test("Start ready tasks leaves a person's work with its reason and starts the rest; the feature view says which is which", async () => {
  const s = await marked("TST-TASK1");
  try {
    const rows = featureView(s.dashboard, { feature: "TST-FEAT0" }).phases.flat();
    assert.match(rows.find((t) => t.id === "TST-TASK1")?.human ?? "", /label manual/);
    assert.equal(rows.find((t) => t.id === "TST-TASK2")?.human, "");

    await see(s, "TST-TASK1", "TST-TASK2");
    const answer = await startReady(s.ctx, { feature: "TST-FEAT0", tasks: ["TST-TASK1", "TST-TASK2"] });
    assert.deepEqual(answer.started.map((t) => t.id), ["TST-TASK2"]);
    assert.deepEqual(answer.skipped.map((t) => t.id), ["TST-TASK1"]);
    assert.match(answer.skipped[0]!.reason, /label manual marks it as a person's work/);
    await settled(() => s.task("TST-TASK2")?.status === "in_progress");
    assert.equal(s.task("TST-TASK1")?.status, "todo");
  } finally {
    s.stop();
  }
});

test("the autopilot starts the next task of a project past a person's work, and says what it passed over", async () => {
  const s = await marked("TST-FX001");
  try {
    await see(s, "TST-TASK1", "TST-TASK2");
    await endAnnasRun(s);
    s.dashboard.autopilot!.set({ space: "TST", project: "core", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    const started = readAutopilot(s.ctx).started.map((x) => x.task);
    assert.equal(started.length, 1);
    assert.notEqual(started[0], "TST-FX001");
    assert.equal(s.task("TST-FX001")?.status, "todo");
    assert.match(flag(s, "core")?.state ?? "", /^started TST-\w+; passed over TST-FX001: label manual marks it as a person's work/);
  } finally {
    s.stop();
  }
});

test("a project whose ready tasks are all a person's work starts nothing and says so", async () => {
  const s = await marked("TST-FX001", "TST-TASK1", "TST-TASK2");
  try {
    await endAnnasRun(s);
    s.dashboard.autopilot!.set({ space: "TST", project: "core", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.deepEqual(readAutopilot(s.ctx).started, []);
    assert.match(flag(s, "core")?.state ?? "", /^waits: only a person's work is ready: .*label manual marks them as a person's work/);
    assert.equal(flag(s, "core")?.paused, false);
  } finally {
    s.stop();
  }
});

test("the autopilot's flag on a person's work is refused; a flag from before the label waits unpaused and names it", async () => {
  const s = await marked("TST-FX001");
  try {
    const refused = setAutopilot(s.ctx, { space: "TST", task: "TST-FX001", on: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /label manual marks it as a person's work; the autopilot does not start it/);
    assert.equal(flag(s, "TST-FX001"), undefined);

    await see(s, "TST-FX001");
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-FX001", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.match(flag(s, "TST-FX001")?.state ?? "", /^waits: TST-FX001: label manual marks it as a person's work/);
    assert.equal(flag(s, "TST-FX001")?.paused, false);
    assert.equal(s.task("TST-FX001")?.status, "todo");
  } finally {
    s.stop();
  }
});

test("start_plan says needs_owner with the reason, whatever the label's case; a run already under way stays already_started", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("ergo", (root) => {
      setting(root);
      label(root, "TST-FX001", "Needs-Owner");
    });
    await s.sync().sync();
    const plan = await startPlan(s.ctx, { tasks: ["TST-FX001"] });
    assert.deepEqual(plan.tasks.map((t) => [t.decision, t.needs, t.order]), [["needs_owner", "human_label", 0]]);
    assert.match(plan.tasks[0]!.reason, /label Needs-Owner marks it as a person's work/);
    assert.match(plan.tasks[0]!.next, /start_task, whose read-back says the label/);
    assert.equal(plan.start_now, "none");
    assert.match(plan.not_started, /TST-FX001 .*\(needs_owner: human_label\)/);
    assert.equal(isHumanWorkRefusal("«Fix flaky login test» (TST-FX001): label manual marks it as a person's work.", "TST-FX001"), true);
    assert.equal(isHumanWorkRefusal("«Not as a person's work.» (TST-FX001) is blocked by TST-TASK1.", "TST-FX001"), false, "a title is not the reason");
    const refused = await startPlan(s.ctx, { tasks: ["TST-FX001"], for_start: true });
    assert.match(refused.error, /Nothing of the set would start: TST-FX001: label Needs-Owner/);

    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    await settled(() => s.task("TST-FX001")?.status === "in_progress");
    assert.equal((await startPlan(s.ctx, { tasks: ["TST-FX001"] })).tasks[0]!.decision, "already_started");
  } finally {
    s.stop();
  }
});

test("a person's work that a start of it alone would also be refused for says both reasons and does not point to start_task", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("ergo", (root) => {
      setting(root);
      const dep = join(root, "tasks", "TST-DEP01-blocked-thing.md");
      writeFileSync(dep, readFileSync(dep, "utf8").replace("status: todo\n", "status: todo\nlabels: [manual]\n"));
    });
    await s.sync().sync();
    const plan = await startPlan(s.ctx, { tasks: ["TST-DEP01"] });
    assert.deepEqual(plan.tasks.map((t) => [t.decision, t.needs]), [["needs_owner", "human_label"]]);
    assert.match(plan.tasks[0]!.reason, /^label manual marks it as a person's work; also it waits for TST-TASK1/);
    assert.doesNotMatch(plan.tasks[0]!.next, /start_task/);
    const check = await startCheck(s.ctx, { task: "TST-DEP01" });
    assert.match(check.error, /blocked by TST-TASK1/, "the read-back still refuses it for what it waits for");
  } finally {
    s.stop();
  }
});

test("start_tasks starts the rest of a set and names the person's work; what waits for it does not start", async () => {
  const s = await marked("TST-FX001");
  try {
    const answer = await startSet(s.ctx, { tasks: ["TST-FX001", "TST-TASK1"] });
    assert.equal(answer.ok, true, answer.error);
    assert.deepEqual(answer.started.map((t) => t.id), ["TST-TASK1"]);
    assert.deepEqual(answer.not_started.map((t) => [t.id, t.decision]), [["TST-FX001", "needs_owner"]]);
    assert.match(answer.not_started[0]!.reason, /label manual marks it as a person's work/);
    assert.equal(s.task("TST-FX001")?.status, "todo");
  } finally {
    s.stop();
  }
  const dep = await marked("TST-TASK1");
  try {
    const answer = await startSet(dep.ctx, { tasks: ["TST-TASK1", "TST-DEP01"] });
    assert.equal(answer.ok, false);
    assert.deepEqual(Object.fromEntries(answer.not_started.map((t) => [t.id, t.decision])), { "TST-TASK1": "needs_owner", "TST-DEP01": "blocked" });
    assert.deepEqual(answer.queued, [], "nothing is left to the autopilot behind the person's work");
  } finally {
    dep.stop();
  }
});

test("a start of that one task goes on, and its read-back, dialog and answer say the label", async () => {
  const s = await marked("TST-FX001");
  try {
    const check = await startCheck(s.ctx, { task: "TST-FX001" });
    assert.equal(check.error, "", "the read-back does not refuse it");
    assert.equal(check.decision, "needs_owner", "the same decision as start_plan");
    assert.match(check.human, /^Label manual marks it as a person's work: an agent starts it only because this one task was asked for/);
    assert.match(check.next, /start_task/);
    assert.equal(check.issue, `${check.human}.`, "God Mode's read-back shows issue, not human: the label goes there");
    assert.ok(check.human.length <= 200, "God Mode keeps 200 characters of a shown field");
    const dialog = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(dialog.error, "");
    assert.equal(dialog.human, check.human);
    assert.equal(dialog.issue, "", "the dialog says it apart from the issue");

    const started = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.human, check.human, "a start without a read-back still says it");
    await settled(() => s.task("TST-FX001")?.status === "in_progress");
  } finally {
    s.stop();
  }
});

test("a label that lands after the dialog showed the task refuses the confirmed start; one that lands before an automatic start's claim stops it", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("ergo", setting);
    await s.sync().sync();
    const shown = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(shown.human, "");
    await see(s, "TST-FX001");
    s.f.external("anna", (root) => label(root, "TST-FX001"));
    // Not fetched yet: only the claim's own fetch sees the label.
    assert.equal(s.task("TST-FX001")?.labels.length, 0);
    const automatic = await startTask(s.ctx, { task: "TST-FX001" }, { automatic: true });
    assert.equal(automatic.ok, false);
    assert.match(automatic.error, /label manual marks it as a person's work/);
    assert.equal(s.task("TST-FX001")?.status, "todo");

    await s.sync().sync();
    const confirmed = await startTask(s.ctx, { task: "TST-FX001" }, { shown: { project: shown.project, branch: shown.branch, workspace: shown.workspace, profile: shown.profile, issue: shown.issue, human: shown.human } });
    assert.equal(confirmed.ok, false);
    assert.match(confirmed.error, /the person's-work mark is now Label manual/);
  } finally {
    s.stop();
  }
});
