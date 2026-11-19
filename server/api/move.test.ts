import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { Dashboard } from "../dashboard.ts";
import { opaqueId } from "../plan/ids.ts";
import { FakePaseo } from "../runner/testing.ts";
import { taskView } from "../views.ts";
import { startCheck } from "./reads.ts";
import { moveTask, releaseTask, startTask, updateTask } from "./writes.ts";
import { NOW, setup } from "./testing.ts";

/** Where a task sits, as the move dialog shows it. */
function place(task: Task | undefined) {
  const id = (ref: string | undefined) => /\[\[([A-Z]+-[0-9A-Z]{5})/.exec(ref ?? "")?.[1] ?? ref ?? "";
  return { project: task?.project ?? "", feature: id(task?.feature), milestone: id(task?.milestone) };
}

/** A second machine with its own dashboard on the same plan repo. */
async function secondMachine(remote: string) {
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-api-")), fetchIntervalMs: 3_600_000 });
  dashboard.attach(new FakePaseo({}).api());
  await dashboard.addSpace({ remote });
  const sync = () => dashboard.spaces.get("TST")!.sync;
  return {
    dashboard,
    ctx: { dashboard, now: () => NOW, host: "anna-mbp" },
    sync,
    task: (id: string) => sync().plan.entities.get(id)?.entity as Task | undefined,
  };
}

test("a move changes the release, the feature or the line; empty takes the task out of its feature or release", async () => {
  const s = await setup();
  try {
    const moved = await moveTask(s.ctx, { task: "TST-FX001", feature: "TST-FEAT0", milestone: "TST-MS001", from: place(s.task("TST-FX001")) });
    assert.equal(moved.ok, true, moved.error);
    assert.deepEqual(moved.changed, ["feature", "milestone"]);
    assert.deepEqual(place(s.task("TST-FX001")), { project: "core", feature: "TST-FEAT0", milestone: "TST-MS001" });
    const file = await s.remoteFile(/TST-FX001-/);
    assert.match(file ?? "", /feature: "\[\[TST-FEAT0-totp\]\]"/);
    assert.match(file ?? "", /milestone: "\[\[TST-MS001-release-2-3\]\]"/);

    const out = await moveTask(s.ctx, { task: "TST-FX001", feature: "", milestone: "", from: place(s.task("TST-FX001")) });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(place(s.task("TST-FX001")), { project: "core", feature: "", milestone: "" });
    const cleared = await s.remoteFile(/TST-FX001-/);
    assert.doesNotMatch(cleared ?? "", /^(feature|milestone):/m, "an empty field is removed, not written blank");

    const line = await moveTask(s.ctx, { task: "TST-TASK2", project: "site", from: place(s.task("TST-TASK2")) });
    assert.equal(line.ok, true, line.error);
    assert.equal(s.task("TST-TASK2")?.project, "site");
    const nothing = await moveTask(s.ctx, { task: "TST-TASK2", project: "site", from: place(s.task("TST-TASK2")) });
    assert.deepEqual([nothing.ok, nothing.changed], [true, []]);
    const unknown = await moveTask(s.ctx, { task: "TST-TASK2", feature: "TST-ZZZZZ", from: place(s.task("TST-TASK2")) });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /No feature TST-ZZZZZ/);
  } finally {
    s.stop();
  }
});

test("a started task keeps its line, through the move and through update_task, with the same reason", async () => {
  const s = await setup();
  try {
    const reason = /«Login page redesign» \(TST-RD002\) was started in core, and its branch belongs to that repository; its project cannot change/;
    assert.match(taskView(s.dashboard, { task: "TST-RD002" }).actions.line, reason);
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).actions.line, "", "never started: the line may change");

    const viaMove = await moveTask(s.ctx, { task: "TST-RD002", project: "site", milestone: "TST-MS001", from: place(s.task("TST-RD002")) });
    assert.equal(viaMove.ok, false);
    assert.match(viaMove.error, reason);
    const viaUpdate = await updateTask(s.ctx, { task: "TST-RD002", project: "site", title: "Renamed" });
    assert.equal(viaUpdate.ok, false);
    assert.match(viaUpdate.error, reason);
    assert.match(viaUpdate.error, /Nothing was changed\./);
    assert.deepEqual([s.task("TST-RD002")?.project, s.task("TST-RD002")?.title, s.task("TST-RD002")?.milestone], ["core", "Login page redesign", undefined]);

    // Its release and feature still move, and naming its own project again is not a change.
    const release = await moveTask(s.ctx, { task: "TST-RD002", project: "core", milestone: "TST-MS001", from: place(s.task("TST-RD002")) });
    assert.equal(release.ok, true, release.error);
    assert.deepEqual(release.changed, ["milestone"]);
    assert.equal((await updateTask(s.ctx, { task: "TST-RD002", project: "core" })).ok, true);

    // A released run's branch still belongs to its repository.
    assert.equal((await releaseTask(s.ctx, { task: "TST-RD002", to: "todo" })).ok, true);
    const released = await updateTask(s.ctx, { task: "TST-RD002", project: "site" });
    assert.equal(released.ok, false);
    assert.match(released.error, reason);
  } finally {
    s.stop();
  }
});

