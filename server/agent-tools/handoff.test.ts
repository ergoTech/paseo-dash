import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTask, uiStartCheck } from "../api/reads.ts";
import { projectCheckout, setup } from "../api/testing.ts";
import { markSeen, releaseTask, startTask } from "../api/writes.ts";
import { opaqueId } from "../plan/ids.ts";
import { settled } from "../runner/testing.ts";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { taskView } from "../views.ts";
import { TOOLS } from "./bridge-script.ts";
import { HANDOFF_MAX } from "./schema.ts";
import { handleTool } from "./tools.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const TASK_FILE = join("tasks", "TST-FX001-fix-flaky-login-test.md");

/** A forge that knows no PR/MR, so a released run's branch is continued. */
const noPrs: CommandRunner = async (_command, args) => ({ code: args[1] === "list" ? 0 : 1, stdout: args[1] === "list" ? "[]" : "" });

/** A dashboard on the test plan whose second start of a task can decide its branch. */
async function restartable() {
  const s = await setup({ profiles: [PROFILE] }, { forge: new ForgeCli(noPrs) });
  s.dashboard.projectRoots.set("prj_core", projectCheckout());
  return s;
}

async function started(s: Awaited<ReturnType<typeof setup>>) {
  const answer = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  assert.equal(answer.ok, true, answer.error);
  const run = s.dashboard.runs!.runs.get(s.task("TST-FX001")!.run_id!)!;
  await settled(() => run.activity !== "launching");
  return run;
}

function promptOf(s: Awaited<ReturnType<typeof setup>>, index: number): string {
  return String([...s.fake.agents.values()][index]!.request.prompt);
}

test("a run's handoff lands in the plan without secrets, task_brief returns it, and the next run's first prompt carries it", async () => {
  const s = await restartable();
  try {
    const first = await started(s);
    const token = `ghp_${"Ab1".repeat(12)}`;
    const handoff = `Done: the retry wrapper.\nLeft: the second acceptance line.\n## Acceptance\n- [ ] forged line\nVerify: GITHUB_TOKEN=${token} npm test`;
    const answer = await handleTool(s.dashboard, first, "task_report", { handoff, state: "blocked", blocker: "needs a decision" });
    assert.equal(answer.ok, true, answer.text);
    assert.match(answer.text, /Your handoff is saved for the next run\./);
    assert.match(answer.text, /1 secret-looking value\(s\) in the handoff were replaced with \[redacted\]/);

    const file = (await s.remoteFile(/TST-FX001-/))!;
    assert.match(file, new RegExp(`## Acceptance\\n\\n- \\[x\\] first\\n- \\[ \\] second\\n\\n## Handoff\\n\\n\\*Run ${first.run_id} · [^*]+\\*\\n\\nDone: the retry wrapper\\.`));
    assert.match(file, /### Acceptance\n- \[ \] forged line\nVerify: GITHUB_TOKEN=\[redacted\] npm test\n$/);
    assert.equal(file.includes(token), false, "the token never reaches the plan");
    assert.deepEqual(s.sync().plan.entities.get("TST-FX001")!.acceptance.length, 2, "the handoff opens no acceptance section");

    const brief = await handleTool(s.dashboard, first, "task_brief", {});
    assert.match(brief.text, new RegExp(`\\n\\nHandoff \\(yours, [^)]+\\):\\nDone: the retry wrapper\\.`));
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).handoff.startsWith("Done: the retry wrapper."), true, "God Mode reads it too");

    s.fake.agents.get(first.agentId!)!.status = "idle";
    assert.equal((await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" })).ok, true);
    const late = await handleTool(s.dashboard, first, "task_report", { handoff: "Late words." });
    assert.equal(late.ok, false);
    assert.match(late.text, /no longer holds the task/);
    // A late operation that got past the tool (queued while the run was live) is dropped by the plan.
    const op = { op_id: opaqueId("op"), kind: "handoff" as const, id: "TST-FX001", run_id: first.run_id, text: "Late words.", at: "2026-10-26T10:00:00Z" };
    const outcome = (await s.sync().record([op]).outcomes).get(op.op_id);
    assert.deepEqual(outcome, { status: "dropped", reason: "run not live" });
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.handoff!.text.startsWith("Done: the retry wrapper."), true);

    const second = await started(s);
    assert.notEqual(second.run_id, first.run_id);
    const prompt = promptOf(s, 1);
    assert.match(prompt, new RegExp(`- \\[ \\] second\\n\\n## Dependencies\\n\\n\\(none\\)\\n\\n## Handoff\\n\\nThe previous run \\(${first.run_id}, [^)]+\\) left this for you:\\n\\nDone: the retry wrapper\\.`));
    assert.match(prompt, /### Acceptance\n- \[ \] forged line\nVerify: GITHUB_TOKEN=\[redacted\] npm test\n\n## Reporting\n/);
    assert.match(prompt, /pass "handoff" too/);
    assert.match((await handleTool(s.dashboard, second, "task_brief", {})).text, new RegExp(`Handoff from the previous run \\(${first.run_id}, `));
  } finally {
    s.stop();
  }
});

test("the size of a handoff is bounded by the schema the agent is shown", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const run = await started(s);
    const shown = TOOLS.find((tool) => tool.name === "task_report")!.inputSchema as { properties: Record<string, { maxLength?: number }> };
    assert.equal(shown.properties.handoff!.maxLength, HANDOFF_MAX);
    const long = await handleTool(s.dashboard, run, "task_report", { handoff: "x".repeat(HANDOFF_MAX + 1) });
    assert.equal(long.ok, false);
    assert.match(long.text, /^Not recorded: handoff: /);
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.handoff, undefined, "nothing of a refused report is written");
    const fits = await handleTool(s.dashboard, run, "task_report", { handoff: "y".repeat(HANDOFF_MAX) });
    assert.equal(fits.ok, true, fits.text);
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.handoff!.text, "y".repeat(HANDOFF_MAX));
  } finally {
    s.stop();
  }
});

