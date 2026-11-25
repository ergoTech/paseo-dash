import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTask, getTaskWithRuns, startCheck, uiStartCheck } from "../api/reads.ts";
import { listEvents } from "../events.ts";
import { setup } from "../api/testing.ts";
import { startTask } from "../api/writes.ts";
import { Dashboard } from "../dashboard.ts";
import { readOverview } from "../overview.ts";
import { pickWorkspace } from "./runner.ts";
import { spaceSchema } from "../../shared/model.ts";
import type { RunRecord } from "./runs.ts";
import { FakePaseo, settled } from "./testing.ts";

/** Commits a live run of TST-FX001 by hand, as another start of this machine would have. */
function holdTask(s: Awaited<ReturnType<typeof setup>>, runId: string): void {
  s.f.external("ergo", (root) => {
    const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
    const live = `run_id: ${runId}\nrun_by: ergo\nrun_host: ergo-mbp\nrun_branch: feat/login\nrun_started: 2026-10-26T08:00:00Z\n`;
    writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", `status: in_progress\n${live}`));
  });
}

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default", thinkingOptionId: "low", featureValues: { fast_mode: false } };

test("a start claims, then creates the worktree and the agent with the run's labels, prompt and profile", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "review" });
    assert.equal(started.ok, true, started.error);
    assert.deepEqual([started.state, started.workspace], ["launching", "TST-FX001 · Fix flaky login test"]);
    const runId = s.task("TST-FX001")!.run_id!;
    const run = s.dashboard.runs!.runs.get(runId)!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);

    const [workspace] = [...s.fake.workspaces.values()];
    assert.deepEqual(workspace!.request, {
      title: "TST-FX001 · Fix flaky login test",
      source: { kind: "worktree", projectId: "prj_core", action: "branch-off", branchName: "feat/login", baseBranch: "main" },
    });
    const [agent] = [...s.fake.agents.values()];
    assert.equal(agent!.workspaceId, workspace!.id);
    assert.deepEqual(agent!.labels, { dashboard: "1", "dashboard.space": "TST", "dashboard.task": "TST-FX001", "dashboard.run": runId });
    assert.equal(agent!.request.title, "TST-FX001 · Fix flaky login test");
    const { mcpServers, toolPolicy, ...settings } = agent!.request.config as Record<string, unknown>;
    assert.deepEqual(settings, { provider: "claude/claude-haiku-5-5", modeId: "default", thinkingOptionId: "low", featureValues: { fast_mode: false } });
    const server = (mcpServers as Record<string, { type: string; command: string; args: string[]; env: Record<string, string>; alwaysLoad: boolean }>).dashboard!;
    assert.deepEqual([server.type, server.command, server.args, server.alwaysLoad], ["stdio", process.execPath, [s.dashboard.bridge!.scriptPath], true]);
    assert.deepEqual(Object.keys(server.env).sort(), ["DASHBOARD_SOCKET", "DASHBOARD_TOKEN", "ELECTRON_RUN_AS_NODE"]);
    assert.equal(server.env.DASHBOARD_TOKEN, run.token);
    assert.deepEqual(toolPolicy, { preapproved: [{ kind: "mcp", server: "dashboard", tool: "task_brief" }, { kind: "mcp", server: "dashboard", tool: "task_report" }] });
    const prompt = String(agent!.request.prompt);
    assert.match(prompt, /^The user asked you to implement this task, not only to plan it\./);
    assert.match(prompt, /on branch feat\/login \(based on main\)/);
    assert.match(prompt, /## Brief\n\nDo it\./);
    assert.match(prompt, /- \[x\] first\n- \[ \] second/);
    assert.match(prompt, /You have two tools from the "dashboard" MCP server/);
    assert.equal((agent!.timeline[0] as { kind: string }).kind, "started");

    const read = getTask(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([read.activity, read.chat_id], ["working on this Mac", agent!.id]);
    const overview = readOverview(s.dashboard, {});
    assert.deepEqual(overview.running.find((r) => r.task === "TST-FX001"), { task: "TST-FX001", title: "Fix flaky login test", activity: "working", state: "working", host: "ergo-mbp", chat_id: agent!.id, since: s.task("TST-FX001")!.run_started });
    assert.deepEqual(readOverview(s.dashboard, { limit: 1 }).running.length, 1, "a screen may ask for more or fewer than ten");
    assert.equal(overview.counts.running, 2, "anna's live run counts too");
  } finally {
    s.stop();
  }
});