test("a move made on one machine shows on another after sync; a stale dialog refuses instead of overwriting", async () => {
  const s = await setup();
  const anna = await secondMachine(s.f.remote);
  try {
    const seenByAnna = place(anna.task("TST-FX001"));
    const moved = await moveTask(s.ctx, { task: "TST-FX001", milestone: "TST-MS001", feature: "TST-FEAT0", from: place(s.task("TST-FX001")) });
    assert.equal(moved.ok, true, moved.error);
    await s.sync().sync();
    await anna.sync().sync();
    assert.deepEqual(place(anna.task("TST-FX001")), { project: "core", feature: "TST-FEAT0", milestone: "TST-MS001" });
    const view = taskView(anna.dashboard, { task: "TST-FX001" });
    assert.deepEqual([view.feature?.id, view.milestone?.id], ["TST-FEAT0", "TST-MS001"]);

    // Anna's dialog opened before the move came in: her move is refused and names what changed.
    const stale = await moveTask(anna.ctx, { task: "TST-FX001", feature: "", from: seenByAnna });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /changed by someone else since this opened: feature is now TST-FEAT0, milestone is now TST-MS001\. Nothing was changed/);
    assert.equal(anna.task("TST-FX001")?.feature, "[[TST-FEAT0-totp]]");
  } finally {
    s.stop();
    anna.dashboard.stop();
  }
});

test("two machines moving the same task at once: the later one conflicts on its expect, visibly", async () => {
  const s = await setup();
  const anna = await secondMachine(s.f.remote);
  try {
    const first = await moveTask(anna.ctx, { task: "TST-FX001", feature: "TST-FEAT0", from: place(anna.task("TST-FX001")) });
    assert.equal(first.ok, true, first.error);
    await anna.sync().sync();
    // This machine has not fetched yet: the move applies locally, and its replay on origin's state is refused.
    const second = await moveTask(s.ctx, { task: "TST-FX001", feature: "", from: place(s.task("TST-FX001")) });
    assert.equal(second.ok, true, second.error);
    await s.sync().sync();
    assert.equal(s.task("TST-FX001")?.feature, "[[TST-FEAT0-totp]]", "the first move stands");
    assert.deepEqual(
      s.sync().state.conflicts.map((c) => c.reason),
      ['feature of TST-FX001 is now "[[TST-FEAT0-totp]]"'],
    );
  } finally {
    s.stop();
    anna.dashboard.stop();
  }
});

test("a claim that lands first on another machine refuses a line move this machine made before it saw the claim", async () => {
  const s = await setup();
  const anna = s.f.sync("anna");
  try {
    const run = { run_id: opaqueId("r"), run_by: "anna", run_host: "anna-mbp", run_branch: "task/tst-task2-two", run_started: NOW.toISOString() };
    assert.equal((await anna.claim("TST-TASK2", run)).result, "won");
    const moved = await moveTask(s.ctx, { task: "TST-TASK2", project: "site", from: place(s.task("TST-TASK2")) });
    assert.equal(moved.ok, true, "applied locally before the claim is fetched");
    await s.sync().sync();
    assert.equal(s.task("TST-TASK2")?.project, "core");
    assert.equal(s.task("TST-TASK2")?.run_by, "anna");
    assert.match(s.sync().state.conflicts[0]?.reason ?? "", /«two» \(TST-TASK2\) was started in core, and its branch belongs to that repository/);
  } finally {
    s.stop();
  }
});

test("a start re-checks on fetched state: a task moved to another line or feature meanwhile is not claimed", async () => {
  const s = await setup();
  try {
    const edit = (file: string, from: string, to: string) =>
      s.f.external("anna", (root) => {
        const path = join(root, "tasks", file);
        writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
      });
    edit("TST-FX001-fix-flaky-login-test.md", 'feature: "[[TST-FEAT1-login]]"\n', 'feature: "[[TST-FEAT0-totp]]"\n');
    assert.equal((await startCheck(s.ctx, { task: "TST-FX001" })).error, "", "the local index has not fetched it yet");
    const feature = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(feature.ok, false);
    assert.match(feature.error, /was moved to another feature since it was checked; check it again/);

    edit("TST-DEP01-blocked-thing.md", "project: core\n", "project: site\n");
    const line = await startTask(s.ctx, { task: "TST-DEP01" }, { startPast: ["TST-TASK1"] });
    assert.equal(line.ok, false);
    assert.match(line.error, /was moved to another project since it was checked; check it again/);
    assert.equal(s.task("TST-DEP01")?.run_id, undefined);
  } finally {
    s.stop();
  }
});

test("the dialog's starting point comes from the task view, also for a feature link the plan no longer has", async () => {
  const s = await setup();
  try {
    s.f.external("anna", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      writeFileSync(path, readFileSync(path, "utf8").replace('feature: "[[TST-FEAT1-login]]"\n', 'feature: "[[TST-GN9E1-removed]]"\n'));
    });
    await s.sync().sync();
    const view = taskView(s.dashboard, { task: "TST-FX001" });
    assert.deepEqual([view.feature, view.own_feature], [null, "TST-GN9E1"]);
    const from = { project: view.project, feature: view.own_feature, milestone: view.own_milestone };
    const cleared = await moveTask(s.ctx, { task: "TST-FX001", feature: "", from });
    assert.equal(cleared.ok, true, cleared.error);
    assert.equal(s.task("TST-FX001")?.feature, undefined);
    // Naming a started task's own project is not a line change, so it is not refused.
    const same = await moveTask(s.ctx, { task: "TST-RD002", project: "core", from: place(s.task("TST-RD002")) });
    assert.deepEqual([same.ok, same.changed], [true, []]);
  } finally {
    s.stop();
  }
});