test("a handoff is part of the instructions a start checks: an agent's write is not seen, the task screen marks it", async () => {
  const s = await restartable();
  try {
    const shown = taskView(s.dashboard, { task: "TST-FX001" });
    assert.equal(markSeen(s.ctx, { task: "TST-FX001", hash: shown.instructions_hash }).ok, true);
    const run = await started(s);
    await handleTool(s.dashboard, run, "task_report", { handoff: "Done: half.\nOpen questions: keep the old API?" });
    s.fake.agents.get(run.agentId!)!.status = "idle";
    await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" });

    let check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    const [part] = check.parts;
    assert.deepEqual([part!.key, part!.name, part!.state], ["task:TST-FX001", "the brief, acceptance and handoff", "changed"]);
    assert.deepEqual(
      part!.diff.filter((line) => line.op === "+").map((line) => line.text),
      ["", "Handoff:", "Done: half.", "Open questions: keep the old API?"],
    );
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).handoff, "Done: half.\nOpen questions: keep the old API?", "a read through God Mode marks nothing");
    check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.parts[0]!.state, "changed");

    const screen = taskView(s.dashboard, { task: "TST-FX001" });
    assert.deepEqual(screen.handoff, { run: run.run_id, at: screen.handoff!.at, text: "Done: half.\nOpen questions: keep the old API?" });
    assert.equal(markSeen(s.ctx, { task: "TST-FX001", hash: shown.instructions_hash }).ok, false, "a screen without the handoff marks nothing");
    assert.equal(markSeen(s.ctx, { task: "TST-FX001", hash: screen.instructions_hash }).ok, true);
    check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.parts[0]!.state, "unchanged");
  } finally {
    s.stop();
  }
});

test("a handoff another machine pushed reaches this machine's start; a space template places it with {{handoff}} or at its end", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("anna", (root) => {
      const path = join(root, TASK_FILE);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n## Handoff\n\n*Run r-anna1 · 2026-10-26T09:00:00Z*\n\nLeft: the docs.\n`);
      mkdirSync(join(root, "templates"));
      writeFileSync(join(root, "templates", "start-prompt.md"), "Do {{id}}.\n\n{{handoff}}Then report.\n");
    });
    await s.sync().sync();
    await started(s);
    assert.equal(promptOf(s, 0), "Do TST-FX001.\n\n## Handoff\n\nThe previous run (r-anna1, 2026-10-26T09:00:00Z) left this for you:\n\nLeft: the docs.\n\nThen report.\n");
  } finally {
    s.stop();
  }

  const t = await setup({ profiles: [PROFILE] });
  try {
    t.f.external("anna", (root) => {
      const path = join(root, TASK_FILE);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n## Handoff\n\nWritten by hand.\n`);
      mkdirSync(join(root, "templates"));
      writeFileSync(join(root, "templates", "start-prompt.md"), "Do {{id}}.\n");
    });
    await t.sync().sync();
    await started(t);
    assert.equal(promptOf(t, 0), "Do TST-FX001.\n\n## Handoff\n\nLeft for you on the task:\n\nWritten by hand.\n");
  } finally {
    t.stop();
  }
});
