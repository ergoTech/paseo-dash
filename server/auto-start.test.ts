import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./api/testing.ts";
import { createTask } from "./api/writes.ts";
import { readAutopilot, setAutopilot } from "./queue.ts";
import { settled } from "./runner/testing.ts";
import { openQuestion } from "./auto-start.ts";
import { runSettingsText } from "./runner/run-settings.ts";
import { reportedSettings } from "./tracker/tracker.ts";
import { taskView } from "./views.ts";
import { writeGodModeSettings } from "./godmode-settings.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The model's default effort is Medium, as Claude Opus 5.5 declares it; this Mac's default is High. */
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const PASEO = { profiles: [], providers: ["claude"], models: { claude: [{ id: "claude-default", isDefault: true, thinkingOptions: EFFORTS, defaultThinkingOptionId: "medium" }] } };

type Setup = Awaited<ReturnType<typeof setup>>;

const configs = (s: Setup) => [...s.fake.agents.values()].map((a) => a.request.config as Record<string, unknown>);
const flagOf = (s: Setup, task: string) => readAutopilot(s.ctx).flags.find((f) => f.task === task);
const ready = (s: Setup, extra: Partial<Parameters<typeof createTask>[1]> = {}) =>
  createTask(s.ctx, { space: "TST", title: "Ship the report", project: "core", brief: "Write the weekly report.", ...extra }, "dashboard");

/**
 * Space defaults written to space.yaml by a collaborator and fetched: a create re-reads the plan, so
 * an edit of the loaded plan in memory would not last.
 */
async function spaceDefaults(s: Setup, lines: string) {
  s.f.external("ergo", (root) => {
    const path = join(root, "space.yaml");
    writeFileSync(path, `${readFileSync(path, "utf8").replace(/^defaults:.*\n(?:[ \t]+.*\n)*/m, "")}defaults:\n${lines}`);
  });
  await s.sync().sync();
}

/** The task's run has its agent (the claim lands in the plan just before the run is recorded). */
const launched = (s: Setup, task: string) => settled(() => (s.dashboard.runs!.byTask(task)?.activity ?? "launching") !== "launching");

test("a ready task created in Paseo Dash starts once, in Auto with effort High passed explicitly, and the task screen says so", async () => {
  const s = await setup(PASEO);
  try {
    const created = await ready(s);
    assert.equal(created.ok, true, created.error);
    assert.equal(created.start, "queued");
    assert.match(created.start_note, /starts once in Auto mode \(auto, this Mac's default\), effort High \(high, this Mac's default\)/);
    await launched(s, created.id);
    assert.equal(s.task(created.id)?.status, "in_progress");
    assert.deepEqual(
      configs(s).map((c) => [c.modeId, c.thinkingOptionId]),
      [["auto", "high"]],
      "High is passed to the agent, not the model's Medium",
    );
    assert.equal(taskView(s.dashboard, { task: created.id }).run?.settings, "Started in Auto mode (auto, this Mac's default) · effort High (high, this Mac's default)");
    // Another pass starts nothing more: the flag was spent by the start.
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.equal(s.fake.agents.size, 1);
    assert.equal(flagOf(s, created.id), undefined);
  } finally {
    s.stop();
  }
});