test("profiles: an asked one must exist here; without any, this Mac's first provider", async () => {
  const s = await setup({ profiles: [PROFILE], providers: ["claude-work", "codex"] });
  try {
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Implementation" })).error, /no agent profile «Implementation» on this Mac; profiles: Review/);
    assert.equal((await startCheck(s.ctx, { task: "TST-FX001" })).profile, "claude-work with its defaults (this Mac's); model claude-work-default (the provider's default)");
  } finally {
    s.stop();
  }
});

test("a workspace that Paseo put on another branch fails the start with both names and creates no agent", async () => {
  const s = await setup({ profiles: [PROFILE], actualBranch: (b) => `${b}-1` });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "failed");
    assert.match(run.error ?? "", /on branch feat\/login-1 instead of feat\/login/);
    assert.equal(s.fake.agents.size, 0);
    assert.deepEqual(s.fake.archived, [[...s.fake.workspaces.keys()][0]], "the stray workspace was archived");
    assert.match(run.error ?? "", /it was archived.*the extra branch feat\/login-1 stays/);
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).activity, /^failed on this Mac: Paseo made the workspace on branch feat\/login-1/);
    assert.match(run.error ?? "", /Its claim is being released back to todo so the task can be started again\.$/);
    await settled(() => Boolean(s.task("TST-FX001")?.run_ended));
    assert.deepEqual([s.task("TST-FX001")!.status, s.task("TST-FX001")!.run_id], ["todo", run.run_id], "nothing runs under it, so it is not held");
    assert.deepEqual(listEvents(s.dashboard, {}).events.map((e) => [e.kind, e.task_id, e.unread]), [["failed", "TST-FX001", true]], "its failure stays news");
    await s.sync().sync();
    const history = await getTaskWithRuns(s.ctx, { task: "TST-FX001" });
    assert.match(history.runs[0]!.result, /^released back to todo after a failed start: Paseo made the workspace on branch feat\/login-1/);
  } finally {
    s.stop();
  }
});

test("a new workspace starts on the branch Paseo's creation answer names, though later reads do not have it yet", async () => {
  // Paseo 0.13.2 fills a read's gitRuntime only once its git watcher has looked at the new worktree;
  // JOBBY-048BG was archived as "(unknown)" while the creation answer named the right branch.
  const s = await setup({ profiles: [PROFILE], gitUnknownReads: "never" });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);
    assert.deepEqual([s.fake.agents.size, s.fake.archived], [1, []]);
  } finally {
    s.stop();
  }
});

test("a workspace creation that fails releases the task; a run whose agent was asked for keeps its claim", async () => {
  const s = await setup({ profiles: [PROFILE], failAfterCreate: { workspace: 1 }, gitUnknownReads: "never" });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "failed");
    assert.match(run.error ?? "", /^Creating the workspace on feat\/login failed: workspace creation outcome unknown\. A workspace Paseo may have made for it stays in Paseo\. Its claim is being released/);
    await settled(() => s.task("TST-FX001")?.status === "todo");
  } finally {
    s.stop();
  }
  // Paseo refuses the agent and none with the run's label turns up; one asked for may still appear.
  const t = await setup({ profiles: [PROFILE], agentError: "provider unavailable" });
  try {
    await startTask(t.ctx, { task: "TST-FX001", profile: "Review" });
    const run = t.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "failed");
    assert.doesNotMatch(run.error ?? "", /released/);
    await t.sync().sync();
    assert.equal(t.task("TST-FX001")!.status, "in_progress");
  } finally {
    t.stop();
  }
});

