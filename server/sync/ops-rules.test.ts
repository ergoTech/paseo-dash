import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { loadPlan } from "../plan/load.ts";
import { applyOperation, derivedFeatureStatus } from "./ops.ts";

test("a run's move to review is dated, and the next claim clears the date with the other run fields", () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-review-at-"));
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "space.yaml"), "schema: paseo-dashboard/1\nkey: TST\nname: Test\nprojects:\n  core: { remote: git@example.com:a/core.git }\n");
  writeFileSync(join(root, "tasks", "TST-T0001-one.md"), "---\nid: TST-T0001\ntype: task\ntitle: one\nstatus: todo\nproject: core\n---\n");
  const plan = loadPlan(root);
  const task = () => plan.entities.get("TST-T0001")!.entity as Task;
  const run = (id: string) => ({ run_id: id, run_by: "ergo", run_host: "mbp", run_branch: "task/one", run_started: "2026-10-26T09:00:00Z" });
  const now = "2026-10-26T12:00:00.000Z";
  assert.equal(applyOperation(root, plan, { op_id: "o1", kind: "claim", id: "TST-T0001", run: run("r-1") }, now).status, "applied");
  assert.equal(applyOperation(root, plan, { op_id: "o2", kind: "transition", id: "TST-T0001", to: "review", run_id: "r-1", at: "2026-10-26T10:00:00Z" }, now).status, "applied");
  assert.equal(task().run_review_at, "2026-10-26T10:00:00Z");
  assert.equal(applyOperation(root, plan, { op_id: "o3", kind: "release", id: "TST-T0001", run_id: "r-1", to: "todo", at: "2026-10-26T11:00:00Z" }, now).status, "applied");
  assert.equal(applyOperation(root, plan, { op_id: "o4", kind: "claim", id: "TST-T0001", run: run("r-2") }, now).status, "applied");
  assert.equal(task().run_review_at, undefined);
});

test("a move to review replayed late does not overrule a person who sent the task back to work", () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-replay-"));
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "space.yaml"), "schema: paseo-dashboard/1\nkey: TST\nname: Test\nprojects:\n  core: { remote: git@example.com:a/core.git }\n");
  writeFileSync(join(root, "tasks", "TST-T0001-one.md"), "---\nid: TST-T0001\ntype: task\ntitle: one\nstatus: todo\nproject: core\n---\n");
  const plan = loadPlan(root);
  const task = () => plan.entities.get("TST-T0001")!.entity as Task;
  const now = "2026-10-26T12:00:00.000Z";
  const pr = "https://github.com/a/core/pull/7";
  applyOperation(root, plan, { op_id: "o1", kind: "claim", id: "TST-T0001", run: { run_id: "r-1", run_by: "ergo", run_host: "a", run_branch: "task/one", run_started: "2026-10-26T09:00:00Z" } }, now);
  assert.equal(applyOperation(root, plan, { op_id: "o2", kind: "transition", id: "TST-T0001", to: "review", run_id: "r-1", run_pr: pr, at: "2026-10-26T10:00:00Z" }, now).status, "applied");
  // "Continue work" on the run's machine.
  assert.equal(applyOperation(root, plan, { op_id: "o3", kind: "transition", id: "TST-T0001", to: "in_progress", run_id: "r-1", at: "2026-10-26T10:30:00Z" }, now).status, "applied");
  // Machine B recorded the same move to review offline and pushes it now.
  assert.equal(applyOperation(root, plan, { op_id: "o4", kind: "transition", id: "TST-T0001", to: "review", run_id: "r-1", run_pr: pr, at: "2026-10-26T10:00:05Z" }, now).status, "already");
  assert.equal(task().status, "in_progress");
  // A new PR/MR of the run still moves it.
  assert.equal(applyOperation(root, plan, { op_id: "o5", kind: "transition", id: "TST-T0001", to: "review", run_id: "r-1", run_pr: `${pr.slice(0, -1)}8`, at: "2026-10-26T11:00:00Z" }, now).status, "applied");
});

test("a feature is done when its accepted tasks are: drafts neither hold it open nor reopen it (D15)", () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-d15-"));
  for (const dir of ["tasks", "features"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "space.yaml"), "schema: paseo-dashboard/1\nkey: TST\nname: Test\nprojects:\n  core: { remote: git@example.com:a/core.git }\n");
  writeFileSync(join(root, "features", "TST-F0001-f.md"), "---\nid: TST-F0001\ntype: feature\ntitle: f\nstatus: active\n---\n");
  const task = (id: string, status: string) =>
    writeFileSync(join(root, "tasks", `${id}-t.md`), `---\nid: ${id}\ntype: task\ntitle: t\nstatus: ${status}\nproject: core\nfeature: "[[TST-F0001]]"\n---\n`);
  task("TST-T0001", "done");
  task("TST-T0002", "inbox");
  assert.equal(derivedFeatureStatus(loadPlan(root), "TST-F0001"), "done", "a draft does not hold it open");
  writeFileSync(join(root, "features", "TST-F0001-f.md"), "---\nid: TST-F0001\ntype: feature\ntitle: f\nstatus: done\n---\n");
  assert.equal(derivedFeatureStatus(loadPlan(root), "TST-F0001"), undefined, "nor reopens a done one");
  task("TST-T0003", "todo");
  assert.equal(derivedFeatureStatus(loadPlan(root), "TST-F0001"), "active", "an accepted task does");
});
