import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daysLeft, sortTasks, tasksOf } from "../api/view.ts";
import { loadPlan } from "../plan/load.ts";
import { buildMetro } from "./metro.ts";
import { LINE_COLORS } from "../../shared/projects.ts";

/**
 * A plan repo on disk from short entity lines: "task ID title status project feature? milestone?";
 * `more` adds keys to a project's space.yaml entry (`{ core: "group: Laconote" }`).
 */
function plan(projects: string[], entities: string[], more: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-metro-"));
  for (const dir of ["tasks", "features", "milestones"]) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, "space.yaml"),
    `schema: paseo-dashboard/1\nkey: TST\nname: Test\nprojects:\n${projects.map((p) => `  ${p}: { remote: git@x:${p}.git${more[p] ? `, ${more[p]}` : ""} }`).join("\n")}\n`,
  );
  for (const line of entities) {
    const [type, id, ...rest] = line.split(" ");
    const fields = Object.fromEntries(rest.map((kv) => kv.split("=") as [string, string]));
    const front = [`id: ${id}`, `type: ${type}`, `title: ${(fields.title ?? id).replace(/_/g, " ")}`];
    for (const [k, v] of Object.entries(fields)) if (k !== "title") front.push(`${k}: ${["feature", "milestone"].includes(k) ? `"[[${v}]]"` : v}`);
    if (type === "task" && !fields.status) front.push("status: todo");
    writeFileSync(join(root, `${type === "task" ? "tasks" : type === "feature" ? "features" : "milestones"}`, `${id}.md`), `---\n${front.join("\n")}\n---\n`);
  }
  return loadPlan(root);
}

const NOW = new Date("2026-10-26T12:00:00Z");

test("lines in space.yaml order, releases by due date then Later, finished releases folded", () => {
  const p = plan(
    ["site", "core", "ios", "android"],
    [
      "milestone TST-RE100 title=R1 status=active due=2026-12-01",
      "milestone TST-RE200 title=R2 status=planned due=2026-11-01",
      "milestone TST-RE000 title=R0 status=done due=2026-09-01",
      "task TST-A0001 project=site milestone=TST-RE100",
      "task TST-A0002 project=core milestone=TST-RE200",
      "task TST-A0003 project=core status=done milestone=TST-RE000",
      "task TST-A0004 project=core",
    ],
  );
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  assert.deepEqual(map.lines.map((l) => [l.project, l.empty]), [
    ["site", false],
    ["core", false],
    ["ios", true],
    ["android", true],
  ], "space.yaml order, not alphabetical; listed projects without stations are empty lines");
  assert.deepEqual(map.folded, []);
  const folding = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW, showEmpty: false });
  assert.deepEqual(folding.lines.map((l) => l.project), ["site", "core"]);
  assert.deepEqual(folding.folded, ["ios", "android"]);
  assert.deepEqual(map.columns.map((c) => c.title), ["Done", "R2", "R1", "Later"]);
  assert.deepEqual(map.columns.map((c) => c.days_left), [null, daysLeft("2026-11-01", NOW), daysLeft("2026-12-01", NOW), null]);
  assert.deepEqual(map.stations.map((s) => [map.columns[s.column]!.title, map.lines[s.row]!.project]), [
    ["Done", "core"],
    ["R2", "core"],
    ["R1", "site"],
    ["Later", "core"],
  ]);
  const open = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW, showDone: true });
  assert.deepEqual(open.columns.map((c) => c.title), ["R0", "R2", "R1", "Later"]);
});

test("one interchange per feature spans exactly its projects; two tasks of a feature in one repo are one station", () => {
  const p = plan(
    ["core", "site", "android", "ios"],
    [
      "milestone TST-RE100 title=R1 status=active due=2026-12-01",
      "feature TST-FE100 title=TOTP milestone=TST-RE100 order=2 branch=feat/totp",
      "feature TST-FE200 title=Promo milestone=TST-RE100 order=1",
      "task TST-B0001 project=core feature=TST-FE100 status=review",
      "task TST-B0002 project=ios feature=TST-FE100",
      "task TST-B0003 project=ios feature=TST-FE100 status=done",
      "task TST-B0004 project=site feature=TST-FE200",
      "task TST-B0005 project=site milestone=TST-RE100",
    ],
  );
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  const [promo, totp] = map.interchanges;
  assert.deepEqual([promo!.title, promo!.slot, totp!.title, totp!.slot], ["Promo", 0, "TOTP", 1], "by order");
  assert.deepEqual([totp!.rows, totp!.top, totp!.bottom, totp!.branch], [[0, 3], 0, 3, "feat/totp"], "core and ios; site and the empty android line between are only crossed");
  const ios = map.stations.find((s) => s.feature === "TST-FE100" && map.lines[s.row]!.project === "ios")!;
  assert.deepEqual([ios.tasks.length, ios.glyph], [2, "todo"], "one station, the more urgent mark");
  const loose = map.stations.find((s) => s.feature === "")!;
  assert.deepEqual([loose.slot, map.columns[loose.column]!.slots], [2, 3], "tasks without a feature take the last slot");
  assert.equal(map.columns[0]!.total, 5);
});