test("an agent made although its creation reported a failure is adopted, not made twice", async () => {
  const s = await setup({ profiles: [PROFILE], failAfterCreate: { agent: 1 } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);
    assert.equal(s.fake.agents.size, 1);
    assert.equal(run.agentId, [...s.fake.agents.keys()][0]);
  } finally {
    s.stop();
  }
});

test("after a restart an unfinished start resends its stored requests with the same key and makes nothing twice", async () => {
  const s = await setup({ profiles: [PROFILE] });
  const dataDir = s.dashboard.dataDir;
  holdTask(s, "r-crash");
  await s.sync().sync();
  const fake = new FakePaseo({ profiles: [PROFILE] });
  const request = { title: "core:feat/login", source: { kind: "worktree", projectId: "prj_core", action: "branch-off", branchName: "feat/login" } };
  // Before the crash the workspace was made, but its answer was lost.
  await fake.api().workspaces.create({ ...request, idempotencyKey: "dashboard:r-crash:1" } as never);
  s.stop();
  writeCrashedRun(dataDir, request);
  const restarted = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000, starts: { branchCheckDelayMs: 1 } });
  restarted.attach(fake.api());
  try {
    await restarted.start();
    const run = restarted.runs!.runs.get("r-crash")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);
    assert.equal(fake.workspaces.size, 1, "the same key returned the workspace made before the crash");
    assert.equal(fake.agents.size, 1);
  } finally {
    restarted.stop();
  }
});

test("a space's start template is used, with unknown placeholders left as written", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    s.f.external("ergo", (root) => {
      mkdirSync(join(root, "templates"));
      writeFileSync(join(root, "templates", "start-prompt.md"), "Custom for {{id}} on {{branch}}.\n\n{{brief}}\n\n{{unknown}}\n");
    });
    await s.sync().sync();
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const prompt = String([...s.fake.agents.values()][0]!.request.prompt);
    assert.equal(prompt, "Custom for TST-FX001 on feat/login.\n\nDo it.\n\n{{unknown}}\n");
  } finally {
    s.stop();
  }
});

test("a profile without a model, and this Mac's default, run with the provider's default model", async () => {
  const s = await setup({ profiles: [{ id: "p2", name: "Free", provider: "codex", modeId: "auto-review" }], providers: ["claude-work"] });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "free" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const config = [...s.fake.agents.values()][0]!.request.config as Record<string, unknown>;
    assert.deepEqual([config.provider, config.modeId], ["codex/codex-default", "auto-review"]);
  } finally {
    s.stop();
  }
});

test("without a profile mode a start passes the provider's declared default mode, and none when it declares none", async () => {
  const modeOf = async (options: Parameters<typeof setup>[0], profile?: string) => {
    const s = await setup(options);
    try {
      const check = await startCheck(s.ctx, { task: "TST-FX001", profile });
      await startTask(s.ctx, { task: "TST-FX001", profile });
      const run = s.dashboard.runs!.byTask("TST-FX001")!;
      await settled(() => run.activity !== "launching");
      const config = [...s.fake.agents.values()][0]!.request.config as Record<string, unknown>;
      // start_check says the effort after the mode: only the mode here.
      return { provider: config.provider, modeId: config.modeId, said: check.mode.split("; effort ")[0] };
    } finally {
      s.stop();
    }
  };
  // Claude declares auto, Codex auto-review (the fake's snapshot); Codex's own "auto" is another mode.
  // This Mac's default mode (auto, Claude's) comes before the provider's default.
  assert.deepEqual(await modeOf({ providers: ["claude"] }), { provider: "claude/claude-default", modeId: "auto", said: "Auto mode (auto, this Mac's default)" });
  assert.deepEqual(await modeOf({ profiles: [{ id: "p2", name: "Free", provider: "codex" }], providers: ["claude"] }, "Free"), {
    provider: "codex/codex-default",
    modeId: "auto-review",
    said: "Auto-review (auto-review, the provider's default)",
  });
  // A profile's own mode wins over the provider's default.
  assert.deepEqual(await modeOf({ profiles: [{ id: "p3", name: "Asking", provider: "claude", modeId: "default" }], providers: ["claude"] }, "Asking"), {
    provider: "claude/claude-default",
    modeId: "default",
    said: "Always Ask (default, the profile's); it stops for the user's approval, so the agent waits for the user",
  });
  // No declared default, or no snapshot: nothing is passed and Paseo decides, as before; a Mac default the provider does not list is said.
  assert.deepEqual(await modeOf({ providers: ["claude"], modes: { claude: { defaultModeId: null } } }), {
    provider: "claude/claude-default",
    modeId: undefined,
    said: "the provider's own; claude declares no default mode; this Mac's default «auto» is not one of claude's modes",
  });
  const loading = await modeOf({ providers: ["claude"], modes: { claude: { status: "loading" } } });
  assert.deepEqual([loading.modeId, loading.said], [undefined, "the provider's own; Paseo is still loading claude's modes; this Mac's default «auto» is not one of claude's modes"]);
  const failed = await modeOf({ providers: ["claude"], modes: "fail" });
  assert.deepEqual([failed.modeId, failed.said], [undefined, "the provider's own; its modes could not be read: providers snapshot unavailable; this Mac's default «auto» is not used unchecked"]);
});

