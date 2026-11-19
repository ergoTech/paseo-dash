import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./api/testing.ts";
import { planStart } from "./api/reads.ts";
import { startTask } from "./api/writes.ts";
import { readAutopilot, setAutopilot } from "./queue.ts";
import { resumeCheck, resumeTask } from "./autopilot-resume.ts";
import { settled } from "./runner/testing.ts";

type Setup = Awaited<ReturnType<typeof setup>>;

/** The person opens the task: its instructions are seen as they are now. */
async function see(s: Setup, task: string) {
  const plan = await planStart(s.ctx, { task });
  assert.ok("found" in plan, "error" in plan ? plan.error : "");
  for (const part of plan.parts) s.dashboard.seen!.mark("TST", part);
}

/** As a failed start leaves it: the autopilot pauses the flag with the reason. */
function pause(s: Setup, key: string, why: string) {
  (s.dashboard.autopilot as unknown as { pause: (space: string, key: string, why: string) => void }).pause("TST", key, why);
}

const flag = (s: Setup, key: string) => readAutopilot(s.ctx).flags.find((f) => f.task === key || f.project === key);
const file = (s: Setup) => JSON.parse(readFileSync(join(s.dashboard.dataDir, "autopilot.json"), "utf8"));

test("a resume reads back the paused task and its reason, then clears that one pause and nothing else; a repeat starts nothing more", async () => {
  const s = await setup();
  try {
    await see(s, "TST-TASK1");
    // Two paused flags, a paused project, a limit and start defaults the person chose: only TST-TASK1's pause goes.
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true, max_running: 2 });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK2", on: true });
    s.dashboard.autopilot!.set({ space: "TST", project: "site", on: true });
    s.dashboard.autopilot!.queue("TST", [{ task: "TST-TASK1", accepted: ["a".repeat(24)] }]);
    s.dashboard.autopilot!.setStartDefaults({ new_tasks: false, effort: "low" });
    pause(s, "t:TST:TST-TASK1", "paused: starting TST-TASK1 failed: the worktree could not be made");
    pause(s, "t:TST:TST-TASK2", "paused: starting TST-TASK2 failed: no profile");
    pause(s, "p:TST:site", "paused: the agent of TST-ST001 failed: boom");
    const before = file(s);

    const check = resumeCheck(s.ctx, { task: "TST-TASK1" });
    assert.equal(check.error, "");
    assert.deepEqual([check.task, check.title, check.space, check.state], ["TST-TASK1", "one", "TST", "paused"]);
    assert.equal(check.paused, "paused: starting TST-TASK1 failed: the worktree could not be made");
    assert.match(check.then, /may start it on its own, with no further question: .* while fewer than 2 of this Mac's runs are at work/);
    assert.equal(s.dashboard.runs!.runs.size, 0, "the read-back changes nothing");

    const resumed = await resumeTask(s.ctx, { task: "TST-TASK1" });
    assert.equal(resumed.error, "");
    assert.equal(resumed.ok, true);
    assert.ok(["queued", "launching", "working"].includes(resumed.state), resumed.state);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");

    const after = file(s);
    assert.equal(after.max_running, before.max_running, "the limit stays");
    assert.deepEqual(after.start, before.start, "the start defaults stay");
    assert.deepEqual(after.projects, before.projects, "the project's pause stays");
    assert.deepEqual(after.tasks.find((f: { task: string }) => f.task === "TST-TASK2"), before.tasks.find((f: { task: string }) => f.task === "TST-TASK2"));
    assert.equal(flag(s, "TST-TASK2")?.paused, true);

    // Asked again, the task is found started: nothing is resumed or started a second time.
    const again = await resumeTask(s.ctx, { task: "TST-TASK1" });
    assert.equal(again.ok, false);
    assert.ok(["launching", "working", "started"].includes(again.state), again.state);
    assert.match(again.error, /^TST-TASK1 already started: its agent is \w+; nothing to resume, nothing started again\. Next: read task TST-TASK1 for what its agent does\.$/);
    assert.match(again.next, /read task TST-TASK1/);
    assert.equal(s.dashboard.runs!.runs.size, 1, "one run");
    assert.match(resumeCheck(s.ctx, { task: "TST-TASK1" }).error, /already started/, "the read-back refuses it too");
  } finally {
    s.stop();
  }
});

