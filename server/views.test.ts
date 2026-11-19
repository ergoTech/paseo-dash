import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMN_GAP, countBadge, geometry } from "../client/geometry.ts";
import { ActivityReader } from "./activity.ts";
import type { PaseoApi } from "./paseo.ts";
import { setup } from "./api/testing.ts";
import { readMap } from "./map/read.ts";
import { renderRoadmap } from "./plan/roadmap.ts";
import { featureView, planOptions, roadmapText, taskView } from "./views.ts";

test("task.view gives a screen everything about one task, found by id in any space", async () => {
  const s = await setup();
  try {
    const held = taskView(s.dashboard, { task: "tst-rd002" }, new Date(2026, 9, 26, 10, 0));
    assert.deepEqual([held.found, held.space, held.title, held.glyph, held.run?.by, held.run?.since, held.run?.local], [true, "TST", "Login page redesign", "elsewhere", "anna", "08:05", false]);
    const blocked = taskView(s.dashboard, { task: "TST-DEP01" });
    assert.deepEqual([blocked.glyph, blocked.dependencies], ["blocked", [{ id: "TST-TASK1", title: "one", status: "todo" }]]);
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).feature?.title, "Login");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).milestone?.title, "Release 2.3", "the feature's release");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).own_milestone, "", "an edit form shows that it follows the feature");
    assert.match(taskView(s.dashboard, { task: "TST-ZZZZZ" }).error, /No task TST-ZZZZZ/);
    assert.match(taskView(s.dashboard, { task: "TST-FEAT0" }).error, /No task/, "a feature is not a task");
  } finally {
    s.stop();
  }
});

test("feature.view lays the feature's tasks out in dependency phases", async () => {
  const s = await setup();
  try {
    const view = featureView(s.dashboard, { feature: "TST-FEAT0" });
    assert.deepEqual([view.title, view.done, view.total, view.phases.length], ["TOTP", 0, 2, 1]);
    assert.deepEqual(view.phases[0]!.map((t) => t.id), ["TST-TASK1", "TST-TASK2"]);
    assert.match(featureView(s.dashboard, { feature: "TST-TASK1" }).error, /No feature/);
  } finally {
    s.stop();
  }
});

test("the metro geometry places columns side by side and grows with labels", async () => {
  const s = await setup();
  try {
    const map = readMap(s.dashboard, { space: "TST" });
    const far = geometry(map, false);
    const near = geometry(map, true);
    assert.ok(near.width > far.width && near.height > far.height);
    for (let i = 1; i < map.columns.length; i += 1) assert.equal(far.columnX[i], far.columnX[i - 1]! + far.columnW[i - 1]! + COLUMN_GAP);
    for (const g of [far, near, geometry(map, true, 4000)]) {
      for (const station of map.stations) {
        const x = g.x(station.column, station.slot);
        assert.ok(x > g.columnX[station.column]! && x < g.columnX[station.column]! + g.columnW[station.column]!, "a station stays inside its column");
      }
    }
    // A wider screen stretches the columns in proportion, up to a limit; a narrower one never squeezes them.
    const wide = geometry(map, true, near.width * 1.5);
    assert.ok(Math.abs(wide.width - near.width * 1.5) <= map.columns.length, `${wide.width} fills ${near.width * 1.5}`);
    assert.ok(geometry(map, true, 100_000).width < near.width * 2.3, "stretching stops");
    assert.deepEqual(geometry(map, true, 10).columnW, near.columnW);
  } finally {
    s.stop();
  }
});