test("the mode a person picks wins, then the profile's, then the space's where the provider has it, then this Mac's, then the provider's", async () => {
  const s = await setup({ profiles: [{ id: "p2", name: "Free", provider: "codex" }], providers: ["claude"] });
  try {
    const space = s.sync().plan.space!;
    const offered = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(offered.error, "");
    assert.deepEqual([offered.mode_id, offered.mode_asks], ["auto", false]);
    assert.deepEqual(offered.modes, [
      { id: "plan", label: "Plan Mode", asks: true },
      { id: "default", label: "Always Ask", asks: true },
      { id: "auto", label: "Auto mode", asks: false },
    ]);

    // The space asks for Always Ask: the confirmation says the agent will wait.
    space.defaults.mode = "default";
    const asking = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([asking.mode_id, asking.mode_asks], ["default", true]);
    assert.equal(asking.mode, "Always Ask (default, the space's); it stops for the user's approval, so the agent waits for the user");
    // A mode the provider does not have falls through to its default, and says why.
    space.defaults.mode = "auto-review";
    const notClaudes = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([notClaudes.mode_id, notClaudes.mode], ["auto", "Auto mode (auto, this Mac's default); the space's «auto-review» is not one of claude's modes"]);
    const codex = await uiStartCheck(s.ctx, { task: "TST-FX001", profile: "Free", anyway: false });
    assert.deepEqual([codex.mode_id, codex.mode], ["auto-review", "Auto-review (auto-review, the space's)"], "the same space mode is Codex's");

    // A pick overrides the space; one the provider does not list is refused, not guessed.
    space.defaults.mode = "default";
    const picked = await uiStartCheck(s.ctx, { task: "TST-FX001", mode: "auto", anyway: false });
    assert.deepEqual([picked.mode_id, picked.mode_asks, picked.mode], ["auto", false, "Auto mode (auto, picked)"]);
    const unknown = await uiStartCheck(s.ctx, { task: "TST-FX001", mode: "yolo", anyway: false });
    assert.match(unknown.error, /claude has no mode «yolo»; its modes: plan, default, auto/);

    // The start passes the picked mode to the agent.
    const started = await startTask(s.ctx, { task: "TST-FX001" }, { mode: "auto" });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(([...s.fake.agents.values()][0]!.request.config as Record<string, unknown>).modeId, "auto");
  } finally {
    s.stop();
  }
});

