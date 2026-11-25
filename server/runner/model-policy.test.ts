import { test } from "node:test";
import assert from "node:assert/strict";
import { startCheck, uiStartCheck } from "../api/reads.ts";
import { setup } from "../api/testing.ts";
import { startPlan } from "../api/start-set.ts";
import { createTask, startTask } from "../api/writes.ts";
import { setAutopilot } from "../queue.ts";
import { pickForTask, type TaskSignals } from "./model-policy.ts";
import { runSettingsText } from "./run-settings.ts";
import { settled } from "./testing.ts";

const task = (over: Partial<TaskSignals>): TaskSignals => ({ title: "Fix the date label", brief: "The label shows UTC; show local time.", acceptance: ["shows local time", "test covers it"], labels: [], ...over });

test("risk words count in the title and labels only, not as a path, a code span or after a negation", () => {
  // Briefs cite their sources: none of this is the work itself.
  const cited = pickForTask(task({ brief: "Per the research of ERG-X and `05-architecture.md`, with no DB migrations. A security review follows.".repeat(3) }));
  assert.equal(cited.tier, "clear", cited.reason);
  for (const title of ["Update docs/design/05-architecture.md links", "Bump `security-headers.conf`", "Ship it without a migration", "Без міграції: нова колонка"]) {
    assert.equal(pickForTask(task({ title })).tier, "clear", title);
  }
});

test("the policy: a clear local task gets Sonnet 5.5 medium, a bigger one Sonnet 5.5 high, an uncertain or risky one Opus 5.5 high", () => {
  const clear = pickForTask(task({}));
  assert.deepEqual([clear.tier, clear.model, clear.effort], ["clear", "claude-sonnet-5-5", "medium"]);
  assert.equal(clear.reason, "2 acceptance lines, a short brief, nothing uncertain or risky named");

  const bigger = pickForTask(task({ acceptance: ["a", "b", "c", "d", "e"] }));
  assert.deepEqual([bigger.tier, bigger.model, bigger.effort], ["localized", "claude-sonnet-5-5", "high"]);
  assert.match(bigger.reason, /^5 acceptance lines/);
  assert.equal(pickForTask(task({ brief: "x".repeat(1200) })).tier, "localized", "a longer brief");
  assert.equal(pickForTask(task({ brief: "y ".repeat(5000) })).tier, "localized", "a long, detailed brief is clearer, not riskier");

  for (const [over, why] of [
    [{ acceptance: [] }, /no acceptance criteria/],
    [{ brief: "Move the plan store.\n\n## Open questions\n\n- which branch?" }, /an open question/],
    [{ title: "Rework the sync architecture" }, /its title or labels name architecture/],
    [{ title: "Зміни в двох репозиторіях: плагін і God Mode" }, /more than one repository/],
    [{ title: "Дослідити, де обирається модель" }, /research/],
    [{ title: "Спайк: токени рану" }, /research/],
    [{ title: "Міграція даних" }, /a migration/],
    [{ labels: ["security-audit"] }, /security, an audit/],
    [{ labels: ["area/security"] }, /security/],
    [{ acceptance: ["1", "2", "3", "4", "5", "6", "7"] }, /7 acceptance lines/],
  ] as [Partial<TaskSignals>, RegExp][]) {
    const pick = pickForTask(task(over));
    assert.deepEqual([pick.tier, pick.model, pick.effort], ["complex", "claude-opus-5-5", "high"], JSON.stringify(over));
    assert.match(pick.reason, why);
  }
});

const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];
const CLAUDE = [
  { id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, thinkingOptions: EFFORTS, defaultThinkingOptionId: "high" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", thinkingOptions: EFFORTS, defaultThinkingOptionId: "medium" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", thinkingOptions: EFFORTS, defaultThinkingOptionId: "medium" },
];
const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "auto", thinkingOptionId: "low" };
const PASEO = { profiles: [PROFILE], providers: ["claude"], models: { claude: CLAUDE } };

type Setup = Awaited<ReturnType<typeof setup>>;

/** A todo task in core, kept in To Do so each test starts it itself. */
async function todo(s: Setup, title: string, brief: string, acceptance: string[]): Promise<string> {
  const created = await createTask(s.ctx, { space: "TST", title, project: "core", brief, acceptance, start: false }, "dashboard");
  assert.equal(created.ok, true, created.error);
  return created.id;
}