test("a resume while the limit is full answers queued with what the autopilot waits for, not a start", async () => {
  const s = await setup();
  try {
    await see(s, "TST-FX001");
    await see(s, "TST-TASK1");
    s.dashboard.autopilot!.set({ space: "TST", on: false, max_running: 1 });
    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity === "working" || run.activity === "waiting");
    s.dashboard.runs!.setActivity(run, "working", new Date().toISOString());
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    pause(s, "t:TST:TST-TASK1", "paused: by a test");

    const resumed = await resumeTask(s.ctx, { task: "TST-TASK1" });
    assert.deepEqual([resumed.ok, resumed.state, resumed.agent], [true, "queued", ""]);
    assert.match(resumed.wait, /waits: 1 runs of this Mac are at work \(the autopilot's limit is 1\): TST-FX001/);
    assert.match(resumed.next, /starts on its own .* launching \(being started\), then working/);
    assert.equal(flag(s, "TST-TASK1")?.paused, false);
    assert.equal(s.task("TST-TASK1")?.status, "todo");

    // Asked again: not paused any more, so nothing to resume, and the answer says it waits in the queue.
    const again = await resumeTask(s.ctx, { task: "TST-TASK1" });
    assert.deepEqual([again.ok, again.state], [false, "queued"]);
    assert.match(again.error, /^TST-TASK1 is not paused: it is queued on this Mac's autopilot\. Next: nothing to resume; .* Now: waits: 1 runs/);
  } finally {
    s.stop();
  }
});

test("nothing to resume: not found, not on the autopilot, only its project paused, blocked, finished; each says the state and the next step", async () => {
  const s = await setup();
  try {
    const nope = resumeCheck(s.ctx, { task: "TST-NOPE0" });
    assert.deepEqual([nope.state, nope.error], ["not_found", "No task matches «TST-NOPE0». Next: find it with tasks; the autopilot read lists the paused flags."]);

    const none = resumeCheck(s.ctx, { task: "TST-TASK2" });
    assert.equal(none.state, "not_queued");
    assert.match(none.error, /TST-TASK2 is not on this Mac's autopilot/);
    assert.match(none.next, /start_task/);

    setAutopilot(s.ctx, { space: "TST", project: "core", on: true });
    pause(s, "p:TST:core", "paused: TST-FX001 was released back to todo");
    const line = resumeCheck(s.ctx, { task: "TST-TASK2" });
    assert.equal(line.state, "not_queued");
    assert.match(line.error, /its project core's flag is paused\. Next: only the user resumes a project's flag, in Paseo Dash: Live, Autopilot\. Why: paused: TST-FX001 was released back to todo/);
    assert.match(line.next, /only the user resumes a project's flag, in Paseo Dash: Live, Autopilot/);
    assert.equal((await resumeTask(s.ctx, { task: "TST-TASK2" })).ok, false);
    assert.equal(flag(s, "core")?.paused, true, "a project is never resumed through ChatGPT");

    s.dashboard.autopilot!.set({ space: "TST", task: "TST-DEP01", on: true });
    pause(s, "t:TST:TST-DEP01", "paused: by a test");
    const blocked = await resumeTask(s.ctx, { task: "Blocked thing" });
    assert.deepEqual([blocked.ok, blocked.state, blocked.task], [false, "blocked", "TST-DEP01"]);
    assert.equal(blocked.error, "TST-DEP01 is blocked by TST-TASK1: resumed now it would only wait; its flag stays paused. Next: resume it once it is ready. Paused: paused: by a test");
    assert.equal(flag(s, "TST-DEP01")?.paused, true);

    // Anna's run holds TST-RD002: started elsewhere, never started here again.
    const held = resumeCheck(s.ctx, { task: "TST-RD002" });
    assert.deepEqual([held.state, /already started: its agent is working/.test(held.error)], ["working", true]);
  } finally {
    s.stop();
  }
});
