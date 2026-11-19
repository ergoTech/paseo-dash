import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./api/testing.ts";
import { planStart } from "./api/reads.ts";
import { nextTask, readAutopilot, setAutopilot, startReady } from "./queue.ts";
import { settled } from "./runner/testing.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../shared/model.ts";
import { Autopilot, NOT_CHECKED, NOT_REACHED } from "./autopilot.ts";
import { startTask, type WriteContext } from "./api/writes.ts";
import { readOverview } from "./overview.ts";
import type { RunRecord } from "./runner/runs.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

/** The person opens the task: its instructions are seen as they are now. */
async function see(s: Awaited<ReturnType<typeof setup>>, task: string) {
  const plan = await planStart(s.ctx, { task });
  assert.ok("found" in plan, "error" in plan ? plan.error : "");
  for (const part of plan.parts) s.dashboard.seen!.mark("TST", part);
}

const flag = (s: Awaited<ReturnType<typeof setup>>, key: string) => readAutopilot(s.ctx).flags.find((f) => f.task === key || f.project === key);

test("a task on autopilot starts once it is ready and its instructions were seen as they are; the flag is spent", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    assert.equal(setAutopilot(s.ctx, { space: "TST", task: "TST-RD002", on: true }).error, "TST-RD002 is in_progress; the autopilot starts only a todo task.");
    assert.equal(setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: true }).ok, true);
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.match(flag(s, "TST-TASK1")?.state ?? "", /open TST-TASK1 once: .* not seen by you/, "another person's text never runs unseen");
    assert.equal(s.task("TST-TASK1")?.status, "todo");
    await see(s, "TST-TASK1");
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    assert.equal(flag(s, "TST-TASK1"), undefined, "spent by its start");
    assert.deepEqual(readAutopilot(s.ctx).started.map((x) => x.task), ["TST-TASK1"]);
  } finally {
    s.stop();
  }
});

test("after a restart, before its first pass, a flag says it was not checked yet, not that nothing holds it", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    assert.equal(setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: true }).ok, true);
    // The daemon or the plugin restarted: the flags are read back, no pass has run yet.
    s.dashboard.autopilot = new Autopilot(s.dashboard, join(s.dashboard.dataDir, "autopilot.json"));
    assert.equal(flag(s, "TST-TASK1")?.state, NOT_CHECKED);
    await s.dashboard.autopilot.pass(s.ctx);
    assert.match(flag(s, "TST-TASK1")?.state ?? "", /open TST-TASK1 once/);
  } finally {
    s.stop();
  }
});

test("a flag a pass did not reach after its one start says so, and starts at a later pass", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    await see(s, "TST-TASK1");
    await see(s, "TST-TASK2");
    // Both flags set before the pass (setAutopilot would start a pass of its own after the first).
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK2", on: true });
    assert.equal(flag(s, "TST-TASK2")?.state, NOT_CHECKED, "set after the last pass");
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    assert.equal(flag(s, "TST-TASK2")?.state, NOT_REACHED, "not \"nothing held it back\"");
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-TASK2")?.status === "in_progress");
  } finally {
    s.stop();
  }
});

