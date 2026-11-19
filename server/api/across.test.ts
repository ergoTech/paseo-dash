import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spaceOfId } from "../../shared/across.ts";
import { glyphCounts } from "../../shared/map.ts";
import { buildActivity, projectsActivity } from "../activity.ts";
import { readMap } from "../map/read.ts";
import { readOverview } from "../overview.ts";
import { addProject, listProjects } from "../spaces/projects.ts";
import { listInbox, listTasks } from "./reads.ts";
import { addToInbox, createTask } from "./writes.ts";
import { NOW, setup } from "./testing.ts";

/**
 * The all-spaces view (04-ux.md, All spaces) with three spaces connected: TST from the API fixture
 * (core, site), OTH with its own `core` (the same repository) and THR with `ios`.
 */
async function threeSpaces() {
  const s = await setup();
  for (const [key, name] of [["OTH", "Other"], ["THR", "Third"]] as const) {
    const remote = join(mkdtempSync(join(tmpdir(), "dashboard-across-")), "plan.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await s.dashboard.addSpace({ remote, key, name });
  }
  const added = [
    await addProject(s.ctx, { space: "OTH", key: "core", remote: "https://github.com/acme/core", trunk: "main" }),
    await addProject(s.ctx, { space: "THR", key: "ios", remote: "https://github.com/acme/ios", trunk: "main" }),
  ];
  for (const answer of added) assert.equal(answer.ok, true, answer.error);
  // The same Paseo project now stands behind TST's and OTH's `core`.
  s.dashboard.updateMapping([{ projectId: "prj_core", name: "core", remote: "https://github.com/acme/core", rootPath: "/tmp/core" }]);
  const made = [
    await createTask(s.ctx, { space: "OTH", title: "Other core work", project: "core" }),
    await createTask(s.ctx, { space: "THR", title: "Third ios work", project: "ios" }),
    await addToInbox(s.ctx, { space: "THR", items: [{ title: "Third draft" }] }),
  ];
  for (const answer of made) assert.equal(answer.ok, true, answer.error);
  return s;
}

test("all spaces: the map is one band per space, each its own map, keys qualified by space", async () => {
  const s = await threeSpaces();
  try {
    const all = readMap(s.dashboard, {}, NOW);
    assert.equal(all.error, "");
    assert.equal(all.space.key, "");
    assert.deepEqual(all.lines, [], "the top level is empty; the bands carry the maps");
    assert.deepEqual(all.bands.map((b) => [b.space.key, b.space.name]), [["TST", "Test space"], ["OTH", "Other"], ["THR", "Third"]]);
    const [tst, oth, thr] = all.bands;
    assert.deepEqual(tst!.lines.map((l) => l.project), ["core", "site"]);
    assert.deepEqual(oth!.lines.map((l) => l.project), ["core"], "the same project key in another space is that space's own line");
    assert.deepEqual(thr!.lines.map((l) => l.project), ["ios"]);
    for (const band of all.bands) {
      assert.equal(band.columns.at(-1)!.id, "later", "each band has its own release columns, Later last");
      for (const station of band.stations) assert.ok(station.key.startsWith(`${band.space.key}/`), station.key);
      for (const ic of band.interchanges) assert.ok(ic.key.startsWith(`${band.space.key}/`), ic.key);
      for (const station of band.stations) for (const t of station.tasks) assert.equal(spaceOfId(t.id), band.space.key, "a band holds only its space's tasks");
    }
    const keys = all.bands.flatMap((b) => b.stations.map((st) => st.key));
    assert.equal(new Set(keys).size, keys.length, "station keys never collide across bands");
    assert.ok(keys.includes("TST/later:-:core") && keys.includes("OTH/later:-:core"), keys.join(", "));
    assert.deepEqual(thr!.depot.map((d) => d.title), ["Third draft"], "each band keeps its own depot");

    const one = readMap(s.dashboard, { space: "OTH" }, NOW);
    assert.deepEqual(one.bands, [], "the single-space form is as before");
    assert.equal(one.space.key, "OTH");
    assert.deepEqual(one.stations.map((st) => st.key), ["later:-:core"], "with its keys unqualified");
    assert.match(readMap(s.dashboard, { space: "NOPE" }, NOW).error, /No space NOPE/);
  } finally {
    s.stop();
  }
});

test("a repository that is a line in several spaces says so on the map and on the Projects tab", async () => {
  const s = await threeSpaces();
  try {
    const [tst, oth, thr] = readMap(s.dashboard, {}, NOW).bands;
    assert.deepEqual(
      tst!.lines.map((l) => [l.project, l.shared_with]),
      [
        ["core", ["OTH"]],
        ["site", []],
      ],
      "TST's core (git@github.com:acme/core.git) is OTH's core (https://github.com/acme/core)",
    );
    assert.deepEqual(oth!.lines.map((l) => [l.project, l.shared_with]), [["core", ["TST"]]]);
    assert.deepEqual(thr!.lines.map((l) => [l.project, l.shared_with]), [["ios", []]]);
    assert.deepEqual(readMap(s.dashboard, { space: "OTH" }, NOW).lines[0]?.shared_with, ["TST"], "one space's own map says it too");
    const listed = await listProjects(s.ctx, s.fake.api(), { space: "TST" });
    assert.deepEqual(
      listed.projects.map((p) => [p.key, p.shared_with]),
      [
        ["core", ["OTH"]],
        ["site", []],
      ],
    );
  } finally {
    s.stop();
  }
});

test("a station's tasks are counted by mark, most urgent first", () => {
  assert.deepEqual(glyphCounts(["done", "review", "done", "elsewhere", "review", "done"]), [
    { glyph: "review", count: 2 },
    { glyph: "elsewhere", count: 1 },
    { glyph: "done", count: 3 },
  ]);
  assert.deepEqual(glyphCounts([]), []);
});

test("all spaces: task, inbox and live lists mix the spaces; a space filter narrows them", async () => {
  const s = await threeSpaces();
  try {
    const tasks = await listTasks(s.ctx, { status: "open", limit: 50 });
    assert.equal(tasks.error, "");
    assert.deepEqual([...new Set(tasks.tasks.map((t) => spaceOfId(t.id)))].sort(), ["OTH", "THR", "TST"]);
    const only = await listTasks(s.ctx, { space: "OTH", status: "open", limit: 50 });
    assert.deepEqual(only.tasks.map((t) => t.title), ["Other core work"]);
    const inbox = await listInbox(s.ctx, { limit: 20 });
    assert.deepEqual(inbox.items.map((i) => [spaceOfId(i.id), i.title]), [["THR", "Third draft"]]);
    const overview = readOverview(s.dashboard, {});
    assert.deepEqual(overview.spaces.map((sp) => sp.key), ["TST", "OTH", "THR"]);
    assert.equal(overview.counts.inbox, 1);
  } finally {
    s.stop();
  }
});

test("all spaces: activity lists every space's projects, a workspace once though two spaces map its project", () => {
  const snapshot = buildActivity(
    [
      { id: "w1", projectId: "prj_core", name: "core work", status: "running", statusEnteredAt: "2026-10-26T09:00:00Z" },
      { id: "w2", projectId: "prj_ios", name: "ios work", status: "needs_input", statusEnteredAt: "2026-10-26T08:00:00Z" },
    ],
    [{ agent: { id: "a1", title: "old", workspaceId: "w9", archivedAt: "2026-10-25T10:00:00Z" }, project: { projectKey: "prj_core" } }],
    new Set(),
    "2026-10-26T10:00:00Z",
  );
  const space = (key: string, projects: Record<string, string>) => ({
    record: { key, name: key, remote: "", branch: "main", added: "", mapping: projects, overrides: {} },
    plan: { space: { projects: Object.fromEntries(Object.keys(projects).map((p) => [p, { remote: "x", trunk: "main" }])) } } as never,
  });
  const spaces = [space("TST", { core: "prj_core", site: "prj_site" }), space("OTH", { core: "prj_core" }), space("THR", { ios: "prj_ios" })];
  const listed = projectsActivity(spaces, snapshot, undefined, true);
  assert.deepEqual(listed.map((p) => [p.space, p.project, p.active.map((w) => w.workspace_id), p.past.map((w) => w.workspace_id)]), [
    ["TST", "core", ["w1"], ["w9"]],
    ["TST", "site", [], []],
    ["OTH", "core", [], []],
    ["THR", "ios", ["w2"], []],
  ]);
  assert.deepEqual(projectsActivity(spaces.slice(1, 2), snapshot).map((p) => p.active.length), [1], "one space alone still lists it");
  assert.deepEqual(projectsActivity(spaces, snapshot, "ios", true).map((p) => p.space), ["THR"]);
  const twice = space("TST", { core: "prj_core", api: "prj_core" });
  assert.deepEqual(projectsActivity([twice], snapshot).map((p) => p.active.length), [1, 1], "the single-space form lists as before, also two lines on one Paseo project");
});
