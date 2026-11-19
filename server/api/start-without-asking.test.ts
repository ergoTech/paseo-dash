import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeGodModeSettings } from "../godmode-settings.ts";
import { settled } from "../runner/testing.ts";
import { startCheck } from "./reads.ts";
import { setup } from "./testing.ts";
import { createTask, startTask } from "./writes.ts";

/**
 * tasks.start as God Mode calls it while this machine lets ChatGPT start without asking
 * (06-god-mode.md, Starting without asking): the fixed `without_asking` flag, checked by the handler.
 */

async function ready(on: boolean) {
  const s = await setup();
  if (on) assert.equal(writeGodModeSettings(s.dashboard, { start_without_asking: true }).ok, true);
  return s;
}

const agentModes = (s: Awaited<ReturnType<typeof setup>>) =>
  [...s.fake.agents.values()].map((a) => (a.request as { config?: { modeId?: string } }).config?.modeId);

test("with the switch off, a start without asking is refused and nothing starts", async () => {
  const s = await ready(false);
  try {
    const refused = await startTask(s.ctx, { task: "TST-FX001", without_asking: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /without asking is off on this Mac/);
    assert.equal(refused.mode, "");
    assert.equal(s.task("TST-FX001")?.status, "todo");
    assert.equal(s.dashboard.runs!.byTask("TST-FX001"), undefined);
    // God Mode's asking path, which sends no flag, still starts once the user said yes.
    const asked = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(asked.ok, true, asked.error);
  } finally {
    s.stop();
  }
});

test("with the switch on, a start runs once, in the mode start_check names, and a repeat starts nothing", async () => {
  const s = await ready(true);
  try {
    const check = await startCheck(s.ctx, { task: "TST-FX001" });
    assert.equal(check.error, "");
    // The effort follows the mode: God Mode shows at most 8 fields of a read-back.
    assert.equal(check.mode, "Auto mode (auto, this Mac's default); effort the provider's own; claude-default declares no default effort; this Mac's default «high» is not one of claude-default's efforts");
    const started = await startTask(s.ctx, { task: "TST-FX001", without_asking: true });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.state, "launching");
    assert.equal(`${started.mode}; effort ${started.effort}`, check.mode, "the answer says the mode and effort the agent is created with");
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.deepEqual(agentModes(s), ["auto"], "the agent was created in auto mode");

    const again = await startTask(s.ctx, { task: "TST-FX001", without_asking: true });
    assert.equal(again.ok, false);
    assert.match(again.error, /already started by/);
    assert.equal(s.fake.agents.size, 1, "no second agent");
    assert.equal(s.dashboard.runs!.runs.size, 1, "no second run");
  } finally {
    s.stop();
  }
});

test("with the switch on, blocked and held tasks are refused as when asking", async () => {
  const s = await ready(true);
  try {
    const blocked = await startTask(s.ctx, { task: "TST-DEP01", without_asking: true });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /blocked by TST-TASK1/);
    const held = await startTask(s.ctx, { task: "TST-RD002", without_asking: true });
    assert.equal(held.ok, false);
    assert.match(held.error, /already started by anna on anna-mbp/);
    assert.equal(s.dashboard.runs!.runs.size, 0);
  } finally {
    s.stop();
  }
});

test("with the switch on, instructions another person wrote are not refused: the answer says what the confirmation would have", async () => {
  const s = await ready(true);
  try {
    s.f.external("anna", (root) => {
      mkdirSync(join(root, "templates"), { recursive: true });
      writeFileSync(join(root, "templates", "start-prompt.md"), "Work on {{id}}.\n");
    });
    await s.sync().sync();
    const check = await startCheck(s.ctx, { task: "TST-FX001" });
    assert.match(check.instructions, /the space's start template: not seen by you yet \(per git: anna\)/);
    const started = await startTask(s.ctx, { task: "TST-FX001", without_asking: true });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.instructions, check.instructions, "said after the start, since nothing asked before it");
  } finally {
    s.stop();
  }
});

test("with the switch on, creating a task starts nothing, and starting it is one more request", async () => {
  const s = await ready(true);
  try {
    const created = await createTask(s.ctx, { title: "Fresh one", project: "core", brief: "Do the fresh thing." });
    assert.equal(created.ok, true, created.error);
    assert.equal(created.status, "todo");
    assert.equal(s.dashboard.runs!.runs.size, 0, "creating a task starts nothing");
    assert.equal(s.fake.calls.filter((c) => c.kind.startsWith("workspace") || c.kind.startsWith("agent")).length, 0);
    const started = await startTask(s.ctx, { task: created.id, without_asking: true });
    assert.equal(started.ok, true, started.error);
    assert.equal(s.dashboard.runs!.runs.size, 1);
  } finally {
    s.stop();
  }
});
