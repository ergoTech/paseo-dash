import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../shared/model.ts";
import { readOverview } from "./overview.ts";
import { setup } from "./api/testing.ts";

test("Live lists: review longest waiting first, with when each started to wait; a screen asks for whole lists", async () => {
  const s = await setup();
  try {
    const plan = [...s.dashboard.spaces.values()][0]!.sync.plan;
    const as = (id: string, fields: Partial<Task>) => Object.assign(plan.entities.get(id)!.entity, fields);
    as("TST-TASK1", { status: "review", run_id: "r-1", run_by: "ergo", run_host: "elsewhere", run_started: "2026-10-20T09:00:00.000Z", run_review_at: "2026-10-27T09:00:00.000Z" });
    as("TST-TASK2", { status: "review", run_id: "r-2", run_by: "ergo", run_host: "elsewhere", run_started: "2026-10-21T09:00:00.000Z", run_review_at: "2026-10-25T09:00:00.000Z" });
    const overview = readOverview(s.dashboard, {});
    assert.deepEqual(overview.review.map((r) => [r.task, r.since]), [
      ["TST-TASK2", "2026-10-25T09:00:00.000Z"],
      ["TST-TASK1", "2026-10-27T09:00:00.000Z"],
    ]);
    assert.equal(overview.running[0]?.since, (plan.entities.get("TST-RD002")!.entity as Task).run_started);
    assert.equal(readOverview(s.dashboard, { limit: 1 }).review.length, 1);
    assert.equal(readOverview(s.dashboard, { limit: 1 }).counts.review, 2, "counts stay whole");
  } finally {
    s.stop();
  }
});
