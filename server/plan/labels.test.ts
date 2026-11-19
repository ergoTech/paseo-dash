import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { applyOperation } from "../sync/ops.ts";
import { loadPlan, planProblems } from "./load.ts";

const NOW = "2026-10-27T10:00:00.000Z";

function plan(front: string) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-labels-"));
  writeFileSync(join(root, "space.yaml"), "schema: paseo-dashboard/1\nkey: TST\nname: Test\nlabels:\n  bug: { color: \"#e5484d\" }\n");
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "tasks", "TST-AAAAA-a.md"), `---\nid: TST-AAAAA\ntype: task\ntitle: A\nstatus: todo\n${front}---\n`);
  return { root, plan: loadPlan(root) };
}

const labels = (p: ReturnType<typeof plan>) => (p.plan.entities.get("TST-AAAAA")!.entity as Task).labels;

test("a label typed by hand and not defined is kept on the task and listed as a problem", () => {
  const p = plan("labels: [Bug, hand typed, 42, hand typed]\n");
  assert.deepEqual(labels(p), ["Bug", "hand typed", "42"], "kept as written, repeats once");
  assert.deepEqual(planProblems(p.plan), [{ path: "tasks/TST-AAAAA-a.md", reason: "labels «hand typed», «42» not defined in space.yaml" }]);
  assert.deepEqual(p.plan.problems, [], "the file itself loads");

  // Defining it ends the problem without a reload.
  const outcome = applyOperation(p.root, p.plan, { op_id: "o1", kind: "label_def", name: "hand typed", value: { color: "#3e8eed" }, expect: null }, NOW);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(planProblems(p.plan), [{ path: "tasks/TST-AAAAA-a.md", reason: "label «42» not defined in space.yaml" }]);
});

test("a single label written as text reads as a list; removing a label takes off any spelling of it", () => {
  const p = plan("labels: lonely\n");
  assert.deepEqual(labels(p), ["lonely"]);
  assert.equal(applyOperation(p.root, p.plan, { op_id: "o1", kind: "label", id: "TST-AAAAA", label: "bug", add: true }, NOW).status, "applied");
  assert.deepEqual(labels(p), ["lonely", "bug"]);
  assert.equal(applyOperation(p.root, p.plan, { op_id: "o2", kind: "label", id: "TST-AAAAA", label: "BUG", add: true }, NOW).status, "already");
  assert.equal(applyOperation(p.root, p.plan, { op_id: "o3", kind: "label", id: "TST-AAAAA", label: "LONELY", add: false }, NOW).status, "applied");
  assert.deepEqual(labels(p), ["bug"]);
  assert.equal(applyOperation(p.root, p.plan, { op_id: "o3", kind: "label", id: "TST-AAAAA", label: "lonely", add: false }, NOW).status, "already");
  const removal = applyOperation(p.root, p.plan, { op_id: "o4", kind: "label_def", name: "bug", value: null, expect: { color: "#e5484d" } }, NOW);
  assert.deepEqual(removal, { status: "refused", reason: "1 task(s) carry bug: TST-AAAAA" });
});