test("a project on autopilot waits while a run of it is live anywhere; the limit of live runs here holds", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    // Anna's run of TST-RD002 is live in core.
    assert.equal(setAutopilot(s.ctx, { space: "TST", project: "core", on: true }).ok, true);
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.match(flag(s, "core")?.state ?? "", /waits: TST-RD002 «Login page redesign» runs in this project/);
    setAutopilot(s.ctx, { space: "TST", project: "core", on: false });

    // One run of this Mac at the limit of one: a ready, seen task waits for it.
    setAutopilot(s.ctx, { space: "TST", max_running: 1 });
    await see(s, "TST-TASK1");
    await see(s, "TST-TASK2");
    setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    setAutopilot(s.ctx, { space: "TST", task: "TST-TASK2", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.equal(s.task("TST-TASK2")?.status, "todo");
    assert.match(flag(s, "TST-TASK2")?.state ?? "", /waits: 1 runs of this Mac are at work \(the autopilot's limit is 1\): TST-TASK1/);
  } finally {
    s.stop();
  }
});

test("Start next is the first task ready from this Mac; Start ready tasks starts a feature's ready tasks", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    // TST-ST001 is in site, which this Mac does not map; TST-FX001 is first by its release's due day.
    assert.deepEqual(nextTask(s.ctx, {}), { task: "TST-FX001", title: "Fix flaky login test", space: "TST", passed_over: "", error: "" });
    // Only the tasks the confirmation named, and only with instructions seen as they are now.
    await see(s, "TST-TASK1");
    const answer = await startReady(s.ctx, { feature: "TST-FEAT0", tasks: ["TST-TASK1", "TST-TASK2"] });
    assert.equal(answer.error, "");
    assert.deepEqual(answer.started.map((t) => t.id), ["TST-TASK1"]);
    assert.deepEqual(answer.skipped.map((t) => [t.id, /open it once/.test(t.reason)]), [["TST-TASK2", true]]);
    await see(s, "TST-TASK2");
    const named = await startReady(s.ctx, { feature: "TST-FEAT0", tasks: ["TST-TASK1"] });
    assert.deepEqual([named.started, named.skipped.map((t) => [t.id, t.reason])], [[], [["TST-TASK1", "it is running now"]]], "a ready task not named is not started");
    assert.equal(s.task("TST-TASK2")?.status, "todo");
    assert.equal((await startReady(s.ctx, { feature: "TST-NOPE0", tasks: ["TST-TASK1"] })).error, "No feature TST-NOPE0.");
  } finally {
    s.stop();
  }
});

test("a project on autopilot pauses once a person releases what it started; off and resume work on a flag whose task left the plan", async () => {
  const stopped: string[] = [];
  const s = await setup({ profiles: [PROFILE] }, { stopAgent: async (id) => (stopped.push(id), { ok: true, error: "" }) });
  try {
    // Anna's run released, so nothing of core runs.
    await s.sync().record([{ op_id: "op-anna", kind: "release", id: "TST-RD002", run_id: "r-anna", to: "todo", at: new Date().toISOString() }]).outcomes;
    await see(s, "TST-FX001");
    setAutopilot(s.ctx, { space: "TST", project: "core", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-FX001")?.status === "in_progress");
    const { releaseTask } = await import("./api/writes.ts");
    assert.equal((await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" })).ok, true);
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.equal(s.task("TST-FX001")?.status, "todo", "not started again behind the person's back");
    assert.match(flag(s, "core")?.state ?? "", /paused: TST-FX001 was released back to todo/);
    // Resumed, the line goes on with its next ready task: the one released, seen as it is.
    assert.equal(setAutopilot(s.ctx, { space: "TST", project: "core", resume: true }).ok, true);
    assert.equal(flag(s, "core")?.paused, false);
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-FX001")?.status === "in_progress");

    // A flag whose task is gone from the plan can still be turned off.
    setAutopilot(s.ctx, { space: "TST", project: "core", on: false });
    await s.dashboard.autopilot!.pass(s.ctx);
    setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: true });
    s.sync().plan.entities.delete("TST-TASK1");
    assert.deepEqual(setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: false }), { ok: true, error: "" });
    assert.equal(readAutopilot(s.ctx).flags.length, 0);
  } finally {
    s.stop();
  }
});

/** Puts a task held by this Mac into the loaded plan, with its run record here (as server/states.test.ts does). */
function hold(s: Awaited<ReturnType<typeof setup>>, id: string, status: Task["status"], run: Partial<RunRecord>) {
  const plan = s.sync().plan;
  const base = plan.entities.get("TST-TASK1")!;
  const entity = { ...base.entity, id, title: `Held ${id}`, status, run_id: `r-${id}`, run_by: "ergo", run_host: "ergo-mbp", run_branch: `task/${id.toLowerCase()}`, run_started: "2026-11-15T08:00:00.000Z" } as Task;
  plan.entities.set(id, { ...base, entity });
  s.dashboard.runs!.put({ run_id: `r-${id}`, space: "TST", task: id, project: "core", projectId: "prj_core", branch: entity.run_branch!, started: entity.run_started!, attempts: [], claim: "won", activity: "working", activityAt: "2026-11-15T08:00:00.000Z", agentId: `a-${id}`, ...run });
}

