import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_COLUMNS, BOARD_DONE_LIMIT, boardMove } from "../../shared/board.ts";
import { Dashboard } from "../dashboard.ts";
import { readOverview } from "../overview.ts";
import { FakePaseo } from "../runner/testing.ts";
import { planRemote } from "../../fixtures/response-sizes.ts";
import { listTasks, readBoard } from "./reads.ts";
import { setup } from "./testing.ts";
import { rankTask, updateTask } from "./writes.ts";

const HOST = "board-check-mbp";

async function largePlan() {
  const base = mkdtempSync(join(tmpdir(), "dashboard-board-"));
  const dashboard = new Dashboard({ dataDir: join(base, "data"), fetchIntervalMs: 3_600_000 });
  dashboard.attach(new FakePaseo({}).api());
  await dashboard.addSpace({ remote: planRemote(base) });
  await dashboard.spaces.get("LPL")!.sync.sync();
  const ctx = { dashboard, now: () => new Date(Date.UTC(2026, 10, 1, 12)), host: HOST };
  return { dashboard, ctx, stop: () => (dashboard.stop(), rmSync(base, { recursive: true, force: true })) };
}

/** Every task of a section in the Tasks tab's order, a page of 50 at a time. */
async function tasksTab(ctx: Parameters<typeof listTasks>[0]) {
  const all: { id: string; section: string }[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = await listTasks(ctx, { status: "all", limit: 50, offset });
    assert.equal(page.error, "");
    all.push(...page.tasks);
    if (all.length >= page.total) return all;
  }
}

test("the board's columns hold what the Tasks tab and Live show, in the same order, on the large plan", async () => {
  const s = await largePlan();
  try {
    const started = performance.now();
    const board = await readBoard(s.ctx, {});
    const ms = performance.now() - started;
    assert.equal(board.error, "");
    assert.deepEqual(board.columns.map((c) => c.column), [...BOARD_COLUMNS]);
    const tasks = await tasksTab(s.ctx);
    for (const column of board.columns) {
      const listed = tasks.filter((t) => t.section === column.column).map((t) => t.id);
      assert.equal(column.total, listed.length, column.column);
      assert.deepEqual(column.tasks.map((t) => t.id), listed.slice(0, column.tasks.length), `${column.column}: the Tasks tab's order`);
      for (const t of column.tasks) assert.equal(t.section, column.column);
    }
    assert.ok(!board.columns.some((c) => c.tasks.some((t) => t.status === "canceled")), "canceled work has no column");
    const done = board.columns.find((c) => c.column === "done")!;
    assert.ok(done.total > BOARD_DONE_LIMIT, "the large plan has more finished work than the column lists");
    assert.equal(done.tasks.length, BOARD_DONE_LIMIT, "only the latest finished ones");

    const live = readOverview(s.dashboard, { limit: 200 }, HOST);
    const ids = (column: string) => board.columns.find((c) => c.column === column)!.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids("running"), live.running.map((r) => r.task).sort(), "Live's Working");
    assert.deepEqual(ids("review"), live.review.map((r) => r.task).sort(), "Live's Review");
    assert.ok(ids("running").length > 0 && ids("review").length > 0);
    // The size and time the PR reports; not a budget (the board is no read of ChatGPT's).
    console.log(`ui.board on the large plan: ${Buffer.byteLength(JSON.stringify(board), "utf8")} bytes in ${ms.toFixed(1)} ms`);
  } finally {
    s.stop();
  }
});

test("on the board a draft is accepted and an accepted task goes back to the drafts; a column's order moves", async () => {
  const s = await setup();
  try {
    const column = async (name: string) => (await readBoard(s.ctx, {})).columns.find((c) => c.column === name)!.tasks.map((t) => t.id);
    assert.ok((await column("ready")).includes("TST-TASK2"));
    const back = await updateTask(s.ctx, { task: "TST-TASK2", status: "inbox" });
    assert.deepEqual([back.ok, back.status], [true, "inbox"], back.error);
    assert.ok((await column("draft")).includes("TST-TASK2"));
    assert.ok(!(await column("ready")).includes("TST-TASK2"));
    const accepted = await updateTask(s.ctx, { task: "TST-TASK2", status: "todo" });
    assert.deepEqual([accepted.ok, accepted.status], [true, "todo"], accepted.error);
    assert.ok((await column("ready")).includes("TST-TASK2"));

    const ready = await column("ready");
    const last = ready.at(-1)!;
    const moved = await rankTask(s.ctx, { task: last, position: "before", next_to: ready[0]! });
    assert.equal(moved.ok, true, moved.error);
    assert.equal((await column("ready"))[0], last);
  } finally {
    s.stop();
  }
});

test("the board never moves a run's status: running, review and done cards drop nowhere, and the plan refuses it too", async () => {
  for (const section of ["running", "review", "done"]) {
    for (const column of BOARD_COLUMNS) {
      assert.equal(boardMove({ id: "X", section, project: "core" }, { column }).kind, "none", `${section} → ${column}`);
      assert.equal(boardMove({ id: "X", section, project: "core" }, { column, card: { id: "Y", section } }).kind, "none", `${section} → ${column}, on a card`);
    }
  }
  for (const section of ["draft", "ready", "blocked"]) {
    for (const column of ["running", "review", "done"]) assert.equal(boardMove({ id: "X", section, project: "core" }, { column }).kind, "none", `${section} → ${column}`);
  }
  assert.deepEqual(boardMove({ id: "X", section: "draft", project: "core" }, { column: "ready" }), { kind: "status", to: "todo" });
  assert.deepEqual(boardMove({ id: "X", section: "draft", project: "" }, { column: "blocked" }), { kind: "accept" });
  assert.deepEqual(boardMove({ id: "X", section: "blocked", project: "core" }, { column: "draft" }), { kind: "status", to: "inbox" });
  assert.equal(boardMove({ id: "X", section: "ready", project: "core" }, { column: "blocked" }).kind, "none", "dependencies decide that");
  assert.deepEqual(boardMove({ id: "X", section: "ready", project: "core" }, { column: "ready", card: { id: "Y", section: "ready" }, after: true }), { kind: "rank", position: "after", next_to: "Y" });
  assert.equal(boardMove({ id: "AAA-AB234", section: "ready", project: "core" }, { column: "ready", card: { id: "BBB-AB234", section: "ready" } }).kind, "none", "a rank orders one space's tasks");

  const s = await setup();
  try {
    for (const status of ["todo", "inbox"] as const) {
      const refused = await updateTask(s.ctx, { task: "TST-RD002", status });
      assert.equal(refused.ok, false, status);
      assert.match(refused.error, /use release_task/);
    }
    assert.equal(s.task("TST-RD002")?.status, "in_progress");
    assert.equal((await readBoard(s.ctx, {})).columns.find((c) => c.column === "running")!.tasks[0]?.id, "TST-RD002");
  } finally {
    s.stop();
  }
});