test("drafts go to the depot, canceled tasks vanish, and marks follow the most urgent task", () => {
  const p = plan(
    ["core"],
    [
      "task TST-C0001 project=core status=inbox",
      "task TST-C0002 project=core status=canceled",
      "task TST-C0003 project=core status=in_progress",
      "task TST-C0004 project=core depends_on=[TST-C0003]",
    ],
  );
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW, glyphOf: (t) => (t.id === "TST-C0003" ? "needs_you" : "todo") });
  assert.deepEqual(map.depot.map((d) => d.id), ["TST-C0001"]);
  assert.equal(map.stations.length, 1);
  // The mark is the most urgent task's; the tasks are in list order (the running one before the blocked todo).
  assert.deepEqual([map.stations[0]!.glyph, map.stations[0]!.tasks.map((t) => t.id)], ["needs_you", ["TST-C0003", "TST-C0004"]]);
  const plain = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  assert.deepEqual(plain.stations[0]!.tasks.map((t) => t.glyph), ["elsewhere", "blocked"]);
});

test("a missing or canceled feature puts its tasks in the loose slot; split features and finished releases", () => {
  const p = plan(
    ["core", "site"],
    [
      "milestone TST-RE100 title=R1 status=active due=2026-12-01",
      "milestone TST-RE200 title=R2 status=active due=2027-01-01",
      "milestone TST-RE000 title=Old status=done due=2026-09-01",
      "milestone TST-RE001 title=Dropped status=canceled due=2026-10-01",
      "feature TST-FE100 title=Split milestone=TST-RE100",
      "feature TST-FE900 title=Gone status=canceled",
      "task TST-D0001 project=core feature=TST-ZZZZ1",
      "task TST-D0002 project=core feature=TST-ZZZZ2",
      "task TST-D0003 project=core feature=TST-RE100",
      "task TST-D0004 project=site feature=TST-FE900",
      "task TST-D0005 project=core feature=TST-FE100",
      "task TST-D0006 project=site feature=TST-FE100 milestone=TST-RE200",
      "task TST-D0007 project=core milestone=TST-RE000",
      "task TST-D0008 project=core status=done milestone=TST-RE000",
      "task TST-D0009 project=site milestone=TST-RE001",
    ],
  );
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  const cells = map.stations.map((s) => `${s.column}/${s.slot}/${s.row}`);
  assert.equal(new Set(cells).size, cells.length, "no two stations share a cell");
  assert.ok(map.stations.every((s) => s.slot >= 0 && s.slot < map.columns[s.column]!.slots), "every slot is counted in its column");
  const later = map.columns.findIndex((c) => c.id === "later");
  const loose = map.stations.filter((s) => s.column === later && s.feature === "").flatMap((s) => s.tasks.map((t) => t.id)).sort();
  assert.deepEqual(loose, ["TST-D0001", "TST-D0002", "TST-D0003", "TST-D0004", "TST-D0007", "TST-D0009"], "dangling, wrong-type and canceled features, and open work of finished releases");
  assert.deepEqual(map.interchanges.map((i) => [i.key, i.rows]), [["TST-RE100:TST-FE100", [0]], ["TST-RE200:TST-FE100", [1]]], "a split feature has a keyed interchange per release");
  const done = map.columns.find((c) => c.id === "done")!;
  assert.deepEqual([done.done, done.total], [1, 1], "only finished work in Done");
});

test("lines keep their group together, carry their color, and a group filter narrows lines and totals", () => {
  const p = plan(
    ["sandbox", "core", "dash", "android"],
    [
      "milestone TST-RE100 title=R1 status=active due=2026-12-01",
      "task TST-A0001 project=core milestone=TST-RE100",
      "task TST-A0002 project=dash milestone=TST-RE100",
      "task TST-A0003 project=android milestone=TST-RE100 status=done",
      "task TST-A0004 project=sandbox",
      "task TST-A0005 project=ghost",
    ],
    { core: "group: Laconote", dash: "group: Paseo, color: '#3E8EED'", android: "group: Laconote, color: red" },
  );
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  assert.deepEqual(
    map.lines.map((l) => [l.project, l.group]),
    [
      ["core", "Laconote"],
      ["android", "Laconote"],
      ["dash", "Paseo"],
      ["sandbox", ""],
      ["ghost", ""],
    ],
    "groups in the order they first appear, space.yaml order inside a group, then lines without a group, unknown projects last",
  );
  assert.deepEqual(map.groups, ["Laconote", "Paseo"]);
  const color = Object.fromEntries(map.lines.map((l) => [l.project, l.color]));
  assert.equal(color.dash, "#3e8eed", "space.yaml's color, lower case");
  // Defaults go in space.yaml order to the lines without a valid color and skip the colors named there.
  assert.equal(color.sandbox, LINE_COLORS[1]);
  assert.equal(color.core, LINE_COLORS[2]);
  assert.equal(color.android, LINE_COLORS[3], "a color that is not #rrggbb counts as none");
  assert.equal(color.ghost, "", "a project space.yaml does not list has no color");

  const laconote = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW, group: "Laconote" });
  assert.deepEqual(laconote.lines.map((l) => l.project), ["core", "android"]);
  assert.deepEqual(laconote.folded, []);
  const r1 = laconote.columns.find((c) => c.title === "R1")!;
  assert.deepEqual([r1.done, r1.total], [1, 2], "release totals count only the group's tasks");
  assert.equal(laconote.stations.length, 2);
});

