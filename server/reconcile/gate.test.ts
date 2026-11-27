import { test } from "node:test";
import assert from "node:assert/strict";
import { getTask } from "../api/reads.ts";
import { startTask, updateTask } from "../api/writes.ts";
import { settled } from "../runner/testing.ts";
import { MERGED_AT, reconcileSetup } from "./testing.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

/**
 * A live run's own merged PR/MR in a project the owner reconciles ends the run only when everything
 * is verified; a merge with QA open ends nothing, stops no agent and restarts nothing.
 */
test("a run's merge with QA open leaves the run as it is; once QA passed the merge ends it, documented", async () => {
  const s = await reconcileSetup("close", { paseo: { profiles: [PROFILE] } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    // The run's own branch, merged well after the run started; every line ticked and QA still to come.
    s.github.prs = [{ n: 7, head: "feat/login", state: "MERGED", mergedAt: MERGED_AT, checks: ["SUCCESS"], headSha: "a".repeat(40) }];
    s.github.tips["feat/login"] = "a".repeat(40);
    await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-FX001", line: "second", done: true, run_id: run.run_id }]).outcomes;
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", delivery: { qa: "pending" } })).ok, true);

    await s.dashboard.prs.checkAll();
    await s.settle();
    const held = s.task("TST-FX001")!;
    assert.deepEqual([held.status, held.run_id, held.run_ended, held.auto_closed], ["in_progress", run.run_id, undefined, undefined]);
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /^#7 merged — merged; not closed: QA has not passed/);
    assert.notEqual(run.activity, "stopped", "its agent is left alone");
    assert.equal(run.stoppedAt, undefined);
    assert.deepEqual(s.fake.archived, [], "its workspace is not archived");
    assert.equal(s.dashboard.runs!.byTask("TST-FX001"), run, "and no new run took its place");

    // QA's result is recorded: the next look at the merge ends the run once.
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", delivery: { qa: "passed" } })).ok, true);
    await s.dashboard.prs.checkAll();
    await s.settle();
    const done = s.task("TST-FX001")!;
    assert.equal(done.status, "done", getTask(s.ctx, { task: "TST-FX001" }).pr);
    assert.equal(done.run_ended, done.auto_closed?.at);
    assert.deepEqual(done.auto_closed?.prs, ["https://github.com/acme/core/pull/7"]);
    assert.match(done.auto_closed?.note ?? "", /QA passed/);
    await s.dashboard.prs.checkAll();
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.entity.updated, done.updated, "an ended run is not closed twice");
  } finally {
    s.stop();
  }
});

test("under the report rule a run's merge ends nothing by itself either, and says so", async () => {
  const s = await reconcileSetup("report", { paseo: { profiles: [PROFILE] } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.github.prs = [{ n: 7, head: "feat/login", state: "MERGED", mergedAt: MERGED_AT, checks: ["SUCCESS"], headSha: "a".repeat(40) }];
    s.github.tips["feat/login"] = "a".repeat(40);
    await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-FX001", line: "second", done: true, run_id: run.run_id }]).outcomes;
    await s.dashboard.prs.checkAll();
    await s.settle();
    assert.equal(s.task("TST-FX001")!.status, "in_progress");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /not closed: #7 merged and everything the rule asks is verified; this Mac only reports/);
  } finally {
    s.stop();
  }
});

test("in a project that is off the run's own rule stands: its merge with every line ticked ends it as before", async () => {
  const s = await reconcileSetup("off", { paseo: { profiles: [PROFILE] } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.github.prs = [{ n: 7, head: "feat/login", state: "MERGED", mergedAt: MERGED_AT, checks: [], headSha: "a".repeat(40) }];
    s.github.tips["feat/login"] = "a".repeat(40);
    await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-FX001", line: "second", done: true, run_id: run.run_id }]).outcomes;
    await s.dashboard.prs.checkAll();
    await s.settle();
    assert.equal(s.task("TST-FX001")!.status, "done");
    assert.equal(s.task("TST-FX001")!.auto_closed, undefined, "no rule closed it: no record on the card");
  } finally {
    s.stop();
  }
});