test("runs with no agent at work take no place: stale holds and reviews awaiting acceptance do not stop a ready task (JOBBY-AH5Z0)", async () => {
  const s = await setup({ profiles: [PROFILE] });
  // The states are set by hand; the tracker's own pass would read them from Paseo.
  s.dashboard.tracker.stop();
  try {
    await s.settle();
    await see(s, "TST-TASK1");
    // As on the Mac on 2026-11-15: five tasks in progress whose agents are gone, one in review whose
    // agent is gone, one in review whose agent waits for acceptance, and a failed agent.
    for (const id of ["TST-HLD01", "TST-HLD02", "TST-HLD03", "TST-HLD04", "TST-HLD05"]) hold(s, id, "in_progress", { activity: "stopped" });
    hold(s, "TST-RVW01", "review", { activity: "stopped" });
    hold(s, "TST-RVW02", "review", { activity: "waiting" });
    hold(s, "TST-ERR01", "in_progress", { activity: "failed", error: "the agent stopped with an error" });
    s.dashboard.autopilot!.set({ space: "TST", on: false, max_running: 3 });
    let read = readAutopilot(s.ctx);
    assert.equal(read.running, 0);
    assert.equal(read.runs.length, 8, "each is still listed, with the place it does not take");
    assert.ok(read.runs.every((r) => !r.holds_place));
    // Its need stays on the board with its step: release it to done or todo.
    const overview = readOverview(s.dashboard, { limit: 50 }, "ergo-mbp");
    assert.match(overview.needs_you.find((n) => n.task === "TST-HLD01")?.next ?? "", /release it: to done if it is finished, to todo to start it again/);

    // A blocked task and a paused flag keep waiting; the ready one starts.
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-DEP01", on: true });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    await s.dashboard.autopilot!.pass(s.ctx);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    assert.equal(s.task("TST-TASK1")?.status, "in_progress");
    assert.match(flag(s, "TST-DEP01")?.state ?? "", /^waits: TST-DEP01 is blocked/);
    assert.equal(s.task("TST-DEP01")?.status, "todo");
  } finally {
    s.stop();
  }
});

test("agents at work fill the limit; a flag whose task is done leaves the list even while the limit is full", async () => {
  const s = await setup({ profiles: [PROFILE] });
  s.dashboard.tracker.stop();
  try {
    await s.settle();
    await see(s, "TST-TASK1");
    hold(s, "TST-WRK01", "in_progress", { activity: "working" });
    hold(s, "TST-ASK01", "in_progress", { activity: "needs_input", waitingFor: "asks to run: npm test" });
    hold(s, "TST-ANS01", "in_progress", { activity: "waiting" });
    hold(s, "TST-RVW03", "review", { activity: "working" });
    s.dashboard.autopilot!.set({ space: "TST", on: false, max_running: 4 });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK2", on: true });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    assert.equal(readAutopilot(s.ctx).running, 4);
    // TST-TASK2 was finished some other way meanwhile.
    const done = s.sync().plan.entities.get("TST-TASK2")!;
    s.sync().plan.entities.set("TST-TASK2", { ...done, entity: { ...done.entity, status: "done" } as Task });
    assert.equal(flag(s, "TST-TASK2"), undefined, "not shown as waiting before any pass");
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.equal(s.task("TST-TASK1")?.status, "todo");
    assert.equal(flag(s, "TST-TASK1")?.state, "waits: 4 runs of this Mac are at work (the autopilot's limit is 4): TST-WRK01, TST-ASK01, TST-ANS01, TST-RVW03");
    assert.deepEqual(readAutopilot(s.ctx).flags.map((f) => f.task), ["TST-TASK1"]);
    const file = JSON.parse(readFileSync(join(s.dashboard.dataDir, "autopilot.json"), "utf8")) as { tasks: { task: string }[] };
    assert.deepEqual(file.tasks.map((t) => t.task), ["TST-TASK1"], "dropped from the file too");
  } finally {
    s.stop();
  }
});

