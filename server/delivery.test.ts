import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryInput } from "../shared/api.ts";
import type { Delivery, Task } from "../shared/model.ts";
import { getTaskWithRuns } from "./api/reads.ts";
import { setup } from "./api/testing.ts";
import { updateTask } from "./api/writes.ts";
import { deliveryView, stageHolds, taskDelivery } from "./delivery.ts";
import { systemGit } from "./sync/git.ts";

/**
 * The way from a merged MR to accepted work (JOBBY-YV2QS, part 5). "Code merged" read as "done":
 * site !412 merged while stage still ran an older build, the flags were not on, and QA had no device;
 * nothing said who acted next.
 */

const MERGE = "5e1f0c4a9b2d7e3f8a6c1d0b4e9f2a7c3b8d6e10";
const OLD_STAGE = "aaaaaaa1111111111111111111111111111111111";

function taskOf(delivery: Partial<Delivery> | undefined, extra: Partial<Task> = {}): Task {
  return { id: "ERG-7MRG1", title: "Start signal", status: "todo", links: [], labels: [], depends_on: [], requires: [], delivery: delivery as Delivery, ...extra } as unknown as Task;
}

const merged = { label: "!412", url: "https://git.example.com/frontend/site/-/merge_requests/412", state: "merged", sha: MERGE };
const acceptance = [{ done: true, text: "diagnostics logged" }, { done: false, text: "QA: signal heard in Safari 17" }];

test("merged with an older stage waits for the stage; CI passing never passes QA", () => {
  const none = deliveryView({ task: taskOf(undefined), loaded: { acceptance }, merge: merged, checks: "passing", holds: "unknown" });
  assert.deepEqual([none.stage, none.next_by], ["waiting_for_stage", "deploy"]);
  assert.match(none.next, /no stage build is recorded/);
  const old = deliveryView({ task: taskOf({ stage_sha: OLD_STAGE }), loaded: { acceptance }, merge: merged, checks: "passing", holds: "no" });
  assert.deepEqual([old.stage, old.next_by], ["waiting_for_stage", "deploy"]);
  assert.match(old.next, /older than the merge 5e1f0c4/);
  assert.equal(old.steps.find((s) => s.step === "QA")?.state, "pending", "passing checks tick no manual QA");
  assert.match(old.steps.find((s) => s.step === "QA")!.fact, /1 of 2 acceptance lines open/);
});

test("the stage holds the merge: a missing device or flags are named before QA; with all there it is QA's turn", () => {
  const setup = deliveryView({
    task: taskOf({ stage_sha: MERGE, flags: ["signal_v2"], flags_ready: true, device: "iPhone 14 Pro, iOS 26", device_ready: false }),
    loaded: { acceptance },
    merge: merged,
    checks: undefined,
    holds: "yes",
  });
  assert.deepEqual([setup.stage, setup.next_by], ["waiting_for_setup", "owner"]);
  assert.match(setup.next, /device iPhone 14 Pro, iOS 26/);
  assert.equal(setup.steps.find((s) => s.step === "Device")?.fact, "missing: iPhone 14 Pro, iOS 26");

  const ready = deliveryView({
    task: taskOf({ stage_sha: MERGE, stage_url: "https://stage.example.com", flags: ["signal_v2"], flags_ready: true, access_ready: true, device: "iPhone 14 Pro", device_ready: true }, { links: ["https://trello.com/c/AbCd1234"] }),
    loaded: { acceptance },
    merge: merged,
    checks: "passing",
    holds: "yes",
  });
  assert.deepEqual([ready.stage, ready.next_by], ["ready_for_qa", "QA"]);
  assert.match(ready.trello_blocker, /no Trello access/);
  assert.match(ready.qa_handoff, /- \[ \] QA: signal heard in Safari 17/);
  assert.match(ready.qa_handoff, /Stage: https:\/\/stage\.example\.com/);
  assert.doesNotMatch(ready.qa_handoff, /diagnostics logged/, "a ticked line is not asked again");
});

