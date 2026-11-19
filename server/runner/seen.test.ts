import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factText, lineDiff, SeenStore, taskInstructions } from "./seen.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "dashboard-seen-")), "seen.json");
const brief = (text: string) => ({ key: "task:T1", name: "the brief and acceptance", text, author: "anna" });

test("instructions: not seen yet, unchanged, or changed since the user last saw them", () => {
  const store = new SeenStore(file());
  let [fact] = store.facts("TST", [brief("one\ntwo")]);
  assert.equal(fact!.state, "unseen");
  assert.deepEqual(fact!.diff, [{ op: "+", text: "one" }, { op: "+", text: "two" }], "an unseen part shows whole");
  assert.equal(factText([fact!]), "not seen by you yet (per git: anna)");

  store.mark("TST", brief("one\ntwo"));
  [fact] = store.facts("TST", [brief("one\ntwo")]);
  assert.equal(fact!.state, "unchanged");
  assert.deepEqual(fact!.diff, []);
  assert.equal(factText([fact!]), "unchanged since you last saw them");

  [fact] = store.facts("TST", [brief("one\n2")]);
  assert.equal(fact!.state, "changed");
  assert.deepEqual(fact!.diff, [{ op: " ", text: "one" }, { op: "+", text: "2" }, { op: "-", text: "two" }]);
  assert.equal(factText([fact!]), "changed since you last saw them (per git: anna)");
});

test("each part is named when the parts differ", () => {
  const store = new SeenStore(file());
  const template = { key: "template", name: "the space's start template", text: "Do {{brief}}", author: "bob" };
  store.mark("TST", brief("same"));
  const facts = store.facts("TST", [brief("same"), template]);
  assert.equal(factText(facts), "the brief and acceptance: unchanged since you last saw them; the space's start template: not seen by you yet (per git: bob)");
});

test("the records survive a restart, and a version 1 file reads as nothing seen", () => {
  const path = file();
  new SeenStore(path).mark("TST", brief("kept"));
  assert.equal(new SeenStore(path).facts("TST", [brief("kept")])[0]!.state, "unchanged");

  writeFileSync(path, JSON.stringify({ version: 1, seen: { "TST/T1": "abc" } }));
  const old = new SeenStore(path);
  assert.equal(old.movedAside, undefined, "an old file is not treated as broken");
  assert.equal(old.facts("TST", [brief("kept")])[0]!.state, "unseen");
  old.mark("TST", brief("kept"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
});

test("a line diff keeps two lines of context and marks each gap once", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
  const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n");
  assert.deepEqual(lineDiff(before, after), [
    { op: "…", text: "" },
    { op: " ", text: "c" },
    { op: " ", text: "d" },
    { op: "+", text: "E" },
    { op: "-", text: "e" },
    { op: " ", text: "f" },
    { op: " ", text: "g" },
    { op: "…", text: "" },
  ]);
});

test("a task's instructions read as the task screen shows them", () => {
  assert.equal(taskInstructions("  Do it.\n", ["works ", "tested"]), "Do it.\n\nAcceptance:\n- [ ] works\n- [ ] tested");
  assert.equal(taskInstructions("", []), "");
});

test("an empty text seen before diffs like any other; only a text too long to keep does not", () => {
  const store = new SeenStore(file());
  store.mark("TST", brief(""));
  assert.deepEqual(store.facts("TST", [brief("now a brief")])[0]!.diff, [
    { op: "+", text: "now a brief" },
    { op: "-", text: "" },
  ]);
  store.mark("TST", brief("x".repeat(70_000)));
  assert.deepEqual(store.facts("TST", [brief("short")])[0]!.diff, [{ op: "…", text: "too long to compare; read it in full" }]);
});
