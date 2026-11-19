import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DEPTH, ScreenHistory, type ScreenLocation } from "../client/history.ts";

/**
 * "‹ Back" on the dashboard's screens (client/history.ts), walked through the ways people move:
 * each step is what a screen does, `go` when a dashboard screen opens another, `arrive` when a screen
 * comes into view, `back` for the button.
 */

const map = (tab = "map", more: Record<string, string> = {}): ScreenLocation => ({ screenId: "space", params: { space: "PDT", tab, ...more }, title: tab });
const task = (id: string, title = id): ScreenLocation => ({ screenId: "task", params: { task: id }, title });
const feature = (id: string, title = id): ScreenLocation => ({ screenId: "feature", params: { feature: id }, title });
const line = (project: string): ScreenLocation => ({ screenId: "line", params: { space: "PDT", project }, title: project });

/** A dashboard screen opens another, which then comes into view. */
function open(h: ScreenHistory, from: ScreenLocation | undefined, to: ScreenLocation): void {
  h.go(from, to);
  h.arrive(to);
}

/** "‹ Back" pressed on the screen at `own`; the screen it returns to comes into view. */
function back(h: ScreenHistory, own: ScreenLocation, fallback?: ScreenLocation): ScreenLocation | undefined {
  const target = h.back(own, fallback);
  if (target) h.arrive(target);
  return target;
}

test("map → task → back returns to the map with its tab and filters", () => {
  const h = new ScreenHistory();
  const live = map("live", { group: "Paseo", empty: "off" });
  h.arrive(map());
  open(h, live, task("PDT-T0001", "TOTP endpoints"));
  assert.equal(h.previous()?.title, "live");
  assert.deepEqual(back(h, task("PDT-T0001"))?.params, { empty: "off", group: "Paseo", space: "PDT", tab: "live" });
  assert.equal(h.depth(), 0);
});

test("map → feature → task → back → back walks the same way home", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), feature("PDT-F0001", "TOTP 2FA"));
  open(h, feature("PDT-F0001", "TOTP 2FA"), task("PDT-T0002"));
  assert.equal(h.previous()?.title, "TOTP 2FA");
  assert.equal(back(h, task("PDT-T0002"))?.screenId, "feature");
  assert.equal(back(h, feature("PDT-F0001"))?.screenId, "space");
  assert.equal(back(h, map()), undefined, "nothing left and no parent given");
});

test("task → dependency → dependency → back twice; a link to the task on view adds no step", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), task("A"));
  open(h, task("A"), task("B"));
  open(h, task("B"), task("C"));
  open(h, task("C"), task("C"));
  assert.equal(h.depth(), 3);
  assert.equal(back(h, task("C"))?.params.task, "B");
  assert.equal(back(h, task("B"))?.params.task, "A");
});

test("going in a circle walks back the way it came: A → B → A, back gives B, A, map", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), task("A"));
  open(h, task("A"), task("B"));
  open(h, task("B"), task("A"));
  assert.equal(h.depth(), 3);
  assert.deepEqual([back(h, task("A"))?.params.task, back(h, task("B"))?.params.task, back(h, task("A"))?.screenId], ["B", "A", "space"]);
});

test("a screen opened from outside the dashboard starts fresh; its back goes to the parent", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), task("A"));
  // A composer pill opens task B through the host: nothing announced it.
  h.arrive(task("B"));
  assert.equal(h.depth(), 0, "the earlier map → A steps do not lead to B");
  // A timeline card opens task D through the dashboard's own call, but not from a dashboard screen.
  open(h, map(), task("A"));
  open(h, undefined, task("D"));
  assert.equal(h.depth(), 0);
  // The sidebar opens the space: an arrival nothing announced.
  open(h, map(), task("C"));
  h.arrive(map("map"));
  assert.equal(h.depth(), 0);
  const parent = feature("PDT-F0001", "TOTP 2FA");
  assert.deepEqual(back(h, map(), parent), { ...parent, params: { feature: "PDT-F0001" } }, "an empty stack falls back to the parent");
});

test("a phone's own back swipe leaves a stale entry; the next open from that screen cuts it away", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), feature("F"));
  open(h, feature("F"), task("A"));
  // The host swipes back twice to the still-mounted map: no arrival, the stack still holds [map, F].
  open(h, map(), task("B"));
  assert.equal(h.depth(), 1, "the map was in the stack: everything above it is gone, the map is pushed once");
  assert.equal(back(h, task("B"))?.screenId, "space");
});

test("going back never repeats a one-shot request: no second Mark done, no second New task form", () => {
  const h = new ScreenHistory();
  h.arrive({ screenId: "space", params: { space: "PDT", new: "task" } });
  open(h, { screenId: "space", params: { space: "PDT", new: "task", notice: "x", search: "1" }, title: "Map" }, { screenId: "task", params: { task: "A", action: "done", ask: "1" }, title: "A" });
  open(h, { screenId: "task", params: { task: "A", action: "done", ask: "1" }, title: "A" }, task("B"));
  assert.deepEqual(back(h, task("B"))?.params, { task: "A" });
  assert.deepEqual(back(h, task("A"))?.params, { space: "PDT" });
});

test("a repeated arrival of the same screen keeps the stack; a different one clears it", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), task("A"));
  h.arrive(task("A"));
  h.arrive(task("A"));
  assert.equal(h.depth(), 1, "re-renders and double effects are not new arrivals");
  h.arrive(line("core"));
  assert.equal(h.depth(), 0);
});

test("the stack keeps the last MAX_DEPTH steps; listeners hear every change", () => {
  const h = new ScreenHistory();
  let heard = 0;
  const off = h.subscribe(() => (heard += 1));
  h.arrive(map());
  let from = map();
  for (let i = 0; i < MAX_DEPTH + 10; i++) {
    const next = task(`T${i}`);
    open(h, from, next);
    from = next;
  }
  assert.equal(h.depth(), MAX_DEPTH);
  assert.equal(h.previous()?.params.task, `T${MAX_DEPTH + 8}`);
  assert.ok(heard >= MAX_DEPTH);
  off();
  const before = heard;
  back(h, task("x"));
  assert.equal(heard, before, "unsubscribed");
});

test("after Paseo's own back reveals a screen, its ‹ Back never points at itself", () => {
  const h = new ScreenHistory();
  h.arrive(map());
  open(h, map(), feature("F", "TOTP 2FA"));
  open(h, feature("F", "TOTP 2FA"), task("A"));
  // The header arrow pops A and reveals the still-mounted F: no arrival, the stack still ends in F.
  assert.equal(h.previous(feature("F"))?.screenId, "space", "F's ‹ Back skips F itself");
  assert.equal(back(h, feature("F"))?.screenId, "space");
  assert.equal(h.depth(), 0);
  // A → B → A, then the host's back from the second A reveals B: B's ‹ Back still leads to A.
  open(h, map(), task("A"));
  open(h, task("A"), task("B"));
  open(h, task("B"), task("A"));
  assert.equal(h.previous(task("B"))?.params.task, "A");
});
