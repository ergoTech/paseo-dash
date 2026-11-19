import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEntityText } from "../plan/load.ts";
import { getTask, listInbox, listTasks, readBoard } from "./reads.ts";
import { resolveEntity, type SpaceEntry } from "./resolve.ts";
import { setup } from "./testing.ts";
import { addToInbox, createTask, updateTask } from "./writes.ts";

/**
 * Finding tasks as ChatGPT and the screens ask, on the
 * TST plan (server/api/testing.ts): TST-FX001 «Fix flaky login test» in feature «Login» of release
 * «Release 2.3», TST-RD002 «Login page redesign».
 */

test("ChatGPT's task read takes an id however it is typed, and a vague name when search points to one task", async () => {
  const s = await setup();
  try {
    for (const name of ["TST-FX001", "tstfx001", "tst fx001", "FX001"]) assert.equal(getTask(s.ctx, { task: name }).id, "TST-FX001", name);
    // No title has every word whole: search finds the one task, and says how.
    const vague = getTask(s.ctx, { task: "flaky logins test" });
    assert.deepEqual([vague.id, vague.found_by, vague.error], ["TST-FX001", "title: «Fix flaky login test»", ""]);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).found_by, undefined, "a name that is an id says nothing more");
    // Several equal matches: the error names them, with ids.
    const two = getTask(s.ctx, { task: "logins" });
    assert.match(two.error, /^No task matches «logins»\. Closest: TST-(FX001|RD002) .*TST-(FX001|RD002) .*Use the id\.$/);
  } finally {
    s.stop();
  }
});

test("a title that only looks like an id is still a title, for reads and writes", async () => {
  const s = await setup();
  try {
    // «Tst paths» packs to TSTPATHS: the key TST and five letters, the shape of TST-PATHS.
    const created = await createTask(s.ctx, { title: "Tst paths", project: "core" });
    assert.equal(created.ok, true, created.error);
    assert.equal(getTask(s.ctx, { task: "Tst paths" }).id, created.id);
    const saved = await updateTask(s.ctx, { task: "tst paths", priority: "low" });
    assert.equal(saved.ok, true, saved.error);
    // The id as written, and nothing has it: no guess.
    assert.equal(getTask(s.ctx, { task: "TST-PATHS" }).error, "No task TST-PATHS.");
  } finally {
    s.stop();
  }
});

test("a write never goes to a guessed task: it refuses and names the closest ones", async () => {
  const s = await setup();
  try {
    const refused = await updateTask(s.ctx, { task: "flaky logins test", status: "canceled" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /^No task matches «flaky logins test»\. Closest: TST-FX001 «Fix flaky login test» \(todo\)/);
    assert.equal(s.task("TST-FX001")?.status, "todo");
    // An id typed without its dash is still exact, so a write takes it.
    const moved = await updateTask(s.ctx, { task: "tstfx001", priority: "high" });
    assert.equal(moved.ok, true, moved.error);
  } finally {
    s.stop();
  }
});

test("tasks with a query: best first, with the features, releases and projects the words name", async () => {
  const s = await setup();
  try {
    const login = await listTasks(s.ctx, { query: "login", limit: 20 });
    assert.deepEqual(login.tasks.map((t) => t.id).sort(), ["TST-FX001", "TST-RD002"]);
    assert.deepEqual(login.also, [{ kind: "feature", id: "TST-FEAT1", title: "Login" }]);
    assert.deepEqual((await listTasks(s.ctx, { query: "release 2.3", limit: 20 })).also, [{ kind: "release", id: "TST-MS001", title: "Release 2.3" }]);
    assert.equal((await listTasks(s.ctx, { query: "login", limit: 20, offset: 1 })).also, undefined, "only on the first page");
    // A feature's name finds its tasks too.
    assert.ok((await listTasks(s.ctx, { query: "totp", limit: 20 })).tasks.some((t) => t.id === "TST-TASK1" && t.matched_in === "feature"));
    // Typed on the Ukrainian layout: searched as the other layout, and said so.
    const swapped = await listTasks(s.ctx, { query: "дщпшт", limit: 20 });
    assert.deepEqual([swapped.searched_for, swapped.tasks.length], ["login", 2]);
    assert.equal((await readBoard(s.ctx, { query: "дщпшт" })).searched_for, "login");
    // Some words only: a partial answer, said so.
    const some = await listTasks(s.ctx, { query: "flaky kubernetes", limit: 20 });
    assert.deepEqual([some.partial, some.tasks.map((t) => t.id)], [true, ["TST-FX001"]]);
    assert.equal((await listTasks(s.ctx, { limit: 20 })).partial, undefined);
  } finally {
    s.stop();
  }
});

test("the inbox is searched and paged", async () => {
  const s = await setup();
  try {
    const added = await addToInbox(s.ctx, { items: [{ title: "Retry the login probe" }, { title: "Rotate keys" }, { title: "Login audit" }] });
    assert.equal(added.ok, true, added.error);
    const found = await listInbox(s.ctx, { query: "login", limit: 20 });
    assert.deepEqual(found.items.map((d) => d.title).sort(), ["Login audit", "Retry the login probe"]);
    const all = await listInbox(s.ctx, { limit: 2 });
    const rest = await listInbox(s.ctx, { limit: 2, offset: 2 });
    assert.equal(all.total, 3);
    assert.equal(rest.items.length, 1);
    assert.equal(new Set([...all.items, ...rest.items].map((d) => d.id)).size, 3);
  } finally {
    s.stop();
  }
});

test("an id typed in another form that two files claim is refused as the id written as one is", () => {
  const loaded = validateEntityText("---\nid: LAC-7K3QX\ntype: task\ntitle: Fix login\nstatus: todo\n---\n", "task");
  const plan = { space: undefined, entities: new Map([[loaded.entity.id, loaded]]), duplicates: new Set(["LAC-7K3QX"]), problems: [] };
  const space = { record: { key: "LAC", name: "Laconote" }, sync: { plan } } as unknown as SpaceEntry;
  for (const name of ["LAC-7K3QX", "lac7k3qx", "7K3QX"]) {
    const found = resolveEntity([space], "task", name);
    assert.deepEqual(found, { ok: false, error: "LAC-7K3QX is claimed by two files in the plan repo; rename one first." }, name);
  }
});