test("a space mode that skips permission prompts is not used; a person can still pick it, and an unread snapshot passes a pick as it is", async () => {
  const modes = {
    claude: {
      defaultModeId: "auto",
      modes: [
        { id: "default", label: "Always Ask", colorTier: "safe" },
        { id: "auto", label: "Auto mode", colorTier: "moderate" },
        { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
      ],
    },
  };
  const s = await setup({ providers: ["claude"], modes });
  try {
    s.sync().plan.space!.defaults.mode = "bypassPermissions";
    const fromSpace = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual(
      [fromSpace.mode_id, fromSpace.mode],
      ["auto", "Auto mode (auto, this Mac's default); the space's «bypassPermissions» is not used, as it skips permission prompts: pick it here to use it"],
    );
    // Nor as this Mac's default: the provider's default then, saying so.
    s.sync().plan.space!.defaults.mode = undefined;
    s.dashboard.autopilot!.setStartDefaults({ mode: "bypassPermissions", mode_provider: "claude" });
    const fromMac = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual(
      [fromMac.mode_id, fromMac.mode],
      ["auto", "Auto mode (auto, the provider's default); this Mac's default «bypassPermissions» is not used, as it skips permission prompts: pick it at the start to use it"],
    );
    const picked = await uiStartCheck(s.ctx, { task: "TST-FX001", mode: "bypassPermissions", anyway: false });
    assert.deepEqual([picked.mode_id, picked.mode], ["bypassPermissions", "Bypass (bypassPermissions, picked)"]);
  } finally {
    s.stop();
  }
  const unread = await setup({ providers: ["claude"], modes: "fail" });
  try {
    const check = await uiStartCheck(unread.ctx, { task: "TST-FX001", mode: "auto", anyway: false });
    assert.deepEqual([check.mode_id, check.mode, check.modes, check.mode_asks], ["auto", "auto (picked)", [], false], "nothing to check it against: passed as picked, no chips");
  } finally {
    unread.stop();
  }
});

test("the effort a person picks wins, then the profile's, then this Mac's where the model has it, then the model's declared default, and the start passes it", async () => {
  const efforts = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
  const s = await setup({
    profiles: [{ id: "p1", name: "Deep", provider: "claude", thinkingOptionId: "high" }],
    providers: ["claude"],
    models: { claude: [{ id: "claude-default", isDefault: true, thinkingOptions: efforts, defaultThinkingOptionId: "medium" }] },
  });
  try {
    const offered = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(offered.error, "");
    // This Mac's default (high) is passed explicitly instead of the model's medium.
    assert.deepEqual([offered.effort_id, offered.effort, offered.efforts], ["high", "High (high, this Mac's default)", efforts]);
    const profile = await uiStartCheck(s.ctx, { task: "TST-FX001", profile: "Deep", anyway: false });
    assert.deepEqual([profile.effort_id, profile.effort], ["high", "High (high, the profile's)"]);
    const picked = await uiStartCheck(s.ctx, { task: "TST-FX001", profile: "Deep", effort: "low", anyway: false });
    assert.deepEqual([picked.effort_id, picked.effort], ["low", "Low (low, picked)"]);
    const unknown = await uiStartCheck(s.ctx, { task: "TST-FX001", effort: "turbo", anyway: false });
    assert.match(unknown.error, /claude-default has no effort «turbo»; its efforts: low, medium, high/);
    // A Mac default the model lacks falls to the model's default and says so: never a silent swap.
    s.dashboard.autopilot!.setStartDefaults({ effort: "max" });
    const lacking = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([lacking.effort_id, lacking.effort], ["medium", "Medium (medium, the model's default); this Mac's default «max» is not one of claude-default's efforts"]);
    // A new default counts for the next start.
    s.dashboard.autopilot!.setStartDefaults({ effort: "low" });
    assert.equal((await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false })).effort, "Low (low, this Mac's default)");

    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Deep" }, { effort: "low" });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(([...s.fake.agents.values()][0]!.request.config as Record<string, unknown>).thinkingOptionId, "low");
  } finally {
    s.stop();
  }
});

