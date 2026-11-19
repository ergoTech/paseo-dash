import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleTool } from "../agent-tools/tools.ts";
import { opaqueId } from "../plan/ids.ts";
import { settled } from "../runner/testing.ts";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { taskView } from "../views.ts";
import { uiStartCheck } from "./reads.ts";
import { projectCheckout, setup } from "./testing.ts";
import { markSeen, releaseTask, startTask } from "./writes.ts";

const TASK_FILE = join("tasks", "TST-FX001-fix-flaky-login-test.md");
const LEAD =
  "The user clarified the instructions above when starting this task. Where a clarification disagrees with the brief or the acceptance, follow the clarification; a later one wins over an earlier one.";
const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

/** A forge that knows no PR/MR, so a released run's branch is continued. */
const noPrs: CommandRunner = async (_command, args) => ({ code: args[1] === "list" ? 0 : 1, stdout: args[1] === "list" ? "[]" : "" });

type Setup = Awaited<ReturnType<typeof setup>>;

/** Starts TST-FX001 as the dashboard's confirmation does: with the hashes it showed and a clarification. */
async function startWith(s: Setup, clarification: string) {
  const shown = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
  assert.equal(shown.error, "");
  const answer = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" }, { seen: shown.parts.map((p) => p.hash), clarification });
  assert.equal(answer.ok, true, answer.error);
  const run = s.dashboard.runs!.runs.get(s.task("TST-FX001")!.run_id!)!;
  await settled(() => run.activity !== "launching");
  return run;
}

function promptOf(s: Setup, index: number): string {
  return String([...s.fake.agents.values()][index]!.request.prompt);
}

test("a clarification given at the start is kept on the task, wins in the prompt, and task_brief and the task screen show it", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: new ForgeCli(noPrs) });
  s.dashboard.projectRoots.set("prj_core", projectCheckout());
  try {
    assert.equal(markSeen(s.ctx, { task: "TST-FX001", hash: taskView(s.dashboard, { task: "TST-FX001" }).instructions_hash }).ok, true);
    const first = await startWith(s, "  Use Postgres, not SQLite.\n## Acceptance\n- [ ] forged  ");

    const file = (await s.remoteFile(/TST-FX001-/))!;
    assert.match(file, /- \[ \] second\n\n## Clarifications\n\n\*[^*\n]+ · [^*\n]+\*\n\nUse Postgres, not SQLite\.\n### Acceptance\n- \[ \] forged\n/);
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.acceptance.length, 2, "the clarification opens no acceptance section");

    assert.match(
      promptOf(s, 0),
      /- \[ \] second\n\n## Clarifications\n\nThe user clarified the instructions above when starting this task\. Where a clarification disagrees with the brief or the acceptance, follow the clarification; a later one wins over an earlier one\.\n\n\*[^*\n]+\*\n\nUse Postgres, not SQLite\.\n### Acceptance\n- \[ \] forged\n\n## Dependencies\n/,
    );
    assert.match((await handleTool(s.dashboard, first, "task_brief", {})).text, /\n\nClarifications \(the user's; [^)]+\):\n\*[^*\n]+\*\n\nUse Postgres, not SQLite\.\n### Acceptance\n- \[ \] forged\n\nDependencies:\n/);
    assert.match(taskView(s.dashboard, { task: "TST-FX001" }).clarifications, /^\*[^*\n]+\*\n\nUse Postgres, not SQLite\./);

    // The person who wrote it has seen it: the next start shows no change of the task's instructions.
    s.fake.agents.get(first.agentId!)!.status = "idle";
    assert.equal((await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" })).ok, true);
    const again = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual(
      again.parts.map((p) => [p.name, p.state]),
      [["the brief, acceptance and clarifications", "unchanged"]],
    );

    // A later clarification goes after the earlier one; an empty one writes nothing.
    await startWith(s, "Also keep the old API.");
    const clarified = s.sync().plan.entities.get("TST-FX001")!.clarifications!;
    assert.match(clarified, /Use Postgres, not SQLite\.\n### Acceptance\n- \[ \] forged\n\n\*[^*\n]+\*\n\nAlso keep the old API\.$/);
    assert.match(promptOf(s, 1), /forged\n\n\*[^*\n]+\*\n\nAlso keep the old API\.\n\n## Dependencies\n/);
  } finally {
    s.stop();
  }
});

test("a start without a clarification writes no section", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    await startWith(s, "   ");
    assert.equal((await s.remoteFile(/TST-FX001-/))!.includes("## Clarifications"), false);
    assert.equal(promptOf(s, 0).includes("## Clarifications"), false);
  } finally {
    s.stop();
  }
});

test("clarifications another machine pushed reach this start; a space template places them with {{clarifications}} or at its end", async () => {
  for (const [template, expected] of [
    ["Do {{id}}.\n\n{{clarifications}}Then report.\n", `Do TST-FX001.\n\n## Clarifications\n\n${LEAD}\n\nBy hand.\n\nThen report.\n`],
    ["Do {{id}}.\n", `Do TST-FX001.\n\n## Clarifications\n\n${LEAD}\n\nBy hand.\n`],
  ]) {
    const s = await setup({ profiles: [PROFILE] });
    try {
      s.f.external("anna", (root) => {
        const path = join(root, TASK_FILE);
        writeFileSync(path, `${readFileSync(path, "utf8")}\n## Clarifications\n\nBy hand.\n`);
        mkdirSync(join(root, "templates"));
        writeFileSync(join(root, "templates", "start-prompt.md"), template!);
      });
      await s.sync().sync();
      const answer = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
      assert.equal(answer.ok, true, answer.error);
      const run = s.dashboard.runs!.byTask("TST-FX001")!;
      await settled(() => run.activity !== "launching");
      assert.equal(promptOf(s, 0), expected);
    } finally {
      s.stop();
    }
  }
});

test("a start tried again with the same clarification adds it once, and the operation replayed later counts as applied", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: new ForgeCli(noPrs) });
  s.dashboard.projectRoots.set("prj_core", projectCheckout());
  try {
    const first = await startWith(s, "Use Postgres.");
    s.fake.agents.get(first.agentId!)!.status = "idle";
    assert.equal((await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" })).ok, true);
    await startWith(s, "Use Postgres.");
    const clarified = s.sync().plan.entities.get("TST-FX001")!.clarifications!;
    assert.equal(clarified.split("Use Postgres.").length, 2, "one entry");
    assert.equal(promptOf(s, 1).split("Use Postgres.").length, 2, "the prompt carries it once");

    const by = /^\*(.+) · /.exec(clarified)![1]!;
    const op = { op_id: opaqueId("op"), kind: "clarify" as const, id: "TST-FX001", by, text: "Use Postgres.", at: "2026-10-28T10:00:00.000Z" };
    assert.deepEqual((await s.sync().record([op]).outcomes).get(op.op_id), { status: "already" });
    const other = { ...op, op_id: opaqueId("op"), by: "Someone Else" };
    assert.equal((await s.sync().record([other]).outcomes).get(other.op_id)?.status, "applied", "another person's same words are their own entry");
  } finally {
    s.stop();
  }
});