test("To Do only, a blocker, an open question or a person's work start no agent and set no flag", async () => {
  const s = await setup(PASEO);
  try {
    const todo = await ready(s, { start: false });
    assert.deepEqual([todo.start, todo.status], ["todo_only", "todo"]);
    const blocked = await ready(s, { title: "After the report", depends_on: ["TST-TASK1"] });
    assert.equal(blocked.start, "waits");
    assert.match(blocked.start_note, /waits for other tasks/);
    const asking = await ready(s, { title: "Pick a chart", brief: "Draw the chart.\n\n### Open questions\n- Bars or lines?" });
    assert.equal(asking.start, "waits");
    assert.match(asking.start_note, /open question \(Bars or lines\?\)/);
    await spaceDefaults(s, "  human_labels: [manual]\n");
    const manual = await ready(s, { title: "Call the client", labels: ["manual"] });
    assert.equal(manual.start, "waits");
    assert.match(manual.start_note, /a person's work/);
    const draft = await createTask(s.ctx, { space: "TST", title: "An idea" }, "dashboard");
    assert.deepEqual([draft.status, draft.start], ["inbox", ""]);
    // This Mac's switch off: a new task stays in To Do unless its start is asked for.
    setAutopilot(s.ctx, { start_new_tasks: false });
    const off = await ready(s, { title: "Tidy up" });
    assert.equal(off.start, "todo_only");
    assert.match(off.start_note, /Start new ready tasks/);

    await s.dashboard.autopilot!.pass(s.ctx);
    assert.deepEqual(readAutopilot(s.ctx).flags, []);
    assert.equal(s.fake.agents.size, 0, "no agent started");
    for (const id of [todo.id, blocked.id, asking.id, manual.id, off.id]) assert.equal(s.task(id)?.status, "todo", id);
  } finally {
    s.stop();
  }
});

test("a full limit queues the new task with its state shown; it starts once a slot is free", async () => {
  const s = await setup(PASEO);
  // The run's state is set by hand; the tracker's own pass would read it from Paseo.
  s.dashboard.tracker.stop();
  try {
    setAutopilot(s.ctx, { max_running: 1 });
    const first = await ready(s, { title: "First" });
    await launched(s, first.id);
    const created = await ready(s);
    assert.equal(created.start, "queued");
    assert.match(created.start_note, /all 1 slots are in use, so it waits in the queue and starts once one is free/);
    await s.dashboard.autopilot!.pass(s.ctx);
    assert.equal(s.task(created.id)?.status, "todo");
    assert.equal(flagOf(s, created.id)?.state, `waits: 1 runs of this Mac are at work (the autopilot's limit is 1): ${first.id}`);
    // The first agent stops: the next pass (after each sync) starts the queued task.
    const run = s.dashboard.runs!.byTask(first.id)!;
    s.dashboard.runs!.setActivity(run, "stopped", new Date().toISOString());
    await s.dashboard.autopilot!.pass(s.ctx);
    await launched(s, created.id);
    assert.equal(s.task(created.id)?.status, "in_progress");
    assert.equal(s.fake.agents.size, 2);
  } finally {
    s.stop();
  }
});

test("an explicit effort wins over this Mac's default: the profile's, or a new default for later starts", async () => {
  const s = await setup({ ...PASEO, profiles: [{ id: "p1", name: "Quick", provider: "claude", model: "claude-default", thinkingOptionId: "low" }] });
  try {
    await spaceDefaults(s, "  agent_profile: Quick\n");
    const quick = await ready(s);
    assert.match(quick.start_note, /effort Low \(low, the profile's\)/);
    await launched(s, quick.id);
    assert.equal(configs(s)[0]!.thinkingOptionId, "low");
    assert.match(taskView(s.dashboard, { task: quick.id }).run?.settings ?? "", /effort Low \(low, the profile's\)$/);

    await spaceDefaults(s, "  priority: medium\n");
    setAutopilot(s.ctx, { start_effort: "medium" });
    const later = await ready(s, { title: "Later" });
    assert.match(later.start_note, /effort Medium \(medium, this Mac's default\)/);
    await launched(s, later.id);
    assert.equal(configs(s)[1]!.thinkingOptionId, "medium");
  } finally {
    s.stop();
  }
});

test("a task ChatGPT creates starts only while starts without asking are on; else the answer names start_task", async () => {
  const s = await setup(PASEO);
  try {
    const asked = await createTask(s.ctx, { space: "TST", title: "From the chat", project: "core", brief: "Do it." });
    assert.equal(asked.start, "asks_first");
    assert.match(asked.start_note, new RegExp(`Call start_task with task ${asked.id} now`));
    assert.equal(flagOf(s, asked.id), undefined);

    assert.equal(writeGodModeSettings(s.dashboard, { start_without_asking: true }).ok, true);
    const queued = await createTask(s.ctx, { space: "TST", title: "From the chat, at once", project: "core", brief: "Do it now." });
    assert.equal(queued.start, "queued");
    await launched(s, queued.id);
    assert.deepEqual(configs(s).map((c) => [c.modeId, c.thinkingOptionId]), [["auto", "high"]]);
    assert.equal(s.task(asked.id)?.status, "todo", "the read-back one did not start");
  } finally {
    s.stop();
  }
});

test("an open question is a non-empty entry under an Open questions heading or line, in English or Ukrainian", () => {
  assert.equal(openQuestion("Do it.\n\n## Open questions\n- Which API?\n\n## Notes\nx"), "Which API?");
  assert.equal(openQuestion("Open questions: keep the old API?"), "keep the old API?");
  assert.equal(openQuestion("### Відкриті питання\n\n* Чи потрібен експорт?"), "Чи потрібен експорт?");
  assert.equal(openQuestion("### Open questions\n- None.\n### Plan\n- step"), "");
  assert.equal(openQuestion("Open questions: немає"), "");
  assert.equal(openQuestion("Answer the user's open questions in the FAQ."), "", "words in a sentence are no heading");
  // Reported in review: none of these lists an open question.
  assert.equal(openQuestion("Open questions: none.\n\nImplement X by doing Y."), "");
  assert.equal(openQuestion("**Open questions:** none\n**Notes:** foo"), "");
  assert.equal(openQuestion("Open questions are tracked in JOBBY-1; see there."), "");
  assert.equal(openQuestion("## Open questions\n\n- [x] resolved: keep the API\n\nDo the work."), "");
  assert.equal(openQuestion("**Open questions**\n- [ ] Which region?\n\nDo the work."), "Which region?");
  assert.equal(openQuestion("Open questions:\n- Which region?\nNotes: none"), "Which region?");
  // A question with a colon is still a question, not the next labeled part.
  assert.equal(openQuestion("## Open questions\n\nWhich API: REST or gRPC?"), "Which API: REST or gRPC?");
  assert.equal(openQuestion("## Open questions\n- **Auth:** which provider?"), "Auth: which provider?");
});

test("the task screen says what Paseo reports when the agent runs with another mode or effort than the start passed", () => {
  const asked = { modeId: "auto", mode: "Auto mode (auto, this Mac's default)", effortId: "high", effort: "High (high, this Mac's default)" };
  assert.equal(runSettingsText({ asked, reported: { modeId: "auto", effortId: "high" } }), "Started in Auto mode (auto, this Mac's default) · effort High (high, this Mac's default)");
  assert.equal(
    runSettingsText({ asked, reported: { modeId: "auto", effortId: "medium" } }),
    "Started in Auto mode (auto, this Mac's default) · effort High (high, this Mac's default). Paseo now reports the agent in effort medium",
  );
  assert.equal(runSettingsText({ reported: { modeId: "default" } }), "Paseo reports mode default");
  assert.equal(runSettingsText({}), "");
  assert.deepEqual(reportedSettings({ currentModeId: "auto", thinkingOptionId: "medium", effectiveThinkingOptionId: "high" }), { modeId: "auto", effortId: "high" });
  assert.equal(reportedSettings({ currentModeId: null }), undefined);
});
