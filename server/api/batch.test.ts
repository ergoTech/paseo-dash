import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT_CHUNK } from "../../shared/api.ts";
import { readProfiles, readTaskText, updateTasks, updateTasksCheck } from "./batch.ts";
import { getTask } from "./reads.ts";
import { setup } from "./testing.ts";
import { settled } from "../runner/testing.ts";
import { startTask, updateTask } from "./writes.ts";

/**
 * Batches and full text for God Mode (JOBBY-YV2QS, part 2). 107 profiles were set one update_task
 * and one read-back at a time, two after errors; a brief past 1200 characters could not be read whole.
 */

const PROFILES = {
  profiles: [
    { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" },
    { id: "p2", name: "Sonnet 5.5 High", provider: "claude", model: "claude-sonnet-5-5", modeId: "default", thinkingOptionId: "high" },
    { id: "p3", name: "Opus 5.5 High", provider: "claude", model: "claude-opus-5-5", modeId: "default", thinkingOptionId: "high" },
  ],
};

test("a batch sets each task's profile and nothing else; the revision of its read-back guards it", async () => {
  const s = await setup(PROFILES);
  try {
    const before = (id: string) => {
      const t = s.task(id)!;
      return { status: t.status, depends_on: t.depends_on, rank: t.rank, run_id: t.run_id, priority: t.priority };
    };
    const kept = { FX: before("TST-FX001"), DEP: before("TST-DEP01"), RD: before("TST-RD002") };
    const items = [
      { task: "TST-FX001", agent_profile: "sonnet 5.5 high" },
      { task: "TST-DEP01", agent_profile: "Opus 5.5 High" },
      { task: "TST-RD002", agent_profile: "Opus 5.5 High" },
    ];
    const check = await updateTasksCheck(s.ctx, { items });
    assert.equal(check.error, "");
    assert.equal(check.count, 3);
    assert.match(check.changes, /TST-FX001 \(none\) → Sonnet 5\.5 High/);

    const answer = await updateTasks(s.ctx, { items, revision: check.revision, key: "batch-0001" });
    assert.deepEqual(answer.counts, { applied: 3, already: 0, refused: 0, unknown: 0 }, JSON.stringify(answer));
    assert.equal(s.task("TST-FX001")!.agent_profile, "Sonnet 5.5 High", "spelled as this Mac names it");
    assert.equal(s.task("TST-RD002")!.agent_profile, "Opus 5.5 High", "a task another machine runs gets it for its next start");
    assert.deepEqual({ FX: before("TST-FX001"), DEP: before("TST-DEP01"), RD: before("TST-RD002") }, kept, "status, order, dependencies and run stay");

    // A stale revision changes nothing.
    const stale = await updateTasks(s.ctx, { items: [{ task: "TST-FX001", agent_profile: "Review" }], revision: check.revision, key: "batch-0002" });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /changed since they were read/);
    assert.equal(s.task("TST-FX001")!.agent_profile, "Sonnet 5.5 High");
    // tasks_profiles is the read-back: its revision is the one update_tasks takes.
    const profiles = await readProfiles(s.ctx, { tasks: ["TST-FX001", "TST-DEP01", "TST-RD002"] });
    const fresh = await updateTasks(s.ctx, { items: items.map((i) => ({ ...i, agent_profile: "Review" })), revision: profiles.revision, key: "batch-0006" });
    assert.deepEqual(fresh.counts, { applied: 3, already: 0, refused: 0, unknown: 0 }, fresh.error);
  } finally {
    s.stop();
  }
});

test("unknown tasks and profiles are refused each with its own error; the rest of the batch applies", async () => {
  const s = await setup(PROFILES);
  try {
    const items = [
      { task: "TST-FX001", agent_profile: "Opus 5.5 High" },
      { task: "TST-NOPE1", agent_profile: "Opus 5.5 High" },
      { task: "TST-DEP01", agent_profile: "Gemini Ultra" },
      { task: "TST-FX001", agent_profile: "Review" },
    ];
    const check = await updateTasksCheck(s.ctx, { items });
    assert.match(check.refused, /TST-NOPE1: /);
    assert.match(check.refused, /TST-DEP01: no agent profile «Gemini Ultra» on this Mac; profiles: Review, Sonnet 5\.5 High, Opus 5\.5 High/);
    assert.match(check.refused, /named twice/);
    const answer = await updateTasks(s.ctx, { items, revision: check.revision, key: "batch-0003" });
    assert.deepEqual(answer.items.map((i) => [i.task, i.result]), [
      ["TST-FX001", "applied"],
      ["TST-NOPE1", "refused"],
      ["TST-DEP01", "refused"],
      ["TST-FX001", "refused"],
    ]);
    assert.equal(answer.ok, false, "refusals are not hidden");
    assert.equal(s.task("TST-DEP01")!.agent_profile, undefined);
  } finally {
    s.stop();
  }
});

