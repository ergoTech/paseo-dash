import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCandidates } from "./candidates.ts";
import { setup } from "./testing.ts";
import { startTask, updateTask } from "./writes.ts";
import { ForgeCli } from "../tracker/forge.ts";
import { settled } from "../runner/testing.ts";

/**
 * What can really start (JOBBY-YV2QS, part 3): 92 of 156 todo tasks were "ready", among them manual,
 * needs-owner and live-check work, so "ready" was read as "an agent can do it". start_candidates
 * groups each todo task by what holds it, in the board's order, and changes nothing.
 */

const task = (root: string, id: string, front: string, brief = "Do it.") =>
  writeFileSync(join(root, "tasks", `${id}-x.md`), `---\nid: ${id}\ntype: task\ntitle: ${id} work\nstatus: todo\nproject: core\n${front}---\n\n## Brief\n\n${brief}\n\n## Acceptance\n\n- [ ] it works\n`);

test("each todo task lands in the group of what holds it; only free ones are for an agent, and reading starts nothing", async () => {
  const s = await setup(undefined, {
    forge: new ForgeCli(async (command, args) =>
      command === "gh" && args[1] === "list" && args.includes("merged")
        ? { code: 0, stdout: JSON.stringify([{ number: 9, url: "https://github.com/acme/core/pull/9", state: "MERGED", mergedAt: "2026-11-23T10:00:00Z", headRefName: "x", isCrossRepository: false, title: "TST-MRG03 done", body: "" }]) }
        : { code: 0, stdout: "[]" },
    ),
  });
  try {
    s.f.external("ergo", (root) => {
      const space = readFileSync(join(root, "space.yaml"), "utf8");
      writeFileSync(join(root, "space.yaml"), `${space}defaults:\n  human_labels: [ops]\n`);
      task(root, "TST-HMN01", "labels: [manual]\n");
      task(root, "TST-0PS01", "labels: [ops]\n");
      task(root, "TST-REQ01", "requires:\n  - { kind: owner, reason: pick the grace period, checked: 2026-11-20 }\n");
      task(root, "TST-ENV01", "requires:\n  - { kind: device, reason: an iPhone with iOS 26 }\n");
      task(root, "TST-QST01", "", "Do it.\n\nOpen questions:\n- Which bucket do we use?");
      task(root, "TST-MRG03", "created: 2026-11-20T10:00:00Z\n");
      task(root, "TST-CHK01", "readiness_checked: 2026-11-24\nreadiness_note: brief and access checked\n");
    });
    await s.sync().sync();
    await s.dashboard.merged.checkAll();
    const journal = s.sync().journalEntries.length;
    const read = await startCandidates(s.ctx, { limit: 50 });
    assert.equal(read.error, "");
    const group = (id: string) => read.tasks.find((t) => t.id === id)?.group;
    assert.deepEqual(
      Object.fromEntries(["TST-FX001", "TST-DEP01", "TST-ST001", "TST-HMN01", "TST-0PS01", "TST-REQ01", "TST-ENV01", "TST-QST01", "TST-MRG03", "TST-CHK01"].map((id) => [id, group(id)])),
      {
        "TST-FX001": "agent",
        "TST-DEP01": "dependencies",
        "TST-ST001": "not_here",
        "TST-HMN01": "check",
        "TST-0PS01": "person",
        "TST-REQ01": "decision",
        "TST-ENV01": "qa_environment",
        "TST-QST01": "decision",
        "TST-MRG03": "merged",
        "TST-CHK01": "agent",
      },
    );
    const row = (id: string) => read.tasks.find((t) => t.id === id)!;
    assert.match(row("TST-REQ01").reason, /owner: pick the grace period \(checked 2026-11-20\)/);
    assert.equal(row("TST-FX001").checked, "", "nobody checked it: said, not assumed");
    assert.equal(row("TST-CHK01").checked, "2026-11-24: brief and access checked");
    assert.match(row("TST-FX001").start_with, /per-task pick|profile/);
    assert.match(read.note, /Read only: nothing started or moved/);
    assert.match(read.note, /an empty overlap is not a check/);
    assert.equal(read.counts.agent, 4, "the seed's TST-TASK1 and TST-TASK2 too");
    // The board's order, unchanged: orders are distinct and the read journaled nothing.
    assert.equal(new Set(read.tasks.map((t) => t.order)).size, read.tasks.length);
    assert.equal(s.sync().journalEntries.length, journal, "a read writes nothing");
    assert.equal(s.dashboard.runs?.runs.size ?? 0, 0, "a read starts nothing");
    // One group alone.
    const only = await startCandidates(s.ctx, { group: "agent", limit: 50 });
    assert.deepEqual(only.tasks.map((t) => t.id).sort(), ["TST-CHK01", "TST-FX001", "TST-TASK1", "TST-TASK2"]);
  } finally {
    s.stop();
  }
});

test("requirements and a readiness check are written through update_task, with their day", async () => {
  const s = await setup();
  try {
    const set = await updateTask(s.ctx, { task: "TST-FX001", requires: [{ kind: "environment", reason: "stage with payments on" }], readiness_note: "access to stage confirmed" });
    assert.equal(set.ok, true, set.error);
    const t = s.task("TST-FX001")!;
    assert.deepEqual(t.requires, [{ kind: "environment", reason: "stage with payments on", checked: "2026-10-26" }]);
    assert.equal(t.readiness_note, "access to stage confirmed");
    assert.equal(t.readiness_checked?.slice(0, 10), "2026-10-26");
    const read = await startCandidates(s.ctx, { limit: 20 });
    assert.equal(read.tasks.find((r) => r.id === "TST-FX001")?.group, "qa_environment");
    const cleared = await updateTask(s.ctx, { task: "TST-FX001", requires: [], readiness_note: "" });
    assert.equal(cleared.ok, true, cleared.error);
    assert.deepEqual([s.task("TST-FX001")!.requires, s.task("TST-FX001")!.readiness_note], [[], undefined]);
  } finally {
    s.stop();
  }
});

test("this Mac's places: at work, launching, free and the limit, apart from stopped runs", async () => {
  const s = await setup();
  try {
    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const at = await startCandidates(s.ctx, { limit: 20 });
    const max = s.dashboard.autopilot!.read().max_running;
    assert.deepEqual([at.slots.max, at.slots.active, at.slots.free], [max, 1, max - 1]);
    s.dashboard.runs!.setActivity(run, "stopped", new Date().toISOString());
    const stopped = await startCandidates(s.ctx, { limit: 20 });
    assert.deepEqual([stopped.slots.active, stopped.slots.stopped, stopped.slots.free], [0, 1, max], "a stopped run holds no place, and is counted apart");
  } finally {
    s.stop();
  }
});
