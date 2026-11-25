import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncAnswer } from "../spaces/list.ts";
import { featureView, taskView } from "../views.ts";
import { readBoard } from "./reads.ts";
import { setup } from "./testing.ts";
import { archiveTasks, releaseTask, updateTask } from "./writes.ts";

/**
 * JOBBY-7QK3T (03-model.md, Statuses and Archive): a task in progress that no run holds is closed,
 * put back or started by a person; finished tasks are archived off the board and put back; Sync says
 * when each space last fetched and why it failed.
 */

type Setup = Awaited<ReturnType<typeof setup>>;

/** Edits a task's file on origin as another machine (or a hub's plan MR) would, then fetches it. */
async function edit(s: Setup, file: string, from: string, to: string) {
  s.f.external("hub", (root) => {
    const path = join(root, "tasks", file);
    writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
  });
  await s.sync().sync();
}

const FX = "TST-FX001-fix-flaky-login-test.md";

test("in progress with no run: the person marks it done, puts it back to todo or cancels it; nothing moves it by itself", async () => {
  for (const to of ["done", "todo", "canceled"] as const) {
    const s = await setup();
    try {
      await edit(s, FX, "status: todo", "status: in_progress");
      const view = taskView(s.dashboard, { task: "TST-FX001" }, s.ctx.now!());
      assert.deepEqual(
        [view.actions.unheld, view.actions.close, view.actions.release, view.actions.start],
        [true, true, false, ""],
        "closed or started from here; there is no run to release",
      );
      await s.sync().sync();
      assert.equal(s.task("TST-FX001")!.status, "in_progress", "a sync does not move it");
      const answer = await updateTask(s.ctx, { task: "TST-FX001", status: to });
      assert.equal(answer.ok, true, answer.error);
      assert.equal(s.task("TST-FX001")!.status, to);
    } finally {
      s.stop();
    }
  }
});

test("in progress with a live run is still a release, and review with no run is not closed by update_task", async () => {
  const s = await setup();
  try {
    const held = await updateTask(s.ctx, { task: "TST-RD002", status: "done" });
    assert.match(held.error, /held by anna on anna-mbp.*use release_task/);
    assert.equal(s.task("TST-RD002")!.status, "in_progress");
    assert.equal(taskView(s.dashboard, { task: "TST-RD002" }, s.ctx.now!()).actions.unheld, false);

    await edit(s, FX, "status: todo", "status: review");
    const review = await updateTask(s.ctx, { task: "TST-FX001", status: "done" });
    assert.match(review.error, /review → done is not allowed/);

    // A run that ended long ago and left the task in progress (an edit of the plan) counts as no run.
    await edit(s, FX, "status: review", "status: in_progress\nrun_id: r-old\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/login\nrun_started: 2026-10-01T10:00:00Z\nrun_ended: 2026-10-02T10:00:00Z");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }, s.ctx.now!()).actions.unheld, true);
    assert.match((await releaseTask(s.ctx, { task: "TST-FX001", to: "done" })).error, /no live run; nothing to release\. Change its status with update_task/);
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", status: "todo" })).ok, true);
  } finally {
    s.stop();
  }
});

test("the board marks a task in progress with no run on its card", async () => {
  const s = await setup();
  try {
    await edit(s, FX, "status: todo", "status: in_progress");
    const cards = (await readBoard(s.ctx, {})).columns.find((c) => c.column === "running")!.tasks;
    assert.deepEqual(new Map(cards.map((c) => [c.id, c.unheld ?? false])), new Map([["TST-FX001", true], ["TST-RD002", false]]));
  } finally {
    s.stop();
  }
});