test("without declared efforts nothing is passed; an unread model list passes a picked or the profile's effort as it is", async () => {
  const plain = await setup({ providers: ["claude"] });
  try {
    const check = await uiStartCheck(plain.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual([check.effort_id, check.effort, check.efforts], ["", "the provider's own; claude-default declares no default effort; this Mac's default «high» is not one of claude-default's efforts", []]);
    assert.equal((await startTask(plain.ctx, { task: "TST-FX001" })).ok, true);
    const run = plain.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal("thinkingOptionId" in ([...plain.fake.agents.values()][0]!.request.config as Record<string, unknown>), false);
  } finally {
    plain.stop();
  }
  const unread = await setup({
    profiles: [
      { id: "p1", name: "Deep", provider: "claude", model: "claude-opus", thinkingOptionId: "high" },
      { id: "p2", name: "Plain", provider: "claude", model: "claude-opus" },
    ],
    providers: ["claude"],
    models: "fail",
  });
  try {
    const profile = await uiStartCheck(unread.ctx, { task: "TST-FX001", profile: "Deep", anyway: false });
    assert.deepEqual([profile.error, profile.effort_id, profile.effort, profile.efforts], ["", "high", "high (the profile's)", []]);
    const picked = await uiStartCheck(unread.ctx, { task: "TST-FX001", profile: "Deep", effort: "max", anyway: false });
    assert.deepEqual([picked.effort_id, picked.effort], ["max", "max (picked)"]);
    const none = await uiStartCheck(unread.ctx, { task: "TST-FX001", profile: "Plain", anyway: false });
    assert.deepEqual([none.error, none.effort_id, none.effort], ["", "", "the provider's own; its models could not be read: models unavailable; this Mac's default «high» is not used unchecked"]);
  } finally {
    unread.stop();
  }
});

test("space.yaml's defaults.mode: a short text is kept, anything else reads as none without failing the space", () => {
  const space = (mode: unknown) => spaceSchema.safeParse({ schema: "paseo-dashboard/1", key: "TST", name: "T", projects: {}, defaults: { mode } });
  assert.equal(space("auto").data?.defaults.mode, "auto");
  const without = spaceSchema.safeParse({ schema: "paseo-dashboard/1", key: "TST", name: "T", projects: {}, defaults: { priority: "medium" } });
  assert.deepEqual([without.success, without.data?.defaults.mode], [true, undefined], "no mode key: the space still reads");
  assert.equal(spaceSchema.safeParse({ schema: "paseo-dashboard/1", key: "TST", name: "T", projects: {} }).success, true);
  for (const odd of [5, true, ["auto"], "x".repeat(101), "   ", null]) {
    const parsed = space(odd);
    assert.equal(parsed.success, true, JSON.stringify(odd));
    assert.equal(parsed.data?.defaults.mode, undefined, JSON.stringify(odd));
  }
});

function writeCrashedRun(dataDir: string, request: Record<string, unknown>, workspaceId?: string): void {
  writeFileSync(
    join(dataDir, "runs.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          run_id: "r-crash",
          space: "TST",
          task: "TST-FX001",
          project: "core",
          projectId: "prj_core",
          branch: "feat/login",
          started: "2026-10-26T08:00:00Z",
          attempts: [
            { n: 1, key: "dashboard:r-crash:1", workspaceRequest: request, agentRequest: { title: "T", prompt: "P", labels: { "dashboard.run": "r-crash" }, config: { provider: "claude" } }, state: "workspace", ...(workspaceId ? { workspaceId } : {}) },
          ],
          ...(workspaceId ? { workspaceId } : {}),
          activity: "launching",
          activityAt: "2026-10-26T08:00:00Z",
        },
      ],
    }),
  );
}

