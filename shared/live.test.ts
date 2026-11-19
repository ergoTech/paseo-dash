import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, LATE_GLOW_MS, LIVE_GLOW_MS, liveGlow, overlapText, liveAge, liveFresh, liveSpoken, liveText, toolName } from "./live.ts";

const AT = "2026-11-13T16:06:45.000Z";
const at = Date.parse(AT);

test("a live line names the operation, its target and how long ago the call started", () => {
  assert.equal(liveText({ op: "write", target: "tmp-live-check/notes.txt", at: AT }, at + 1_000), "✚ tmp-live-check/notes.txt · now");
  assert.equal(liveText({ op: "edit", target: "src/auth/session.ts", at: AT }, at + 12_000, true), "✎ session.ts · 12 s");
  assert.equal(liveText({ op: "shell", target: "npm", at: AT }, at + 3 * 60_000), "▶ npm · 3 min");
  assert.equal(liveText({ op: "agent", target: "Read package.json name", at: AT }, at + 2 * 3_600_000), "⑂ Read package.json name · 2 h");
  // A shell command's program is not a path: `short` keeps it whole.
  assert.equal(liveText({ op: "shell", target: "./scripts/run", at: AT }, at, true), "▶ ./scripts/run · now");
});

test("a tool reads by its own name; Paseo Dash's report tool by what it does", () => {
  assert.equal(toolName("mcp__dashboard__task_report"), "progress report");
  assert.equal(toolName("mcp__github__create_pull_request"), "create pull request");
  assert.equal(toolName("TodoWrite"), "TodoWrite");
  assert.equal(liveText({ op: "tool", target: "mcp__dashboard__task_report", at: AT }, at), "⚙ progress report · now");
});

test("a call glows for LIVE_GLOW_MS from its start; a client clock behind the server's counts as now", () => {
  const now = { op: "edit", target: "a.ts", at: AT };
  assert.equal(liveFresh(now, at + LIVE_GLOW_MS - 1), true);
  assert.equal(liveFresh(now, at + LIVE_GLOW_MS), false);
  assert.equal(liveFresh(now, at - 2_000), true);
  assert.equal(liveAge(now, at - 2_000), "now");
  assert.equal(liveAge({ ...now, at: "not a time" }, at), "");
});

test("a Claude call whose path has not arrived yet reads as what it does, not as the tool's name", () => {
  assert.equal(liveText({ op: "tool", target: "Write", at: AT }, at), "✚ writing · now");
  assert.equal(liveText({ op: "tool", target: "Agent", at: AT }, at + 1_000), "⑂ starting a sub-agent · now");
  assert.equal(liveText({ op: "tool", target: "task_notification", at: AT }, at), "⚙ task notification · now");
});

test("short keeps a read's or a write's file name; a path outside the repository stays as reported", () => {
  assert.equal(liveText({ op: "read", target: "docs/a/b.md", at: AT }, at, true), "◉ b.md · now");
  assert.equal(liveText({ op: "write", target: "/tmp/scratch.txt", at: AT }, at), "✚ /tmp/scratch.txt · now");
  assert.equal(toolName("mcp__claude_ai_Gmail__send_message"), "send message");
});

test("the spoken line says the step in words", () => {
  assert.equal(liveSpoken({ op: "edit", target: "src/a.ts", at: AT }, at + 12_000), "editing src/a.ts, 12 seconds ago");
  assert.equal(liveSpoken({ op: "tool", target: "Write", at: AT }, at), "writing, just now");
  assert.equal(liveSpoken({ op: "tool", target: "mcp__dashboard__task_report", at: AT }, at + 120_000), "using progress report, 2 minutes ago");
});

test("a station keeps a path's file name", () => {
  assert.equal(baseName("src/auth/session.ts"), "session.ts");
  assert.equal(baseName("README.md"), "README.md");
});

test("an overlap reads as the other task and the shared file names", () => {
  assert.equal(overlapText({ task: "ERG-WDJ7X", files: ["tmp-live-check/notes.txt", "src/a.ts"], more: 0 }), "ERG-WDJ7X: notes.txt, a.ts");
  assert.equal(overlapText({ task: "ERG-X", files: ["a.ts"], more: 3 }), "ERG-X: a.ts +3");
});

test("two shared files of one name keep their paths", () => {
  assert.equal(overlapText({ task: "ERG-X", files: ["src/a/index.ts", "src/b/index.ts", "src/c.ts"], more: 0 }), "ERG-X: src/a/index.ts, src/b/index.ts, c.ts");
});

test("a call glows from its start, or from when it was first seen if that was late, and not once it is old", () => {
  const now = { op: "edit", target: "a.ts", at: AT };
  assert.equal(liveGlow(now, at + 1_000, at + 1_000), true, "within the window from its start");
  // Seen 8 s after it started (a slow poll): it glows 5 s from then.
  assert.equal(liveGlow(now, at + 9_000, at + 8_000), true);
  assert.equal(liveGlow(now, at + 13_500, at + 8_000), false);
  // Seen again on a card mounted later: the first sight counts, not the mount.
  assert.equal(liveGlow(now, at + 20_000, at + 2_000), false);
  // Too old to glow, however late it was first seen.
  assert.equal(liveGlow(now, at + LATE_GLOW_MS + 1, at + LATE_GLOW_MS), false);
  // A client clock behind the server's: just started. A start that does not read: no glow.
  assert.equal(liveGlow(now, at - 2_000, at - 2_000), true);
  assert.equal(liveGlow({ ...now, at: "not a time" }, at, at), false);
});

test("a label not redrawn as time passes says the step without its age", () => {
  assert.equal(liveSpoken({ op: "edit", target: "src/a.ts", at: AT }, at + 12_000, false), "editing src/a.ts");
});