test("a timeout leaves items unknown; the retry with the same key delivers each once and never overwrites a later change", async () => {
  const s = await setup(PROFILES);
  try {
    const items = [
      { task: "TST-FX001", agent_profile: "Opus 5.5 High" },
      { task: "TST-DEP01", agent_profile: "Sonnet 5.5 High" },
    ];
    const check = await updateTasksCheck(s.ctx, { items });
    // The plan answers later than the call waits: the changes stay queued.
    const late = await updateTasks({ ...s.ctx, writeWaitMs: 0 }, { items, revision: check.revision, key: "batch-0004" });
    assert.deepEqual(late.counts, { applied: 0, already: 0, refused: 0, unknown: 2 }, JSON.stringify(late));
    assert.match(late.error, /same key/);
    await s.settle();
    const queued = s.sync().journalEntries.length;

    const retry = await updateTasks(s.ctx, { items, revision: "whatever-the-retry-carries", key: "batch-0004" });
    assert.deepEqual(retry.counts, { applied: 2, already: 0, refused: 0, unknown: 0 }, JSON.stringify(retry));
    assert.equal(s.sync().journalEntries.length, queued, "delivered by the first call: nothing journaled again");

    // Someone sets another profile; the same key again does not undo it.
    const other = await updateTask(s.ctx, { task: "TST-FX001", agent_profile: "Review" });
    assert.equal(other.ok, true, other.error);
    const again = await updateTasks(s.ctx, { items, revision: "x", key: "batch-0004" });
    assert.deepEqual(again.items.map((i) => i.result), ["applied", "applied"]);
    assert.equal(s.task("TST-FX001")!.agent_profile, "Review", "the later change stays");

    // The key belongs to this batch.
    const reused = await updateTasks(s.ctx, { items: [items[0]!], revision: "x", key: "batch-0004" });
    assert.match(reused.error, /used for another batch/);
  } finally {
    s.stop();
  }
});

test("a running agent keeps its model: the profile is the next start's, said apart from the agent's", async () => {
  const s = await setup(PROFILES);
  try {
    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => Boolean(run.agentId));
    const agent = run.agentId;
    const runId = s.task("TST-FX001")!.run_id;
    const check = await updateTasksCheck(s.ctx, { items: [{ task: "TST-FX001", agent_profile: "Opus 5.5 High" }] });
    const answer = await updateTasks(s.ctx, { items: [{ task: "TST-FX001", agent_profile: "Opus 5.5 High" }], revision: check.revision, key: "batch-0005" });
    assert.equal(answer.items[0]!.result, "applied");
    assert.match(answer.items[0]!.note, /its agent at work keeps .* until the task's next start/);
    assert.equal(s.task("TST-FX001")!.run_id, runId);
    assert.equal(s.task("TST-FX001")!.status, "in_progress");
    assert.equal(s.dashboard.runs!.byTask("TST-FX001")!.agentId, agent, "no agent restarted");
    const profiles = await readProfiles(s.ctx, { tasks: ["TST-FX001", "TST-NOPE9"] });
    const row = profiles.tasks[0]!;
    assert.match(row.next_start, /^its profile Opus 5\.5 High: claude\/claude-opus-5-5, effort high/);
    assert.match(row.running, /claude-haiku-5-5|default model/);
    assert.notEqual(row.running, "");
    assert.match(profiles.tasks[1]!.error, /TST-NOPE9/);
    assert.equal(profiles.revision.length > 0, true);
  } finally {
    s.stop();
  }
});

test("a long brief reads whole in parts of one revision; the compact task read stays short and says there is more", async () => {
  const s = await setup(PROFILES);
  try {
    const brief = Array.from({ length: 400 }, (_, i) => `Line ${i}: ${"x".repeat(20)} ✓`).join("\n");
    s.f.external("ergo", (root) =>
      writeFileSync(join(root, "tasks", "TST-BR3FX-long.md"), `---\nid: TST-BR3FX\ntype: task\ntitle: Long\nstatus: todo\nproject: core\n---\n\n## Brief\n\n${brief}\n\n## Acceptance\n\n- [x] one\n- [ ] two\n`),
    );
    await s.sync().sync();
    const compact = getTask(s.ctx, { task: "TST-BR3FX" });
    assert.ok(compact.brief.length <= 1200);
    assert.equal(compact.brief_chars, brief.length);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).brief_chars, undefined, "left out for a short brief");

    let text = "";
    let cursor = 0;
    let revision = "";
    for (let parts = 0; parts < 100; parts++) {
      const part = readTaskText(s.ctx, { task: "TST-BR3FX", section: "brief", cursor, revision: revision || undefined });
      assert.equal(part.error, "");
      assert.ok(part.text.length <= TEXT_CHUNK);
      text += part.text;
      revision = part.revision;
      if (!part.truncated) break;
      cursor = part.next_cursor;
    }
    assert.equal(text, brief, "nothing lost");
    const acceptance = readTaskText(s.ctx, { task: "TST-BR3FX", section: "acceptance" });
    assert.equal(acceptance.text, "1. [x] one\n2. [ ] two");

    // A change between parts: the next part is refused rather than joined to the old ones.
    await updateTask(s.ctx, { task: "TST-BR3FX", brief: `${brief}\nmore` });
    const stale = readTaskText(s.ctx, { task: "TST-BR3FX", section: "brief", cursor: TEXT_CHUNK, revision });
    assert.match(stale.error, /changed since the last part/);
  } finally {
    s.stop();
  }
});
