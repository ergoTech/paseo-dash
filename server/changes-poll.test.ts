import { test } from "node:test";
import assert from "node:assert/strict";
import { pollChanges, sharedPoll } from "../client/changes-poll.ts";

/**
 * The token poll (client/changes-poll.ts) on short real timers: what the screens rely on is when
 * requests go out, so that is what is watched.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(readMs = 0) {
  const state = { token: "a", visible: true, fail: false, reads: 0, changes: 0, open: 0, mostOpen: 0, settle: undefined as (() => void) | undefined, hold: false, listener: () => {} };
  const stop = pollChanges({
    read: async () => {
      state.reads++;
      state.open++;
      state.mostOpen = Math.max(state.mostOpen, state.open);
      await wait(readMs);
      state.open--;
      if (state.fail) throw new Error("offline");
      return { token: state.token };
    },
    changed: () => {
      state.changes++;
      return state.hold ? new Promise<void>((resolve) => (state.settle = resolve)) : Promise.resolve();
    },
    visible: () => state.visible,
    onVisibility: (listener) => {
      state.listener = listener;
      return () => {
        state.listener = () => {};
      };
    },
    pauseMs: 1,
  });
  return { state, stop };
}

test("the first answer only sets the base; a moved token refreshes once, a standing one never", async () => {
  const { state, stop } = harness();
  await wait(40);
  assert.ok(state.reads >= 2);
  assert.equal(state.changes, 0);
  state.token = "b";
  await wait(40);
  assert.equal(state.changes, 1);
  stop();
});

test("a slow answer holds the next request back: requests never overlap", async () => {
  const { state, stop } = harness(15);
  state.listener(); // Coming back on screen while a request is out does not send a second one.
  await wait(120);
  assert.ok(state.reads >= 3, `${state.reads} requests`);
  assert.equal(state.mostOpen, 1);
  stop();
});

test("the next request waits for the reads a moved token caused", async () => {
  const { state, stop } = harness();
  await wait(20);
  state.hold = true;
  state.token = "b";
  await wait(20);
  const during = state.reads;
  await wait(30);
  assert.equal(state.reads, during);
  state.settle!();
  await wait(20);
  assert.ok(state.reads > during);
  stop();
});

test("hidden, nothing goes out; back on screen it asks at once and sees what changed meanwhile", async () => {
  const { state, stop } = harness();
  await wait(20);
  state.visible = false;
  state.listener();
  await wait(20); // The request already out may finish; none follows it.
  const hidden = state.reads;
  state.token = "b";
  await wait(40);
  assert.equal(state.reads, hidden);
  assert.equal(state.changes, 0);
  state.visible = true;
  state.listener();
  await wait(20);
  assert.ok(state.reads > hidden);
  assert.equal(state.changes, 1);
  stop();
});

test("a surface mounted while the app is hidden sends nothing until it is back", async () => {
  const reads: number[] = [];
  let visible = false;
  let listener = () => {};
  const stop = pollChanges({
    read: async () => {
      reads.push(1);
      return { token: "a" };
    },
    changed: async () => undefined,
    visible: () => visible,
    onVisibility: (l) => {
      listener = l;
      return () => undefined;
    },
    pauseMs: 1,
  });
  await wait(20);
  assert.equal(reads.length, 0);
  visible = true;
  listener();
  await wait(20);
  assert.ok(reads.length > 0);
  stop();
});

test("a failed request is asked again and keeps the base; stopping ends it", async () => {
  const { state, stop } = harness();
  await wait(20);
  state.fail = true;
  await wait(20);
  const failing = state.reads;
  assert.equal(state.changes, 0);
  state.token = "b";
  state.fail = false;
  await wait(20);
  assert.ok(state.reads > failing);
  assert.equal(state.changes, 1);
  stop();
  await wait(5);
  const stopped = state.reads;
  await wait(20);
  assert.equal(state.reads, stopped);
});

test("surfaces share one poll: started by the first, stopped by the last", () => {
  const polls = new WeakMap<object, { users: number; stop: () => void }>();
  const key = {};
  let started = 0;
  let stops = 0;
  const start = () => {
    started++;
    return () => {
      stops++;
    };
  };
  const first = sharedPoll(polls, key, start);
  const second = sharedPoll(polls, key, start);
  assert.equal(started, 1);
  first();
  first(); // A second release of the same user counts once.
  assert.equal(stops, 0);
  second();
  assert.equal(stops, 1);
  sharedPoll(polls, key, start);
  assert.equal(started, 2);
});