test("the limit goes from 3 to 6 at once, survives a restart, and changes no flag; a lower one stops no run (JOBBY-CB2NF)", async () => {
  const s = await setup({ profiles: [PROFILE] });
  s.dashboard.tracker.stop();
  try {
    await s.settle();
    await see(s, "TST-TASK1");
    for (const id of ["TST-WRK01", "TST-WRK02", "TST-WRK03"]) hold(s, id, "in_progress", { activity: "working" });
    hold(s, "TST-HLD01", "in_progress", { activity: "stopped" });
    // A project flag that waits (Anna's run of TST-RD002 is live in core), a blocked task's, a ready task's.
    s.dashboard.autopilot!.set({ space: "TST", project: "core", on: true });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-DEP01", on: true });
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    let read = readAutopilot(s.ctx);
    assert.equal(read.max_running, 3, "the default");
    assert.equal(read.running, 3, "the stopped agent takes no slot");
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.match(flag(s, "TST-TASK1")?.state ?? "", /waits: 3 runs of this Mac are at work \(the autopilot's limit is 3\)/);

    // The limit is this Mac's: no space needed, and a flag needs one.
    assert.equal(setAutopilot(s.ctx, { task: "TST-TASK1", on: false }).error, "Name the space of the flag.");
    assert.deepEqual(setAutopilot(s.ctx, { max_running: 6 }), { ok: true, error: "" });
    // Its own pass starts the ready task without waiting for a sync.
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    // The start's sync replaced the plan the holds above were written into: they are written again.
    await s.settle();
    for (const id of ["TST-WRK01", "TST-WRK02", "TST-WRK03"]) hold(s, id, "in_progress", { activity: "working" });
    hold(s, "TST-HLD01", "in_progress", { activity: "stopped" });
    read = readAutopilot(s.ctx);
    assert.equal(read.max_running, 6);
    assert.deepEqual(
      read.flags.map((f) => f.task || f.project),
      ["TST-DEP01", "core"],
      "the other flags stay as they were",
    );

    // After a restart the limit and the flags are read back.
    s.dashboard.autopilot = new Autopilot(s.dashboard, join(s.dashboard.dataDir, "autopilot.json"));
    read = readAutopilot(s.ctx);
    assert.equal(read.max_running, 6);
    assert.deepEqual(read.flags.map((f) => f.task || f.project), ["TST-DEP01", "core"]);

    // Below the runs at work: nothing stops, nothing more starts.
    const before = read.runs.map((r) => [r.task, r.activity, r.holds_place]);
    assert.equal(read.running, 4, "three held by hand and TST-TASK1");
    assert.equal(setAutopilot(s.ctx, { max_running: 1 }).ok, true);
    await s.dashboard.autopilot.pass(s.ctx);
    read = readAutopilot(s.ctx);
    assert.equal(read.max_running, 1);
    assert.deepEqual(read.runs.map((r) => [r.task, r.activity, r.holds_place]), before);
    assert.equal(read.running, 4);
    for (const id of ["TST-WRK01", "TST-WRK02", "TST-WRK03"]) assert.equal(s.dashboard.runs!.runs.get(`r-${id}`)?.activity, "working", id);
    assert.equal(s.task("TST-TASK1")?.status, "in_progress");
  } finally {
    s.stop();
  }
});

test("a limit raised while a pass is under way gets a pass of its own after it, not after the next sync", async () => {
  const s = await setup({ profiles: [PROFILE] });
  s.dashboard.tracker.stop();
  try {
    await s.settle();
    await see(s, "TST-TASK1");
    for (const id of ["TST-WRK01", "TST-WRK02", "TST-WRK03"]) hold(s, id, "in_progress", { activity: "working" });
    const autopilot = s.dashboard.autopilot!;
    autopilot.set({ space: "TST", task: "TST-TASK1", on: true });
    // The first pass finds the limit of 3 full and is held at its end until the limit has changed.
    const inner = autopilot as unknown as { check: (ctx: WriteContext) => Promise<boolean> };
    const check = inner.check.bind(autopilot);
    let checked!: () => void;
    const firstChecked = new Promise<void>((resolve) => (checked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let passes = 0;
    inner.check = async (ctx) => {
      const pass = ++passes;
      const result = await check(ctx);
      if (pass === 1) {
        checked();
        await gate;
      }
      return result;
    };
    const first = autopilot.pass(s.ctx);
    await firstChecked;
    assert.match(flag(s, "TST-TASK1")?.state ?? "", /^not checked yet/, "the first pass has not finished");
    assert.equal(s.task("TST-TASK1")?.status, "todo", "the first pass read the old limit");
    assert.equal(setAutopilot(s.ctx, { max_running: 6 }).ok, true);
    release();
    await first;
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");
    assert.equal(passes, 2);
  } finally {
    s.stop();
  }
});

test("a pass and a person's start of the same task at once make one run and one agent", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    await see(s, "TST-TASK1");
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    const plan = await planStart(s.ctx, { task: "TST-TASK1" });
    assert.ok("found" in plan);
    const [, manual] = await Promise.all([s.dashboard.autopilot!.pass(s.ctx), startTask(s.ctx, { task: "TST-TASK1" }, { seen: plan.instructions.map((p) => p.hash) })]);
    await settled(() => [...s.fake.agents.values()].length > 0);
    await s.settle();
    await s.dashboard.autopilot!.pass(s.ctx);
    const runs = [...s.dashboard.runs!.runs.values()].filter((r) => r.task === "TST-TASK1");
    assert.equal(runs.length, 1, `one run (the person's start answered: ${manual.error || "ok"})`);
    assert.equal(s.fake.agents.size, 1, "one agent");
    assert.equal(s.task("TST-TASK1")?.run_id, runs[0]!.run_id);
    assert.equal(flag(s, "TST-TASK1"), undefined);
  } finally {
    s.stop();
  }
});

test("a usage limit holds every start until its reset, then the queue goes on; the task that met it is not started again", async () => {
  const s = await setup({ profiles: [PROFILE] });
  s.dashboard.tracker.stop();
  try {
    let clock = new Date("2026-11-15T10:00:00.000Z");
    const autopilot = s.dashboard.autopilot!;
    autopilot.now = () => clock;
    await see(s, "TST-TASK1");
    await see(s, "TST-TASK2");
    await see(s, "TST-FX001");
    autopilot.set({ space: "TST", project: "core", on: true });
    autopilot.set({ space: "TST", task: "TST-TASK1", on: true });
    await autopilot.pass(s.ctx);
    await settled(() => Boolean(s.dashboard.runs!.byTask("TST-TASK1")?.agentId));
    const first = s.dashboard.runs!.byTask("TST-TASK1")!;
    // Its first turn fails on the limit; Claude Code names the reset as a Unix time.
    const reset = new Date("2026-11-15T12:00:00.000Z");
    s.dashboard.runs!.setActivity(first, "failed", "2026-11-15T10:01:00.000Z", { error: `Claude AI usage limit reached|${reset.getTime() / 1000}` });
    autopilot.set({ space: "TST", task: "TST-TASK2", on: true });
    clock = new Date("2026-11-15T10:02:00.000Z");
    await autopilot.pass(s.ctx);
    assert.equal(s.task("TST-TASK2")?.status, "todo", "nothing starts into the limit");
    assert.match(flag(s, "TST-TASK2")?.state ?? "", /^waits: a usage limit holds every start until 2026-11-15T12:00:00.000Z \(the agent of TST-TASK1 met a usage limit: .*; it resets then, as the error says\)$/);
    assert.equal(flag(s, "core")?.paused, false, "a limit is no failure that pauses the line");
    assert.equal(readAutopilot(s.ctx).limit.until, reset.toISOString());
    await autopilot.pass(s.ctx);
    assert.equal(s.task("TST-TASK2")?.status, "todo");

    // After the reset the queue goes on; the task that met the limit keeps its one run.
    clock = new Date("2026-11-15T12:00:30.000Z");
    await autopilot.pass(s.ctx);
    await settled(() => s.task("TST-TASK2")?.status === "in_progress");
    assert.equal(s.task("TST-TASK2")?.status, "in_progress");
    assert.equal(readAutopilot(s.ctx).limit.until, "");
    assert.deepEqual([s.task("TST-TASK1")?.run_id, [...s.dashboard.runs!.runs.values()].filter((r) => r.task === "TST-TASK1").length], [first.run_id, 1]);
    await settled(() => Boolean(s.dashboard.runs!.byTask("TST-TASK2")?.agentId));

    // The start after the hold meets the limit again, with no reset named and no usage report: a longer backoff.
    const second = s.dashboard.runs!.byTask("TST-TASK2")!;
    assert.equal((second.attempts.at(-1)?.agentRequest.config as { provider?: string }).provider?.split("/")[0], "claude", "the provider the usage report is read for");
    s.dashboard.runs!.setActivity(second, "failed", "2026-11-15T12:01:00.000Z", { error: "rate limited" });
    clock = new Date("2026-11-15T12:02:00.000Z");
    await autopilot.pass(s.ctx);
    const held = readAutopilot(s.ctx).limit;
    assert.equal(held.until, "2026-11-15T12:31:00.000Z");
    assert.match(held.source, /no reset time known \(Paseo's usage report: this Paseo has no usage report\), so 30 min after it/);

    // Where Paseo has its usage report on, it is read once the hold is over, and its reset extends it.
    (s.dashboard.paseo!.providers as unknown as { listUsage: () => Promise<unknown> }).listUsage = async () => ({
      providers: [{ providerId: "claude", status: "available", windows: [{ label: "5-hour", usedPct: 100, resetsAt: "2026-11-15T13:00:00.000Z" }] }],
    });
    clock = new Date("2026-11-15T12:32:00.000Z");
    await autopilot.pass(s.ctx);
    assert.equal(readAutopilot(s.ctx).limit.until, "2026-11-15T13:00:00.000Z");
    assert.match(readAutopilot(s.ctx).limit.source, /Paseo's usage report said 5-hour resets later/);
    // An agent that finished a turn after the hold ended: the limit is gone and the backoff starts over.
    clock = new Date("2026-11-15T13:05:00.000Z");
    s.dashboard.runs!.setActivity(second, "waiting", "2026-11-15T13:04:00.000Z");
    await autopilot.pass(s.ctx);
    const file = JSON.parse(readFileSync(join(s.dashboard.dataDir, "autopilot.json"), "utf8")) as { limit?: unknown };
    assert.equal(file.limit, undefined);
    // The failure it counted is not counted again: later passes read no usage report and hold nothing.
    let reads = 0;
    (s.dashboard.paseo!.providers as unknown as { listUsage: () => Promise<unknown> }).listUsage = async () => (reads++, { providers: [] });
    // Its agent starts a new turn: no turn ends after any hold now, so a recount would read the report.
    s.dashboard.runs!.setActivity(second, "working", "2026-11-15T13:06:00.000Z");
    await autopilot.pass(s.ctx);
    await autopilot.pass(s.ctx);
    assert.deepEqual([reads, readAutopilot(s.ctx).limit.until], [0, ""]);
    assert.equal((JSON.parse(readFileSync(join(s.dashboard.dataDir, "autopilot.json"), "utf8")) as { limit?: unknown }).limit, undefined);
  } finally {
    s.stop();
  }
});

test("a limit is read in the usage report of the provider the agent runs on", async () => {
  const s = await setup({ profiles: [{ id: "p2", name: "Codex", provider: "codex" }], providers: ["codex"] });
  s.dashboard.tracker.stop();
  try {
    const autopilot = s.dashboard.autopilot!;
    autopilot.now = () => new Date("2026-11-15T10:02:00.000Z");
    await see(s, "TST-TASK1");
    autopilot.set({ space: "TST", task: "TST-TASK1", on: true });
    await autopilot.pass(s.ctx);
    await settled(() => Boolean(s.dashboard.runs!.byTask("TST-TASK1")?.agentId));
    (s.dashboard.paseo!.providers as unknown as { listUsage: () => Promise<unknown> }).listUsage = async () => ({
      providers: [
        { providerId: "claude", status: "available", windows: [{ label: "5-hour", usedPct: 100, resetsAt: "2026-11-15T15:00:00.000Z" }] },
        { providerId: "codex", status: "available", windows: [{ label: "weekly", usedPct: 100, resetsAt: "2026-11-15T11:00:00.000Z" }] },
      ],
    });
    s.dashboard.runs!.setActivity(s.dashboard.runs!.byTask("TST-TASK1")!, "failed", "2026-11-15T10:01:00.000Z", { error: "429 Too Many Requests" });
    // A pass runs only with a flag set.
    autopilot.set({ space: "TST", task: "TST-TASK2", on: true });
    await autopilot.pass(s.ctx);
    assert.deepEqual(readAutopilot(s.ctx).limit.until, "2026-11-15T11:00:00.000Z");
    assert.match(readAutopilot(s.ctx).limit.source, /Paseo's usage report says weekly resets then/);
  } finally {
    s.stop();
  }
});