test("after a restart a recorded workspace's branch is read again until Paseo reports it; never reported, the start is released", async () => {
  const request = { title: "core:feat/login", source: { kind: "worktree", projectId: "prj_core", action: "branch-off", branchName: "feat/login" } };
  for (const unknownReads of [2, "never"] as const) {
    const s = await setup({ profiles: [PROFILE] });
    const dataDir = s.dashboard.dataDir;
    holdTask(s, "r-crash");
    await s.sync().sync();
    // The workspace was made and recorded before the crash; its creation answer is gone.
    const fake = new FakePaseo({ profiles: [PROFILE], gitUnknownReads: unknownReads });
    const made = await fake.api().workspaces.create({ ...request, idempotencyKey: "dashboard:r-crash:1" } as never);
    s.stop();
    writeCrashedRun(dataDir, request, made.id);
    const restarted = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000, starts: { branchCheckDelayMs: 1 } });
    restarted.attach(fake.api());
    try {
      await restarted.start();
      const run = restarted.runs!.runs.get("r-crash")!;
      await settled(() => run.activity !== "launching");
      if (unknownReads === 2) {
        assert.equal(run.activity, "working", run.error);
        assert.deepEqual([fake.agents.size, fake.archived], [1, []]);
        continue;
      }
      assert.equal(run.activity, "failed");
      assert.equal(run.error, `Paseo did not report which branch workspace ${made.id} is on, so nothing was started and it was archived. Its claim is being released back to todo so the task can be started again.`);
      assert.deepEqual([fake.agents.size, fake.archived], [0, [made.id]]);
      const task = () => restarted.spaces.get("TST")!.sync.plan.entities.get("TST-FX001")!.entity as { status: string; run_ended?: string };
      await settled(() => Boolean(task().run_ended));
      assert.equal(task().status, "todo");
    } finally {
      restarted.stop();
    }
  }
});

test("a start resumed after a restart stops when the plan no longer holds its run", async () => {
  const s = await setup({ profiles: [PROFILE] });
  const dataDir = s.dashboard.dataDir;
  s.stop();
  writeCrashedRun(dataDir, { title: "core:feat/login", source: { kind: "worktree", projectId: "prj_core", action: "branch-off", branchName: "feat/login" } });
  const fake = new FakePaseo({ profiles: [PROFILE] });
  const restarted = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000, starts: { branchCheckDelayMs: 1 } });
  restarted.attach(fake.api());
  try {
    await restarted.start();
    const run = restarted.runs!.runs.get("r-crash")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "failed");
    assert.match(run.error ?? "", /no longer held by this run/);
    assert.deepEqual([fake.workspaces.size, fake.agents.size], [0, 0]);
  } finally {
    restarted.stop();
  }
});

test("a workspace whose creation stayed unclear is found by project, title, branch and time, and adopted", async () => {
  const s = await setup({ profiles: [PROFILE], failAfterCreate: { workspace: 1 } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);
    assert.equal(s.fake.workspaces.size, 1);
    assert.deepEqual(s.fake.calls.filter((c) => c.kind === "workspace").map((c) => c.key), [`dashboard:${run.run_id}:1`, `dashboard:${run.run_id}:1`], "asked again once with the same key");
    assert.equal(run.workspaceId, [...s.fake.workspaces.keys()][0]);
  } finally {
    s.stop();
  }
});

test("a start whose claim was undecided waits, then launches when the claim is won and drops it when lost", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const input = {
      space: "TST",
      task: "TST-FX001",
      title: "T",
      project: "core",
      projectId: "prj_core",
      branch: "feat/login",
      base: undefined,
      prompt: "P",
      settings: { provider: "claude/claude-haiku-5-5", label: "Review", mode: "", modes: [], asks: false, effort: "", efforts: [], modelId: "claude-haiku-5-5", model: "", models: [], profiles: [] },
      started: "2026-10-26T08:00:00Z",
    };
    holdTask(s, "r-won");
    await s.sync().sync();
    const won = s.dashboard.starts!.launch({ ...input, run_id: "r-won" }, "undecided");
    const lost = s.dashboard.starts!.launch({ ...input, run_id: "r-lost" }, "undecided");
    await settled(() => false, 50);
    assert.equal(s.fake.workspaces.size, 0, "nothing is created while undecided");
    s.dashboard.starts!.claimDecided("r-won", true);
    s.dashboard.starts!.claimDecided("r-lost", false);
    await settled(() => won.activity !== "launching");
    assert.equal(won.activity, "working", won.error);
    assert.equal(lost.activity, "failed");
    assert.match(lost.error ?? "", /did not land/);
    assert.equal(s.fake.agents.size, 1);
  } finally {
    s.stop();
  }
});

