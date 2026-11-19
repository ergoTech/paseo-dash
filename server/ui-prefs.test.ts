import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRecent, readPrefs, readRecent, UiPrefsStore, writePrefs } from "./ui-prefs.ts";

test("the sidebar's row per space is off until turned on, and stays as set", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-prefs-"));
  const store = new UiPrefsStore(dir);
  assert.deepEqual(store.get(), { space_rows: false });
  const dashboard = { prefs: store, owner: true, ownerReason: "" };
  assert.deepEqual(writePrefs(dashboard, { space_rows: true }), { space_rows: true, ok: true, error: "" });
  assert.deepEqual(new UiPrefsStore(dir).get(), { space_rows: true }, "read back from ui.json");
  assert.deepEqual(writePrefs(dashboard, {}), { space_rows: true, ok: true, error: "" }, "an absent field stays");
});

test("an unreadable ui.json is moved aside, not silently reset; another installation answers the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-prefs-"));
  writeFileSync(join(dir, "ui.json"), "{ not json");
  const store = new UiPrefsStore(dir);
  assert.deepEqual(store.get(), { space_rows: false });
  assert.ok(store.movedAside && existsSync(store.movedAside));
  const stranger = { prefs: undefined, owner: false, ownerReason: "another installation owns the data" };
  assert.deepEqual(readPrefs(stranger), { space_rows: false, error: "another installation owns the data" });
  assert.equal(writePrefs(stranger, { space_rows: true }).ok, false);
});

test("the search's recent places: newest first, each once, ten at most, kept in ui.json with the sidebar choice", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-prefs-"));
  const store = new UiPrefsStore(dir);
  const dashboard = { prefs: store, owner: true, ownerReason: "" };
  assert.deepEqual(readRecent(dashboard), { items: [], error: "" });
  writePrefs(dashboard, { space_rows: true });
  const task = (n: number) => ({ kind: "task" as const, id: `LAC-${String(n).padStart(5, "0")}`, title: `Task ${n}`, space: "LAC" });
  for (let n = 0; n < 12; n += 1) assert.equal(addRecent(dashboard, task(n)).ok, true);
  assert.deepEqual(store.recent().map((r) => r.title), ["Task 11", "Task 10", "Task 9", "Task 8", "Task 7", "Task 6", "Task 5", "Task 4", "Task 3", "Task 2"]);
  // Opened again: first, once, with its title as it is now.
  addRecent(dashboard, { ...task(5), title: "Task 5, renamed" });
  assert.deepEqual(store.recent().slice(0, 2).map((r) => r.title), ["Task 5, renamed", "Task 11"]);
  assert.equal(store.recent().filter((r) => r.id === task(5).id).length, 1);
  // A line and a feature are places too; a line is its project in its space.
  addRecent(dashboard, { kind: "line", id: "core", title: "core", space: "LAC" });
  const again = new UiPrefsStore(dir);
  assert.deepEqual(again.recent()[0], { kind: "line", id: "core", title: "core", space: "LAC" }, "read back from ui.json");
  assert.deepEqual(again.get(), { space_rows: true }, "the sidebar choice stays");
});

test("a ui.json from before the recent places, or with a list that does not read, keeps the sidebar choice", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-prefs-"));
  writeFileSync(join(dir, "ui.json"), JSON.stringify({ version: 1, space_rows: true }));
  assert.deepEqual(new UiPrefsStore(dir).recent(), []);
  writeFileSync(join(dir, "ui.json"), JSON.stringify({ version: 1, space_rows: true, recent: [{ kind: "nonsense" }] }));
  const store = new UiPrefsStore(dir);
  assert.deepEqual([store.get(), store.recent(), store.movedAside], [{ space_rows: true }, [], undefined]);
  // Another installation remembers nothing and says why.
  const stranger = { prefs: undefined, owner: false, ownerReason: "another installation owns the data" };
  assert.deepEqual(readRecent(stranger), { items: [], error: "another installation owns the data" });
  assert.deepEqual(addRecent(stranger, { kind: "task", id: "LAC-00001", title: "x", space: "LAC" }), { ok: false, error: "another installation owns the data" });
  assert.ok(readFileSync(join(dir, "ui.json"), "utf8").includes("nonsense"), "nothing written by a read");
});