test("QA's result moves it, never the merge alone; accepted only once the task is done", () => {
  const base = { stage_sha: MERGE, access_ready: true };
  const failed = deliveryView({ task: taskOf({ ...base, qa: "failed", qa_note: "no sound on retry" }), loaded: { acceptance }, merge: merged, checks: "passing", holds: "yes" });
  assert.deepEqual([failed.stage, failed.next_by], ["qa_failed", "agent"]);
  const passed = deliveryView({ task: taskOf({ ...base, qa: "passed" }), loaded: { acceptance }, merge: merged, checks: "passing", holds: "yes" });
  assert.deepEqual([passed.stage, passed.next_by], ["qa_passed", "owner"]);
  assert.match(passed.next, /1 acceptance line\(s\) still open/);
  const done = deliveryView({ task: taskOf({ ...base, qa: "passed" }, { status: "done" }), loaded: { acceptance }, merge: merged, checks: "passing", holds: "yes" });
  assert.equal(done.stage, "accepted");
  const open = deliveryView({ task: taskOf(undefined), loaded: { acceptance }, merge: { ...merged, state: "open", sha: "" }, checks: "pending", holds: "unknown" });
  assert.deepEqual([open.stage, open.next_by], ["waiting_for_ci", "CI"]);
});

test("whether the stage build holds the merge is git's answer in the checkout, unknown for a commit it lacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "merge");
  const merge = git("rev-parse", "HEAD");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "later");
  const later = git("rev-parse", "HEAD");
  assert.equal(await stageHolds(systemGit, dir, merge, later), "yes");
  assert.equal(await stageHolds(systemGit, dir, later, merge), "no", "an older stage build does not hold it");
  assert.equal(await stageHolds(systemGit, dir, merge, "1234567890abcdef1234567890abcdef12345678"), "unknown");
  assert.equal(await stageHolds(systemGit, undefined, merge, later), "unknown", "no checkout here");
});

test("delivery facts are recorded through update_task with their day; a field left out stays, \"\" clears it", async () => {
  const s = await setup();
  try {
    const first = await updateTask(s.ctx, { task: "TST-FX001", delivery: { stage_sha: "abc1234", flags: ["signal_v2"], device: "iPhone 14", device_ready: false, trello: "https://trello.com/c/AbCd1234", trello_state: "In QA" } });
    assert.equal(first.ok, true, first.error);
    const d = () => s.task("TST-FX001")!.delivery!;
    assert.deepEqual([d().stage_sha, d().flags, d().device, d().device_ready, d().trello_state], ["abc1234", ["signal_v2"], "iPhone 14", false, "In QA"]);
    assert.ok(d().stage_checked && d().trello_checked, "the day each group was recorded");
    const second = await updateTask(s.ctx, { task: "TST-FX001", delivery: { device_ready: true, flags: [] } });
    assert.equal(second.ok, true, second.error);
    assert.deepEqual([d().stage_sha, d().device_ready, d().flags], ["abc1234", true, []], "the rest stays; [] clears the flags");
    assert.equal(s.task("TST-FX001")!.status, "todo", "nothing else changes");
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.equal(view.error, "");
    assert.match(view.trello_blocker, /no Trello access/);
    const read = await getTaskWithRuns(s.ctx, { task: "TST-FX001" });
    assert.match(read.delivery ?? "", /^in_work; next agent/);
    assert.equal((await getTaskWithRuns(s.ctx, { task: "TST-TASK1" })).delivery, undefined, "left out without delivery to show");
  } finally {
    s.stop();
  }
});

test("the contract refuses what is not a sha, an https URL or a Trello card", () => {
  assert.equal(deliveryInput.safeParse({ stage_sha: "not a sha" }).success, false);
  assert.equal(deliveryInput.safeParse({ stage_url: "http://stage" }).success, false);
  assert.equal(deliveryInput.safeParse({ trello: "https://example.com/c/x" }).success, false);
  assert.equal(deliveryInput.safeParse({ stage_sha: "", trello: "" }).success, true, "\"\" clears");
});
