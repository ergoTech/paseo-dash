import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksOf } from "../server/api/view.ts";
import { buildMetro } from "../server/map/metro.ts";
import { loadPlan } from "../server/plan/load.ts";
import { renderRoadmap } from "../server/plan/roadmap.ts";
import { PROJECTS, TASK_COUNT, writeLargePlan } from "./large-plan.ts";

test("the large plan fixture loads cleanly: 500 tasks in 6 projects, laid out and rendered", () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-large-"));
  writeLargePlan(root);
  const plan = loadPlan(root);
  assert.deepEqual(plan.problems, []);
  assert.equal(tasksOf(plan).length, TASK_COUNT);
  assert.equal(TASK_COUNT, 500);
  assert.deepEqual(Object.keys(plan.space!.projects), [...PROJECTS]);
  assert.equal(PROJECTS.length, 6);
  const statuses = new Set(tasksOf(plan).map((t) => t.status));
  assert.deepEqual([...statuses].sort(), ["canceled", "done", "in_progress", "inbox", "review", "todo"]);
  const map = buildMetro({ plan, space: { key: "LPL", name: "Large plan" } });
  assert.equal(map.lines.length, 6);
  assert.ok(map.stations.length > 0 && map.interchanges.length > 0 && map.depot.length > 0);
  const again = mkdtempSync(join(tmpdir(), "dashboard-large-"));
  writeLargePlan(again);
  assert.equal(renderRoadmap(loadPlan(again)), renderRoadmap(plan), "the same plan every time");
});
