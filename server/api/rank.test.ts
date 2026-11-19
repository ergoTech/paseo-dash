import { test } from "node:test";
import assert from "node:assert/strict";
import { listTasks } from "./reads.ts";
import { rankTask, updateTask } from "./writes.ts";
import { setup } from "./testing.ts";

const ready = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await listTasks(s.ctx, { status: "todo", limit: 20 })).tasks.filter((t) => t.section === "ready").map((t) => t.id);

test("a person orders the tasks of one priority waiting to start; a move writes one rank where it fits", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await ready(s), ["TST-FX001", "TST-ST001", "TST-TASK1", "TST-TASK2"], "without ranks: release due first, then age");
    // The first move numbers the whole group in its new order, since nobody has a rank yet.
    const top = await rankTask(s.ctx, { task: "TST-TASK2", position: "top" });
    assert.deepEqual([top.ok, top.changed], [true, 4], top.error);
    assert.deepEqual(await ready(s), ["TST-TASK2", "TST-FX001", "TST-ST001", "TST-TASK1"]);
    assert.match((await s.remoteFile(/TST-TASK2-/)) ?? "", /rank: 1000/);
    // Then a move between two ranked tasks writes only the moved one.
    const down = await rankTask(s.ctx, { task: "TST-TASK2", position: "down" });
    assert.deepEqual([down.ok, down.changed], [true, 1], down.error);
    assert.deepEqual(await ready(s), ["TST-FX001", "TST-TASK2", "TST-ST001", "TST-TASK1"]);
    assert.deepEqual(await rankTask(s.ctx, { task: "TST-FX001", position: "up" }), { ok: true, id: "TST-FX001", changed: 0, error: "" }, "already first");
    const after = await rankTask(s.ctx, { task: "TST-FX001", position: "after", next_to: "TST-TASK1" });
    assert.equal(after.ok, true, after.error);
    assert.deepEqual(await ready(s), ["TST-TASK2", "TST-ST001", "TST-TASK1", "TST-FX001"]);
  } finally {
    s.stop();
  }
});

test("moves stay inside the task's section and priority; a new priority drops the old place", async () => {
  const s = await setup();
  try {
    assert.match((await rankTask(s.ctx, { task: "TST-RD002", position: "top" })).error, /in_progress with a live run; only tasks waiting to start/);
    assert.match((await rankTask(s.ctx, { task: "TST-TASK1", position: "before", next_to: "TST-DEP01" })).error, /it is blocked and TST-TASK1 is ready/);
    assert.match((await rankTask(s.ctx, { task: "TST-TASK1", position: "before" })).error, /needs next_to/);
    assert.equal((await rankTask(s.ctx, { task: "TST-TASK1", position: "top" })).ok, true);
    assert.equal((await ready(s))[0], "TST-TASK1");
    const high = await updateTask(s.ctx, { task: "TST-ST001", priority: "high" });
    assert.equal(high.ok, true, high.error);
    assert.deepEqual(high.changed, ["priority", "rank"], "its rank among medium tasks means nothing among high ones");
    assert.deepEqual((await ready(s)).slice(0, 2), ["TST-ST001", "TST-TASK1"], "a higher priority goes first; a move cannot get above it");
    assert.match((await rankTask(s.ctx, { task: "TST-TASK1", position: "before", next_to: "TST-ST001" })).error, /change the priority to move between them/);
    assert.match((await updateTask(s.ctx, { task: "TST-TASK1", priority: "low", position: "top" })).error, /change the priority first/);
    const placed = await updateTask(s.ctx, { task: "TST-TASK2", position: "top" });
    assert.deepEqual([placed.ok, placed.changed], [true, ["rank"]], placed.error);
    assert.equal((await ready(s))[1], "TST-TASK2");
    assert.match((await rankTask(s.ctx, { task: "TST-TASK2", position: "up", next_to: "TST-TASK1" })).error, /next_to goes only with position before or after/);
    assert.match((await updateTask(s.ctx, { task: "TST-TASK2", depends_on: ["TST-TASK1"], position: "top" })).error, /change the dependencies first/);
    // Closing and reopening puts it among the ready ones again, after those with a place.
    assert.deepEqual((await updateTask(s.ctx, { task: "TST-TASK2", status: "done" })).changed, ["rank", "status"]);
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "todo" })).ok, true);
    assert.equal((await ready(s)).at(-1), "TST-TASK2");
  } finally {
    s.stop();
  }
});

test("waiting for a task that already waits for this one is refused: neither could ever start", async () => {
  const s = await setup();
  try {
    // TST-DEP01 waits for TST-TASK1.
    const loop = await updateTask(s.ctx, { task: "TST-TASK1", depends_on: ["TST-DEP01"] });
    assert.equal(loop.ok, false);
    assert.match(loop.error, /cannot wait for TST-DEP01 → TST-TASK1: that already waits for it, a loop/);
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", depends_on: ["TST-DEP01"] })).ok, true, "no loop: fine");
  } finally {
    s.stop();
  }
});
