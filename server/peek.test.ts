import { test } from "node:test";
import assert from "node:assert/strict";
import { canStep, CLOSED, current, decode, encode, MAX_STEPS, open, type Peek, position, sibling, step } from "../client/peek.ts";

/**
 * The inspector's steps (client/peek.ts), walked through the ways people move in it: a station's
 * tasks, previous and next in a list, back and forward, and the `peek` param a screen leads back with.
 */

const station: Peek = { kind: "station", space: "PDT", key: "later:-:core", project: "core", title: "TOTP endpoints +2" };
const list = [
  { id: "PDT-T0001", title: "TOTP endpoints" },
  { id: "PDT-T0002", title: "Recovery codes" },
  { id: "PDT-T0003", title: "Force 2FA" },
];
const task = (id: string): Peek => ({ kind: "task", task: id, title: list.find((s) => s.id === id)?.title, list });

test("station → task → back returns to the station's tasks in one step", () => {
  let s = open(CLOSED, station);
  s = open(s, task("PDT-T0002"));
  assert.equal(current(s)?.kind, "task");
  s = step(s, -1);
  assert.deepEqual(current(s), station);
  assert.equal(canStep(s, -1), false);
  s = step(s, 1);
  assert.equal((current(s) as { task: string }).task, "PDT-T0002");
});

test("next and previous walk the list in place, so back still leads to the station", () => {
  let s = open(open(CLOSED, station), task("PDT-T0001"));
  assert.deepEqual(position(s), { index: 0, count: 3 });
  s = sibling(s, 1);
  s = sibling(s, 1);
  assert.deepEqual(position(s), { index: 2, count: 3 });
  assert.equal((current(s) as { title?: string }).title, "Force 2FA");
  // Past the end: nothing moves.
  assert.deepEqual(sibling(s, 1), s);
  s = step(s, -1);
  assert.deepEqual(current(s), station);
  assert.equal(s.entries.length, 2);
});

test("a task opened without a list, or a list of one, has no previous or next", () => {
  const alone = open(CLOSED, { kind: "task", task: "PDT-T0001" });
  assert.equal(position(alone), undefined);
  assert.deepEqual(sibling(alone, 1), alone);
  const one = open(CLOSED, { kind: "task", task: "PDT-T0001", list: [list[0]!] });
  assert.equal(position(one), undefined);
});

test("next drops the steps ahead: they led from the task it replaced", () => {
  let s = open(open(CLOSED, station), task("PDT-T0001"));
  s = open(s, { kind: "task", task: "PDT-T0009", title: "Waited for" });
  s = step(s, -1);
  assert.equal(canStep(s, 1), true);
  s = sibling(s, 1);
  assert.equal(canStep(s, 1), false);
});

test("opening from a step back drops the steps ahead, as a browser does", () => {
  let s = open(open(open(CLOSED, station), task("PDT-T0001")), { kind: "feature", feature: "PDT-F0001" });
  s = step(step(s, -1), -1);
  s = open(s, { kind: "line", space: "PDT", project: "core" });
  assert.equal(s.entries.length, 2);
  assert.equal(canStep(s, 1), false);
  assert.equal(current(s)?.kind, "line");
});

test("the entry on view opened again stays one step and takes the newer list", () => {
  let s = open(CLOSED, { kind: "task", task: "PDT-T0001" });
  s = open(s, task("PDT-T0001"));
  assert.equal(s.entries.length, 1);
  assert.deepEqual(position(s), { index: 0, count: 3 });
  // Without a list it keeps the one it has.
  s = open(s, { kind: "task", task: "PDT-T0001" });
  assert.deepEqual(position(s), { index: 0, count: 3 });
});

test("the steps are capped, the newest kept", () => {
  let s = CLOSED;
  for (let i = 0; i < MAX_STEPS + 10; i++) s = open(s, { kind: "task", task: `PDT-T${i}` });
  assert.equal(s.entries.length, MAX_STEPS);
  assert.equal(s.at, MAX_STEPS - 1);
  assert.equal((current(s) as { task: string }).task, `PDT-T${MAX_STEPS + 9}`);
});

test("back and forward do nothing with the panel closed", () => {
  assert.deepEqual(step(CLOSED, -1), CLOSED);
  assert.deepEqual(step(CLOSED, 1), CLOSED);
  assert.equal(current(CLOSED), undefined);
});

test("the peek param carries the entry without its list, and reads back", () => {
  const param = encode(task("PDT-T0002"));
  assert.ok(!param.includes("Recovery"));
  assert.deepEqual(decode(param), { kind: "task", task: "PDT-T0002" });
  assert.deepEqual(decode(encode(station)), station);
  assert.deepEqual(decode(encode({ kind: "line", space: "PDT", project: "core" })), { kind: "line", space: "PDT", project: "core" });
  assert.deepEqual(decode(encode({ kind: "feature", feature: "PDT-F0001", title: "2FA" })), { kind: "feature", feature: "PDT-F0001" });
  assert.equal(encode(undefined), "");
});

test("a peek param that is not one of ours is none", () => {
  for (const bad of [undefined, "", "task:PDT-T0001", "null", "[]", '{"kind":"task"}', '{"kind":"task","task":7}', '{"kind":"line","space":"PDT"}', '{"kind":"station","space":"PDT","key":"later:-:core"}', '{"kind":"other","id":"x"}']) {
    assert.equal(decode(bad), undefined, String(bad));
  }
});