test("a task's or space's profile missing on this Mac is skipped to this Mac's default, and said so", async () => {
  const s = await setup({ profiles: [PROFILE], providers: ["claude-work"] });
  try {
    s.f.external("ergo", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", "status: todo\nagent_profile: Ghost\n"));
    });
    await s.sync().sync();
    assert.equal((await startCheck(s.ctx, { task: "TST-FX001" })).profile, "claude-work with its defaults (this Mac's; «Ghost» not on this Mac); model claude-work-default (the provider's default)");
  } finally {
    s.stop();
  }
});

test("an unclear workspace is adopted only when exactly one fits: project, title, branch, newer than the run, nobody else's", () => {
  const run = { run_id: "r1", project: "core", projectId: "prj_core", branch: "feat/login", started: "2026-10-26T10:00:00Z" } as RunRecord;
  const ours = { id: "w1", projectId: "prj_core", title: "core:feat/login", createdAt: "2026-10-26T10:00:05Z", archivingAt: null, gitRuntime: { currentBranch: "feat/login" } };
  assert.equal(pickWorkspace([ours], run, new Set()), "w1");
  assert.equal(pickWorkspace([ours, { ...ours, id: "w2" }], run, new Set()), undefined, "two candidates");
  assert.equal(pickWorkspace([{ ...ours, createdAt: "2026-10-26T09:59:00Z" }], run, new Set()), undefined, "older than the run");
  assert.equal(pickWorkspace([ours], run, new Set(["w1"])), undefined, "another run's");
  assert.equal(pickWorkspace([{ ...ours, title: "core:other" }], run, new Set()), undefined, "another title");
  assert.equal(pickWorkspace([{ ...ours, gitRuntime: { currentBranch: "feat/login-1" } }], run, new Set()), undefined, "another branch");
  assert.equal(pickWorkspace([{ ...ours, archivingAt: "x" }], run, new Set()), undefined, "being archived");
  assert.equal(pickWorkspace([{ ...ours, createdAt: null }], run, new Set()), undefined, "no creation time: never adopted");
});

test("an unclear workspace is looked for by the title the run asked for; a run recorded before that by <project>:<branch>", () => {
  const legacy = { run_id: "r1", project: "core", projectId: "prj_core", branch: "feat/login", started: "2026-10-26T10:00:00Z" } as RunRecord;
  const run = { ...legacy, attempts: [{ n: 1, key: "dashboard:r1:1", workspaceRequest: { title: "TST-FX001 · Fix flaky login test" }, agentRequest: {}, state: "workspace" }] } as RunRecord;
  const ours = { id: "w1", projectId: "prj_core", title: "TST-FX001 · Fix flaky login test", createdAt: "2026-10-26T10:00:05Z", archivingAt: null, gitRuntime: { currentBranch: "feat/login" } };
  assert.equal(pickWorkspace([ours], run, new Set()), "w1");
  assert.equal(pickWorkspace([{ ...ours, title: "core:feat/login" }], run, new Set()), undefined, "the old title is not the asked one");
  assert.equal(pickWorkspace([{ ...ours, title: "core:feat/login" }], legacy, new Set()), "w1", "a run recorded before");
  assert.equal(pickWorkspace([ours], legacy, new Set()), undefined);
  const before = { ...run, attempts: [{ ...run.attempts[0]!, workspaceRequest: { title: "core:feat/login" } }] } as RunRecord;
  assert.equal(pickWorkspace([{ ...ours, title: "core:feat/login" }], before, new Set()), "w1", "a run recorded before, as stored on disk");
  const padded = { ...run, attempts: [{ ...run.attempts[0]!, workspaceRequest: { title: " TST-FX001 · Fix flaky login test " } }] } as RunRecord;
  assert.equal(pickWorkspace([ours], padded, new Set()), "w1", "Paseo keeps the title trimmed");
});