const config = (s: Setup) => [...s.fake.agents.values()].at(-1)!.request.config as Record<string, unknown>;

test("the confirmation, the start and God Mode's check pick the same model and effort per task, and say why", async () => {
  const s = await setup(PASEO);
  try {
    const clear = await todo(s, "Fix the date label", "The label shows UTC; show local time.", ["shows local time", "a test covers it"]);
    const risky = await todo(s, "Move auth to the new architecture", "Rework the auth flow.", ["it works", "tests"]);

    const check = await uiStartCheck(s.ctx, { task: clear, anyway: false });
    assert.equal(check.error, "");
    assert.deepEqual([check.model_id, check.effort_id], ["claude-sonnet-5-5", "medium"]);
    assert.equal(check.model, "Sonnet 5.5 (claude-sonnet-5-5, picked for the task: 2 acceptance lines, a short brief, nothing uncertain or risky named)");
    assert.equal(check.effort, "Medium (medium, picked for the task)");
    assert.deepEqual(
      check.models.map((m) => m.id),
      ["claude-sonnet-5-5", "claude-opus-5-5"],
      "the policy's models and the provider's default, not the whole catalogue",
    );
    assert.deepEqual(check.profiles, ["Review"]);
    assert.match((await startCheck(s.ctx, { task: risky })).profile, /^claude with its defaults \(this Mac's\); model Opus 5\.5 \(claude-opus-5-5, picked for the task: its title or labels name architecture\)$/);
    assert.match((await startCheck(s.ctx, { task: risky })).mode, /; effort High \(high, picked for the task\)$/);

    // The dashboard's start sends what the confirmation showed, as it always did for the effort.
    const started = await startTask(s.ctx, { task: clear }, { seen: check.parts.map((p) => p.hash), effort: check.effort_id, shown: { project: check.project, branch: check.branch, workspace: check.workspace, profile: check.profile, issue: check.issue } });
    assert.equal(started.ok, true, started.error);
    await settled(() => s.fake.agents.size === 1);
    assert.deepEqual([config(s).provider, config(s).thinkingOptionId], ["claude/claude-sonnet-5-5", "medium"]);
    const run = s.dashboard.runs!.byTask(clear)!;
    assert.equal(run.asked?.modelId, "claude-sonnet-5-5");
    assert.match(runSettingsText(run), /^Started on claude-sonnet-5-5 in /);

    // God Mode's start and the autopilot's go through the same planStart: no pick of their own.
    const godMode = await startTask(s.ctx, { task: risky });
    assert.equal(godMode.ok, true, godMode.error);
    await settled(() => s.fake.agents.size === 2);
    assert.deepEqual([config(s).provider, config(s).thinkingOptionId], ["claude/claude-opus-5-5", "high"]);
  } finally {
    s.stop();
  }
});

test("the autopilot starts a new ready task with the task's pick", async () => {
  const s = await setup(PASEO);
  try {
    const created = await createTask(s.ctx, { space: "TST", title: "Tidy the footer", project: "core", brief: "Align the footer links.", acceptance: ["aligned", "no other change", "screenshot", "test", "lint"] }, "dashboard");
    assert.equal(created.start, "queued", created.start_note);
    assert.match(created.start_note, /starts once on claude-sonnet-5-5 in .*effort High \(high, picked for the task\)/);
    await settled(() => s.fake.agents.size === 1);
    assert.deepEqual([config(s).provider, config(s).thinkingOptionId], ["claude/claude-sonnet-5-5", "high"]);
  } finally {
    s.stop();
  }
});

test("a person's pick wins: a model, an effort or a profile picked at the start", async () => {
  const s = await setup(PASEO);
  try {
    const id = await todo(s, "Fix the date label", "The label shows UTC; show local time.", ["shows local time"]);
    const opus = await uiStartCheck(s.ctx, { task: id, anyway: false, model: "claude-opus-5-5" });
    assert.deepEqual([opus.model, opus.effort_id], ["Opus 5.5 (claude-opus-5-5, picked)", "high"], "the model's own default effort, not the policy's for another model");
    assert.match(opus.effort, /this Mac's default/);
    const effort = await uiStartCheck(s.ctx, { task: id, anyway: false, effort: "max" });
    assert.deepEqual([effort.model_id, effort.effort], ["claude-sonnet-5-5", "Max (max, picked)"]);
    const profile = await uiStartCheck(s.ctx, { task: id, anyway: false, profile: "Review" });
    assert.deepEqual([profile.model, profile.effort_id], ["Haiku 5.5 (claude-haiku-5-5, the profile's)", "low"], "a profile names its own model and effort");
    assert.match((await uiStartCheck(s.ctx, { task: id, anyway: false, model: "claude-nope" })).error, /claude offers no model «claude-nope» on this Mac; its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5/);

    const started = await startTask(s.ctx, { task: id }, { model: "claude-opus-5-5", effort: "max" });
    assert.equal(started.ok, true, started.error);
    await settled(() => s.fake.agents.size === 1);
    assert.deepEqual([config(s).provider, config(s).thinkingOptionId], ["claude/claude-opus-5-5", "max"]);
  } finally {
    s.stop();
  }
});

test("a task's own profile keeps its model; one missing here falls to the pick, and so does an old task with no new field", async () => {
  const s = await setup(PASEO);
  try {
    // TST-FX001 was written before the policy: no field of it names a model or an effort.
    const old = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([old.error, old.model_id, old.effort_id], ["", "claude-sonnet-5-5", "medium"]);

    const id = await todo(s, "Fix the date label", "The label shows UTC; show local time.", ["shows local time"]);
    s.task(id)!.agent_profile = "Review";
    assert.equal((await uiStartCheck(s.ctx, { task: id, anyway: false })).model, "Haiku 5.5 (claude-haiku-5-5, the profile's)");
    s.task(id)!.agent_profile = "Gone";
    const missing = await startCheck(s.ctx, { task: id });
    assert.match(missing.profile, /^claude with its defaults \(this Mac's; «Gone» not on this Mac\); model Sonnet 5\.5 \(claude-sonnet-5-5, picked for the task: /);
  } finally {
    s.stop();
  }
});

test("a policy model this Mac does not offer leaves the provider's default and says so; off in Settings, starts are as before", async () => {
  const s = await setup({ ...PASEO, models: { claude: CLAUDE.filter((m) => m.id !== "claude-sonnet-5-5") } });
  try {
    const id = await todo(s, "Fix the date label", "The label shows UTC; show local time.", ["shows local time"]);
    const check = await uiStartCheck(s.ctx, { task: id, anyway: false });
    assert.equal(check.model, "Opus 5.5 (claude-opus-5-5, the provider's default); the task's pick claude-sonnet-5-5 is not offered on this Mac");
    assert.equal(check.effort, "High (high, this Mac's default)", "the efforts below the policy, as before it");

    assert.deepEqual(await setAutopilot(s.ctx, { start_auto_model: false }), { ok: true, error: "" });
    const off = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([off.model, off.effort], ["Opus 5.5 (claude-opus-5-5, the provider's default)", "High (high, this Mac's default)"]);
  } finally {
    s.stop();
  }
});

test("a run recorded before the model was kept reads as it did", () => {
  assert.equal(runSettingsText({ asked: { mode: "Auto mode (auto, this Mac's default)", effort: "High (high, this Mac's default)" } }), "Started in Auto mode (auto, this Mac's default) · effort High (high, this Mac's default)");
});

test("ChatGPT's read-back of a set keeps the mode, its warning and every task's model within 200 characters", async () => {
  const s = await setup(PASEO);
  try {
    // This Mac's mode waits for the user: the set's read-back must still say so after the per-task picks.
    assert.deepEqual(await setAutopilot(s.ctx, { start_mode: "default", start_mode_provider: "claude" }), { ok: true, error: "" });
    const clear = await todo(s, "Fix the date label", "The label shows UTC; show local time.", ["shows local time", "a test covers it"]);
    const risky = await todo(s, "Rework the sync architecture", "Move the sync to a queue.", ["it works", "tests"]);
    const plan = await startPlan(s.ctx, { tasks: [clear, risky] });
    assert.equal(plan.error, "");
    assert.ok(plan.agents.length <= 200, plan.agents);
    assert.equal(
      plan.agents,
      "claude with its defaults (this Mac's) in Always Ask (default, this Mac's default); it stops for the user's approval, so the agent waits for the user; claude-sonnet-5-5 medium, claude-opus-5-5 high",
    );
  } finally {
    s.stop();
  }
});