test("task order: running, review, ready, blocked, drafts, then finished work; ready by priority, release due, creation time, id", () => {
  const p = plan(
    ["core"],
    [
      "milestone TST-RE100 title=Soon status=active due=2026-11-01",
      "milestone TST-RE200 title=Later status=planned due=2026-12-01",
      "task TST-R0009 project=core priority=low created=2026-10-01",
      "task TST-R0008 project=core priority=high created=2026-10-03",
      "task TST-R0007 project=core priority=high created=2026-10-02",
      "task TST-R0006 project=core priority=high",
      "task TST-R0005 project=core priority=high",
      "task TST-R0004 project=core",
      "task TST-R0003 project=core priority=high created=2026-10-09 milestone=TST-RE200",
      "task TST-R0002 project=core priority=high created=2026-10-09 milestone=TST-RE100",
      "task TST-R0001 project=core priority=low depends_on=[TST-C0001]",
      "task TST-C0001 project=core priority=low status=canceled",
      "task TST-B0001 project=core priority=low depends_on=[TST-W0001]",
      "task TST-B0002 project=core priority=urgent depends_on=[TST-W0001]",
      "task TST-W0001 project=core priority=urgent status=in_progress run_id=r-1 run_started=2026-10-05T10:00:00Z",
      "task TST-W0003 project=core priority=low status=in_progress run_id=r-3 run_started=2026-10-04T10:00:00Z",
      "task TST-W0002 project=core status=review",
      "task TST-N0001 project=core priority=low status=inbox",
      "task TST-N0002 project=core priority=high status=inbox",
      "task TST-D0001 project=core priority=urgent status=done run_ended=2026-10-01T10:00:00Z",
      "task TST-D0002 project=core priority=low status=done run_ended=2026-10-07T10:00:00Z",
    ],
  );
  const all = tasksOf(p).map((task) => ({ plan: p, task }));
  const ordered = sortTasks(all).map(({ task }) => task.id);
  assert.deepEqual(ordered, [
    // Running: urgent first, without any activity known here; then review.
    "TST-W0001",
    "TST-W0003",
    "TST-W0002",
    // Ready: by priority (none counts as medium), then the release due first, then oldest first,
    // then id for those without a creation time; waiting for a canceled task blocks nothing.
    "TST-R0002",
    "TST-R0003",
    "TST-R0007",
    "TST-R0008",
    "TST-R0005",
    "TST-R0006",
    "TST-R0004",
    "TST-R0009",
    "TST-R0001",
    // Blocked, by priority.
    "TST-B0002",
    "TST-B0001",
    // Drafts by priority, then finished work, the latest first.
    "TST-N0002",
    "TST-N0001",
    "TST-D0002",
    "TST-D0001",
    "TST-C0001",
  ]);
  // The agent that waits for the person goes before one that works.
  const attention = sortTasks(all, { activity: (task) => (task.id === "TST-W0003" ? "needs_input" : task.id === "TST-W0001" ? "working" : undefined) });
  assert.deepEqual(attention.slice(0, 2).map(({ task }) => task.id), ["TST-W0003", "TST-W0001"]);
  const map = buildMetro({ plan: p, space: { key: "TST", name: "Test" }, now: NOW });
  const station = map.stations.find((s) => s.tasks.some((t) => t.id === "TST-R0009"))!;
  const shown = ordered.filter((id) => !id.startsWith("TST-N") && !id.startsWith("TST-C") && !["TST-R0002", "TST-R0003"].includes(id));
  assert.deepEqual(station.tasks.map((t) => t.id), shown, "a station lists its tasks in the same order");
});

test("a task without a priority ranks as the space's default", () => {
  const p = plan(["core"], ["task TST-P0001 project=core priority=medium created=2026-10-01", "task TST-P0002 project=core created=2026-10-02"]);
  const space = p.space!;
  space.defaults.priority = "high";
  assert.deepEqual(sortTasks(tasksOf(p).map((task) => ({ plan: p, task }))).map(({ task }) => task.id), ["TST-P0002", "TST-P0001"]);
});