test("task.view links the PR of the task's own run, never one seen for an earlier run", async () => {
  const s = await setup();
  try {
    s.dashboard.prs.seen.set("TST-RD002", { run_id: "r-old", label: "#1", state: "merged", url: "https://github.com/acme/core/pull/1" });
    assert.equal(taskView(s.dashboard, { task: "TST-RD002" }).pr, null, "the run has no PR of its own yet, and the old one is not shown");
    // The current run has its own PR in the plan: text and link both name it, not the old run's.
    const loaded = s.sync().plan.entities.get("TST-RD002")!;
    s.sync().plan.entities.set("TST-RD002", { ...loaded, entity: { ...loaded.entity, run_pr: "https://github.com/acme/core/pull/2" } as typeof loaded.entity });
    assert.deepEqual(taskView(s.dashboard, { task: "TST-RD002" }).pr, { text: "https://github.com/acme/core/pull/2", url: "https://github.com/acme/core/pull/2", note: "" });
    s.dashboard.prs.seen.set("TST-RD002", { run_id: "r-anna", label: "#2", state: "open", url: "https://github.com/acme/core/pull/2" });
    assert.deepEqual(taskView(s.dashboard, { task: "TST-RD002" }).pr, { text: "#2 open", url: "https://github.com/acme/core/pull/2", note: "" });
    // Why nothing moved is its own field for the result card; the old run's note never shows.
    s.dashboard.prs.seen.set("TST-RD002", { run_id: "r-anna", label: "#2", state: "draft", url: "https://github.com/acme/core/pull/2", note: "a draft" });
    assert.deepEqual(taskView(s.dashboard, { task: "TST-RD002" }).pr?.note, "a draft");
    s.dashboard.prs.seen.set("TST-RD002", { run_id: "r-old", label: "#1", state: "merged", url: "https://github.com/acme/core/pull/1", note: "old" });
    assert.deepEqual(taskView(s.dashboard, { task: "TST-RD002" }).pr?.note, "");
  } finally {
    s.stop();
  }
});

test("ui.options offers the space's projects in order, open releases by due date and open features", async () => {
  const s = await setup();
  try {
    await s.ctx.dashboard.spaces.get("TST")!.sync.record([
      { op_id: "op-done", kind: "set", id: "TST-FEAT0", field: "status", value: "done", expect: "active" },
    ]).outcomes;
    const options = await planOptions(s.dashboard, { space: "tst" });
    assert.equal(options.error, "");
    assert.deepEqual(options.projects, [
      { key: "core", mapped: true },
      { key: "site", mapped: false },
    ]);
    assert.deepEqual(options.milestones, [{ id: "TST-MS001", title: "Release 2.3", due: "2026-11-30", status: "active" }]);
    assert.deepEqual(options.features, [{ id: "TST-FEAT1", title: "Login", milestone: "TST-MS001", projects: [] }], "a done feature is not offered");
    assert.match((await planOptions(s.dashboard, { space: "NOPE" })).error, /No space NOPE/);
  } finally {
    s.stop();
  }
});

test("ui.roadmap gives the space's ROADMAP.md as its commits carry it", async () => {
  const s = await setup();
  try {
    assert.deepEqual(roadmapText(s.dashboard, { space: "tst" }), { text: renderRoadmap(s.sync().plan)!, error: "" });
    assert.match(roadmapText(s.dashboard, { space: "NOPE" }).error, /No space NOPE/);
  } finally {
    s.stop();
  }
});

test("a cluster's count badge keeps to three characters, so it never reaches the title", () => {
  assert.deepEqual([2, 99, 100, 512].map(countBadge), ["2", "99", "99+", "99+"]);
});

test("the map marks a line's Paseo counts stale while the last read of Paseo failed", async () => {
  const s = await setup();
  try {
    let now = 1_000_000;
    let fail = false;
    const paseo = {
      workspaces: {
        list: async () => {
          if (fail) throw new Error("socket closed");
          return { entries: [{ id: "w1", projectId: "prj_core", name: "spike", status: "running", statusEnteredAt: "2026-10-26T09:00:00Z" }], pageInfo: { hasMore: false } };
        },
      },
      agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    } as unknown as PaseoApi;
    (s.dashboard as unknown as { activity: ActivityReader }).activity = new ActivityReader(() => paseo, () => new Set(), () => now);
    await s.dashboard.activity.read();
    const core = () => readMap(s.dashboard, { space: "TST" }).lines.find((l) => l.project === "core")!;
    assert.deepEqual([core().open, core().busy, core().stale], [1, 1, false]);
    now += 11_000;
    fail = true;
    await assert.rejects(s.dashboard.activity.read(), /socket closed/);
    assert.deepEqual([core().open, core().busy, core().stale], [1, 1, true], "the last counts, marked as old");
    now += 11_000;
    fail = false;
    await s.dashboard.activity.read();
    assert.equal(core().stale, false, "a good read clears it");
  } finally {
    s.stop();
  }
});