test("archive: done and canceled tasks leave the board, the Archived filter lists them, unarchive and reopen put them back; open tasks are refused", async () => {
  const s = await setup();
  try {
    await edit(s, FX, "status: todo", "status: done");
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "canceled" })).ok, true);

    const open = await archiveTasks(s.ctx, { archived: true, tasks: ["TST-TASK1", "TST-RD002"] });
    assert.equal(open.ok, false);
    assert.deepEqual(open.changed, []);
    assert.deepEqual(open.refused, ["TST-TASK1 is todo; only a done or canceled task is archived", "TST-RD002 is in_progress; only a done or canceled task is archived"]);

    const one = await archiveTasks(s.ctx, { archived: true, tasks: ["TST-FX001"] });
    assert.deepEqual([one.ok, one.changed], [true, ["TST-FX001"]], one.error);
    const archivedAt = s.task("TST-FX001")!.archived;
    assert.equal(archivedAt, s.ctx.now!().toISOString());
    const ids = async (archived?: boolean) => (await readBoard(s.ctx, { archived })).columns.flatMap((c) => c.tasks.map((t) => t.id));
    assert.equal((await ids()).includes("TST-FX001"), false, "off the board");
    assert.deepEqual(await ids(true), ["TST-FX001"]);
    const view = taskView(s.dashboard, { task: "TST-FX001" }, s.ctx.now!());
    assert.deepEqual([view.archived !== "", view.actions.archive_task, view.actions.unarchive], [true, false, true]);
    assert.equal(s.task("TST-FX001")!.status, "done", "the status stays");

    const back = await archiveTasks(s.ctx, { archived: false, tasks: ["TST-FX001"] });
    assert.deepEqual([back.ok, back.changed], [true, ["TST-FX001"]]);
    assert.equal(s.task("TST-FX001")!.archived, undefined);
    assert.equal((await ids()).includes("TST-FX001"), true);

    // Everything finished of the space at once; a reopen clears the archive.
    const all = await archiveTasks(s.ctx, { archived: true, finished_of: { space: "TST" } });
    assert.deepEqual([all.ok, all.changed.sort()], [true, ["TST-FX001", "TST-TASK2"]], all.error);
    assert.deepEqual((await ids(true)).sort(), ["TST-FX001", "TST-TASK2"], "canceled ones are listed too");
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "todo" })).ok, true);
    assert.equal(s.task("TST-TASK2")!.archived, undefined, "reopened: open work again");
    assert.equal((await ids()).includes("TST-TASK2"), true);

    // An `archived` an edit left on an open task does not come back when the task is finished again.
    await edit(s, "TST-TASK2-two.md", "status: todo", "status: todo\narchived: 2026-10-01T10:00:00Z");
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "done" })).ok, true);
    assert.equal(s.task("TST-TASK2")!.archived, undefined);
    assert.equal((await ids()).includes("TST-TASK2"), true, "on the board as done");

    // A field of its own in the task's file; the status and the rest stay.
    const file = await s.remoteFile(/TST-FX001/);
    assert.match(file ?? "", /\narchived: /);
    assert.match(file ?? "", /\nstatus: done\n/);
  } finally {
    s.stop();
  }
});

test("archive every finished task of a feature: only that feature's, and the feature view counts them", async () => {
  const s = await setup();
  try {
    await edit(s, FX, "status: todo", "status: done");
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK1", status: "canceled" })).ok, true);
    assert.equal(featureView(s.dashboard, { feature: "TST-FEAT1" }).finished, 1);
    const answer = await archiveTasks(s.ctx, { archived: true, finished_of: { feature: "TST-FEAT1" } });
    assert.deepEqual([answer.ok, answer.changed], [true, ["TST-FX001"]], answer.error);
    assert.equal(s.task("TST-TASK1")!.archived, undefined, "another feature's");
    assert.equal(featureView(s.dashboard, { feature: "TST-FEAT1" }).finished, 0);
    assert.match((await archiveTasks(s.ctx, { archived: false, finished_of: { feature: "TST-FEAT1" } })).error, /Name the tasks/);
  } finally {
    s.stop();
  }
});

test("Sync answers each space's last good fetch and its problem", () => {
  const space = (key: string, lastFetchOk?: string, error?: string) => ({ record: { key, name: key.toLowerCase() }, sync: { state: { lastFetchOk, error } } });
  assert.deepEqual(syncAnswer([space("LAC", "2026-11-24T10:00:00Z"), space("ERG", "2026-11-24T09:00:00Z", "the plan repo did not answer in time")]), {
    spaces: [
      { key: "LAC", name: "lac", last_sync: "2026-11-24T10:00:00Z", error: "" },
      { key: "ERG", name: "erg", last_sync: "2026-11-24T09:00:00Z", error: "the plan repo did not answer in time" },
    ],
    error: "erg (ERG): the plan repo did not answer in time",
  });
  assert.deepEqual(syncAnswer([space("LAC")]), { spaces: [{ key: "LAC", name: "lac", last_sync: "", error: "" }], error: "" });
});
