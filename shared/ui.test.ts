import { test } from "node:test";
import assert from "node:assert/strict";
import { slotNote } from "./ui.ts";

test("each run says whether it holds one of the autopilot's slots, and why", () => {
  assert.match(slotNote({ activity: "working", holds_place: true, status: "in_progress" }), /^holds a slot: its agent is at work/);
  assert.match(slotNote({ activity: "launching", holds_place: true, status: "in_progress" }), /^holds a slot: its agent is being started/);
  assert.match(slotNote({ activity: "waiting", holds_place: true, status: "in_progress" }), /^holds a slot: its agent waits for your reply or asks for a permission/);
  assert.match(slotNote({ activity: "stopped", holds_place: false, status: "in_progress" }), /^no slot: its agent stopped .*release it/);
  assert.match(slotNote({ activity: "failed", holds_place: false, status: "in_progress" }), /^no slot: its agent failed/);
  assert.match(slotNote({ activity: "waiting", holds_place: false, status: "review" }), /^no slot: in review/);
  assert.match(slotNote({ activity: "stopped", holds_place: false, status: "review" }), /^no slot: its agent stopped/);
});
