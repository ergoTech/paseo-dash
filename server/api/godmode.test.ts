import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { describeDashboard, OPERATIONS } from "../capabilities.ts";
import { PLUGIN_NAME } from "../../shared/edition.ts";
import { readOverview } from "../overview.ts";
import { listEvents, markEventsRead } from "../events.ts";
import { readRecap } from "../recap.ts";
import { settled } from "../runner/testing.ts";
import { acceptCheck, sendBack, taskChecks } from "../result.ts";
import type { CommandRunner } from "../tracker/forge.ts";
import { getTaskWithRuns, listInbox, listTasks, planStart, readRoadmap, releaseCheck, startCheck } from "./reads.ts";
import { setup } from "./testing.ts";
import { readProfiles, readTaskText, updateTasks } from "./batch.ts";
import { reconcile } from "./reconcile.ts";
import { startCandidates } from "./candidates.ts";
import { readyReview } from "./ready-review.ts";
import { taskDelivery } from "../delivery.ts";
import { startPlan, startSet } from "./start-set.ts";
import { readAutopilot, setAutopilot } from "../queue.ts";
import { resumeCheck, resumeTask } from "../autopilot-resume.ts";
import { startWithoutAsking, writeGodModeSettings } from "../godmode-settings.ts";
import {
  addToInbox,
  createFeature,
  createMilestone,
  createTask,
  releaseTask,
  startTask,
  updateFeature,
  updateMilestone,
  updateTask,
  type WriteContext,
} from "./writes.ts";

/**
 * God Mode's own plugin_read and plugin_action code (gpt-site/core/paseo.mjs) driving the handlers
 * in process, through a stand-in for the daemon client: what ChatGPT gets, without the relay or the
 * pairing link. Needs GODMODE_CHECKOUT pointing at a God Mode checkout whose gpt-site can import
 * @getpaseo/protocol and @getpaseo/client (installed, or a node_modules link to this repository's).
 */

type GodMode = {
  pluginReadOn: (client: unknown, args: Record<string, unknown>) => Promise<{ text: string; data: Record<string, any> }>;
  pluginActionOn: (client: unknown, args: Record<string, unknown>) => Promise<{ text: string; data: Record<string, any> }>;
  resultLines?: (value: unknown, max?: number) => string;
};

async function godMode(): Promise<{ paseo?: GodMode; caps?: { resultLines: (v: unknown, max?: number) => string; projectResult: (op: unknown, out: unknown) => unknown; parseCapabilities: (raw: unknown) => any; pickPlugin: (entries: unknown[], query: string) => { match?: { id: string } } }; why?: string }> {
  const checkout = process.env.GODMODE_CHECKOUT;
  if (!checkout) return { why: "set GODMODE_CHECKOUT to a God Mode checkout (not the copy Paseo manages under ~/.paseo)" };
  try {
    const core = join(checkout, "gpt-site/core");
    const paseo = (await import(pathToFileURL(join(core, "paseo.mjs")).href)) as GodMode;
    const caps = await import(pathToFileURL(join(core, "capabilities.mjs")).href);
    return { paseo, caps };
  } catch (error) {
    return { why: `God Mode's paseo.mjs does not load (${(error as Error).message.split("\n")[0]}); give its gpt-site a node_modules` };
  }
}

/** The person opens the task: its instructions are seen as they are now. */
async function see(s: Awaited<ReturnType<typeof setup>>, task: string) {
  const plan = await planStart(s.ctx, { task });
  assert.ok("found" in plan, "error" in plan ? plan.error : "");
  for (const part of plan.parts) s.dashboard.seen!.mark("TST", part);
}

function client(ctx: WriteContext, forge: CommandRunner = async () => ({ code: 1, stdout: "" })) {
  const handlers: Record<string, (input: any) => unknown> = {
    // As index.server.ts does: the switch is read on every call.
    "meta.describe": () => describeDashboard(startWithoutAsking(ctx.dashboard.dataDir)),
    "dashboard.overview": (i) => readOverview(ctx.dashboard, i),
    "tasks.list": (i) => listTasks(ctx, i),
    "tasks.get": (i) => getTaskWithRuns(ctx, i),
    "roadmap.get": (i) => readRoadmap(ctx, i),
    "inbox.list": (i) => listInbox(ctx, i),
    "tasks.start-check": (i) => startCheck(ctx, i),
    "tasks.start-plan": (i) => startPlan(ctx, i),
    "tasks.start-set": (i) => startSet(ctx, i),
    "tasks.release-check": (i) => releaseCheck(ctx, i),
    "tasks.result": (i) => taskChecks(ctx, i, forge),
    "tasks.accept-check": (i) => acceptCheck(ctx, i, forge),
    "tasks.send-back": (i) => sendBack(ctx, ctx.dashboard.paseo!, i),
    "inbox.add": (i) => addToInbox(ctx, i),
    "tasks.create": (i) => createTask(ctx, i),
    "tasks.update": (i) => updateTask(ctx, i),
    "tasks.start": (i) => startTask(ctx, i),
    "tasks.release": (i) => releaseTask(ctx, i),
    "milestones.create": (i) => createMilestone(ctx, i),
    "milestones.update": (i) => updateMilestone(ctx, i),
    "features.create": (i) => createFeature(ctx, i),
    "features.update": (i) => updateFeature(ctx, i),
    "events.list": (i) => listEvents(ctx.dashboard, i),
    "events.seen": (i) => markEventsRead(ctx.dashboard, i),
    "plan.recap": (i) => readRecap(ctx.dashboard, i),
    "autopilot.read": () => readAutopilot(ctx),
    "autopilot.resume-check": (i) => resumeCheck(ctx, i),
    "autopilot.resume-task": (i) => resumeTask(ctx, i),
    "tasks.text": (i) => readTaskText(ctx, i),
    "tasks.delivery": (i) => taskDelivery(ctx, i),
    "tasks.reconcile": (i) => reconcile(ctx, i),
    "tasks.start-candidates": (i) => startCandidates(ctx, i),
    "tasks.ready-review": (i) => readyReview(ctx, i),
    "tasks.profiles": (i) => readProfiles(ctx, i),
    "tasks.update-many": (i) => updateTasks(ctx, i),
  };
  const contracts = new Map<string, PluginRpcContract>(OPERATIONS.map((op) => [op.contract.name, op.contract]));
  return {
    listPlugins: async () => [{ id: "dashboard", name: "Paseo Dash", status: "running" }],
    // As the daemon does: the contract parses the input and the answer.
    invokePluginRpc: async (_id: string, method: string, input: unknown) => {
      const contract = contracts.get(method);
      const parsed = contract ? contract.input.parse(input) : input;
      const output = await handlers[method]!(parsed);
      return contract ? contract.output.parse(output) : output;
    },
  };
}

test("God Mode drives the plugin: reads, a low-risk action twice, task events read and marked, starts and releases that ask first", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn, pluginActionOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  try {
    const catalog = await pluginReadOn(daemon, {});
    assert.ok(catalog.text.includes(`- ${PLUGIN_NAME} (dashboard): `), catalog.text);
    assert.equal(catalog.data.plugins[0].reads.length + catalog.data.plugins[0].actions.length, 36);
    assert.equal(catalog.data.plugins[0].skipped, undefined, "nothing dropped");

    const overview = await pluginReadOn(daemon, { plugin: "dashboard" });
    assert.equal(overview.data.operation, "overview");
    assert.equal(overview.data.untrusted, true);
    assert.equal(overview.data.result.counts.inbox, 0);

    // Why a task did not start while the user was away: the autopilot's flags and what each waits for.
    assert.equal(setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: true }).ok, true);
    await s.dashboard.autopilot!.pass(s.ctx);
    const autopilot = await pluginReadOn(daemon, { plugin: "dashboard", operation: "autopilot" });
    assert.equal(autopilot.data.untrusted, true);
    assert.deepEqual(
      autopilot.data.result.flags.map((f: Record<string, unknown>) => [f.task, f.paused]),
      [["TST-TASK1", false]],
    );
    assert.match(autopilot.data.result.flags[0].state, /open TST-TASK1 once/);
    setAutopilot(s.ctx, { space: "TST", task: "TST-TASK1", on: false });

    const add = { plugin: "dashboard", operation: "add_to_inbox", args: { items: [{ title: "probe draft" }] }, secret };
    const added = await pluginActionOn(daemon, add);
    assert.equal(added.data.outcome, "done", added.text);
    assert.equal(added.data.result.created.length, 1);
    const repeated = await pluginActionOn(daemon, add);
    assert.equal(repeated.data.outcome, "done");
    assert.deepEqual(repeated.data.result.skipped, ["probe draft"]);

    const start = { plugin: "dashboard", operation: "start_task", args: { task: "TST-FX001" }, secret };
    const asked = await pluginActionOn(daemon, start);
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    assert.deepEqual(Object.keys(asked.data.target).sort(), ["branch", "instructions", "issue", "mode", "profile", "project", "title", "workspace"]);
    assert.equal(asked.data.target.issue, "", "a task without an issue says nothing about one");
    assert.doesNotMatch(asked.data.confirm_text, /\{/, "every placeholder filled");
    assert.match(asked.data.confirm_text, /Start «Fix flaky login test» in core on branch feat\/login/);
    const ran = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(ran.data.outcome, "done", ran.text);
    assert.equal(s.task("TST-FX001")?.status, "in_progress");

    // The started task's agent asks for a permission: ChatGPT reads the event, then marks it told.
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.dashboard.runs!.setActivity(run, "needs_input", new Date().toISOString(), { waitingFor: "asks to run: npm test" });
    const events = await pluginReadOn(daemon, { plugin: "dashboard", operation: "events" });
    assert.equal(events.data.untrusted, true);
    assert.deepEqual(
      events.data.result.events.map((e: Record<string, unknown>) => [e.kind, e.task_id, e.chat_id, e.summary]),
      [["needs_input", "TST-FX001", run.agentId, "asks to run: npm test"]],
    );
    assert.match(events.text, /asks to run: npm test/);
    const through = events.data.result.events[0].id;
    const marked = await pluginActionOn(daemon, { plugin: "dashboard", operation: "mark_events_read", args: { through }, secret });
    assert.equal(marked.data.outcome, "done", marked.text);
    const again = await pluginReadOn(daemon, { plugin: "dashboard", operation: "events" });
    assert.deepEqual(again.data.result.events, []);

    // The task read carries its runs from the plan's history, with the chat of the agent on this Mac.
    await s.sync().sync();
    const read = await pluginReadOn(daemon, { plugin: "dashboard", operation: "task", args: { task: "TST-FX001" } });
    assert.equal(read.data.untrusted, true);
    assert.deepEqual(
      read.data.result.runs.map((r: Record<string, unknown>) => [r.run_id, r.host, r.result, r.chat_id]),
      [[run.run_id, "ergo-mbp", "holds the task now", run.agentId]],
    );
    assert.equal(read.data.result.runs_error, "");
    const held = await pluginReadOn(daemon, { plugin: "dashboard", operation: "task", args: { task: "TST-RD002" } });
    assert.deepEqual(
      held.data.result.runs.map((r: Record<string, unknown>) => [r.run_id, r.by, r.host, r.chat_id]),
      [["r-anna", "anna", "anna-mbp", ""]],
      "another machine's run has no chat here",
    );

    // The recap of the period has the start made above, from the plan's commits.
    const recap = await pluginReadOn(daemon, { plugin: "dashboard", operation: "recap", args: { since: new Date(Date.now() - 3_600_000).toISOString() } });
    assert.equal(recap.data.untrusted, true);
    assert.equal(recap.data.refused, undefined, recap.text);
    const startedEvent = recap.data.result.events.find((e: Record<string, unknown>) => e.kind === "started" && e.task_id === "TST-FX001");
    assert.ok(startedEvent, recap.text);
    assert.deepEqual(Object.keys(recap.data.result), ["since", "total", "counts", "more", "partial", "events"]);
    assert.match(recap.text, /^counts: \{.*"started":\d/m);
    const tooOld = await pluginReadOn(daemon, { plugin: "dashboard", operation: "recap", args: { since: "2020-01-01" } });
    assert.equal(tooOld.data.refused, true);
    assert.match(tooOld.data.reason, /more than 31 days ago/);
    const badKind = await pluginReadOn(daemon, { plugin: "dashboard", operation: "recap", args: { kinds: ["finished"] } });
    assert.match(String((badKind as { invalid?: string }).invalid), /kinds\[0\] must be one of/, "God Mode checks the kinds against the described enum");

    const blocked = await pluginActionOn(daemon, { ...start, args: { task: "Blocked thing" } });
    assert.equal(blocked.data.outcome, "refused");
    assert.match(blocked.data.reason, /its target could not be read: .*blocked by TST-TASK1/);

    const release = await pluginActionOn(daemon, { plugin: "dashboard", operation: "release_task", args: { task: "TST-RD002", to: "todo" }, secret });
    assert.equal(release.data.outcome, "needs_confirmation");
    assert.match(release.data.confirm_text, /held by anna on anna-mbp since 08:05, and set it to todo/);
  } finally {
    s.stop();
  }
});

test("God Mode with starting without asking: the catalog says start_task runs at once, it starts once, and turning it off asks again", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn, pluginActionOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  const startAction = async () => (await pluginReadOn(daemon, {})).data.plugins[0].actions.find((a: { id: string }) => a.id === "start_task");
  try {
    assert.equal((await startAction()).asks_first, true, "off by default");
    writeGodModeSettings(s.dashboard, { start_without_asking: true });
    assert.deepEqual([(await startAction()).asks_first, (await startAction()).risk], [false, "low"], "the next catalog follows the switch");

    const start = { plugin: "dashboard", operation: "start_task", args: { task: "TST-FX001" }, secret };
    const ran = await pluginActionOn(daemon, start);
    assert.equal(ran.data.outcome, "done", ran.text);
    assert.equal(ran.data.confirmation, undefined, "no confirmation issued");
    assert.equal(ran.data.result.mode, "Auto mode (auto, this Mac's default)");
    assert.match(ran.text, /Auto mode/, "the spoken answer names the mode");
    assert.match(ran.text, /not seen by you yet/, "and what the confirmation would have said about the instructions");
    assert.equal(s.task("TST-FX001")?.status, "in_progress");

    const again = await pluginActionOn(daemon, start);
    assert.notEqual(again.data.outcome, "done", again.text);
    assert.match(again.text, /already started by/);
    assert.equal(s.dashboard.runs!.runs.size, 1, "a repeated request makes no second run");

    const blocked = await pluginActionOn(daemon, { ...start, args: { task: "Blocked thing" } });
    assert.notEqual(blocked.data.outcome, "done");
    assert.match(blocked.text, /blocked by TST-TASK1/);

    const created = await pluginActionOn(daemon, { plugin: "dashboard", operation: "create_task", args: { title: "Another one", project: "core" }, secret });
    assert.equal(created.data.outcome, "done", created.text);
    assert.equal(s.dashboard.runs!.runs.size, 1, "creating a task starts nothing");
    writeGodModeSettings(s.dashboard, { start_without_asking: false });
    const asked = await pluginActionOn(daemon, { ...start, args: { task: created.data.result.id } });
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    assert.match(asked.data.confirm_text, /in mode Auto mode/);
    assert.equal(s.dashboard.runs!.runs.size, 1);
  } finally {
    s.stop();
  }
});

test("God Mode asking first: the read-back ends with a question, nothing runs before the yes, and a repeated confirmed call starts nothing more", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginActionOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  try {
    const start = { plugin: "dashboard", operation: "start_task", args: { task: "TST-FX001" }, secret };
    const asked = await pluginActionOn(daemon, start);
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    // This Mac's default mode, and the effort said with it: God Mode shows at most 8 fields.
    assert.match(asked.data.confirm_text, /in mode Auto mode \(auto, this Mac's default\); effort the provider's own;/);
    assert.match(asked.data.confirm_text, /Start it\?$/, "the user hears a question to say yes to");
    assert.match(asked.text, /Tell the user: ".*Start it\?"/);

    // The request said again without the token is asked again: nothing starts before the yes.
    const repeated = await pluginActionOn(daemon, start);
    assert.equal(repeated.data.outcome, "needs_confirmation", repeated.text);
    assert.equal(s.dashboard.runs!.runs.size, 0);
    assert.equal(s.task("TST-FX001")?.status, "todo");

    const ran = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(ran.data.outcome, "done", ran.text);
    assert.equal(ran.data.result.mode, "Auto mode (auto, this Mac's default)");

    // God Mode does not spend the token, but reads the target again: the same confirmed call finds the task held.
    const again = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(again.data.outcome, "refused", again.text);
    assert.match(again.data.reason, /its target could not be read: .*already started by/);
    assert.equal(s.dashboard.runs!.runs.size, 1, "one run");

    const blocked = await pluginActionOn(daemon, { ...start, args: { task: "Blocked thing" } });
    assert.equal(blocked.data.outcome, "refused", blocked.text);
    assert.equal(blocked.data.confirmation, undefined, "a blocked task is refused without a read-back");
  } finally {
    s.stop();
  }
});

test("God Mode resumes one paused autopilot task: read-back first, a stale yes is read back again, a started task is refused, a repeat resumes nothing (JOBBY-TGHP0)", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginActionOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  const pause = (key: string, why: string) => (s.dashboard.autopilot as unknown as { pause: (space: string, key: string, why: string) => void }).pause("TST", key, why);
  const paused = (id: string) => readAutopilot(s.ctx).flags.find((f) => f.task === id)?.paused;
  try {
    // Always read back, also while this Mac starts tasks without asking.
    for (const on of [false, true]) {
      writeGodModeSettings(s.dashboard, { start_without_asking: on });
      const action: { asks_first: boolean; risk: string } = (await gm.paseo.pluginReadOn(daemon, {})).data.plugins[0].actions.find((a: { id: string }) => a.id === "resume_task");
      assert.deepEqual([action.asks_first, action.risk], [true, "outward"], String(on));
    }

    s.dashboard.autopilot!.set({ space: "TST", task: "TST-TASK1", on: true });
    pause("t:TST:TST-TASK1", "paused: starting TST-TASK1 failed: no worktree");
    const resume = { plugin: "dashboard", operation: "resume_task", args: { task: "TST-TASK1" }, secret };
    const asked = await pluginActionOn(daemon, resume);
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    assert.match(asked.data.confirm_text, /^Resume «one» on this Mac's autopilot\. Paused: paused: starting TST-TASK1 failed: no worktree\. Once resumed, this Mac's autopilot may start it on its own/);
    assert.match(asked.data.confirm_text, /Resume it\?$/);
    assert.equal(paused("TST-TASK1"), true, "nothing runs before the yes");

    // The pause is written again with another reason before the yes: the yes covered the old one.
    pause("t:TST:TST-TASK1", "paused: starting TST-TASK1 failed: the profile is gone");
    const stale = await pluginActionOn(daemon, { ...resume, confirmation: asked.data.confirmation });
    assert.equal(stale.data.outcome, "needs_confirmation", stale.text);
    assert.equal(stale.data.target_changed, true);
    assert.match(stale.data.confirm_text, /the profile is gone/);
    assert.equal(paused("TST-TASK1"), true);

    // The user started it from Paseo meanwhile: the confirmed call finds it started and resumes nothing.
    await see(s, "TST-TASK1");
    assert.equal((await startTask(s.ctx, { task: "TST-TASK1" })).ok, true);
    const late = await pluginActionOn(daemon, { ...resume, confirmation: stale.data.confirmation });
    assert.equal(late.data.outcome, "refused", late.text);
    assert.match(late.data.reason, /its target could not be read: TST-TASK1 already started: its agent is \w+; nothing to resume, nothing started again\. Next: read task TST-TASK1/);
    assert.equal(s.dashboard.runs!.runs.size, 1);

    // A yes that still holds: the pause goes, the answer says queued, launching or working.
    s.dashboard.autopilot!.set({ space: "TST", task: "TST-FX001", on: true });
    pause("t:TST:TST-FX001", "paused: by a test");
    const fx = { ...resume, args: { task: "TST-FX001" } };
    const yes = await pluginActionOn(daemon, fx);
    const done = await pluginActionOn(daemon, { ...fx, confirmation: yes.data.confirmation });
    assert.equal(done.data.outcome, "done", done.text);
    assert.equal(done.data.result.state, "queued", "its instructions were never seen here: it waits");
    assert.match(done.data.result.wait, /open TST-FX001 once/);
    assert.equal(paused("TST-FX001"), false);
    // The same confirmed call again: not paused any more, so refused, and nothing new starts.
    const again = await pluginActionOn(daemon, { ...fx, confirmation: yes.data.confirmation });
    assert.equal(again.data.outcome, "refused", again.text);
    assert.match(again.data.reason, /TST-FX001 is not paused: it is queued on this Mac's autopilot\. Next: nothing to resume/);
    // Only the project's flag is paused: the refusal says that the user resumes it in Paseo Dash.
    s.dashboard.autopilot!.set({ space: "TST", project: "core", on: true });
    pause("p:TST:core", "paused: by a test");
    const line = await pluginActionOn(daemon, { ...resume, args: { task: "TST-TASK2" } });
    assert.equal(line.data.outcome, "refused", line.text);
    assert.match(line.data.reason, /Next: only the user resumes a project's flag, in Paseo Dash: Live, Autopilot/);
    assert.equal(readAutopilot(s.ctx).flags.find((f) => f.project === "core")?.paused, true);
    assert.equal(s.dashboard.runs!.runs.size, 1);
  } finally {
    s.stop();
  }
});

test("a recap keeps since, total and counts within God Mode's spoken 1,500 characters, however many events", async (t) => {
  const gm = await godMode();
  if (!gm.caps) return t.skip(gm.why);
  const s = await setup();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await createTask(s.ctx, { title: `${"A long task title ".repeat(8)}${i}`, project: "core" })).ok, true);
    await s.sync().sync();
    const op = gm.caps.parseCapabilities(describeDashboard()).capabilities.operations.find((o: { id: string }) => o.id === "recap");
    const answer = await readRecap(s.dashboard, { limit: 100 });
    assert.ok(answer.events.length >= 30);
    const spoken = gm.caps.resultLines(gm.caps.projectResult(op, answer), 1500);
    for (const field of ["since", "total", "counts", "more"]) assert.match(spoken, new RegExp(`^${field}: `, "m"), field);
  } finally {
    s.stop();
  }
});

test("God Mode reads a task's checks and review, says they are untrusted, and reads out the link when the forge cannot be asked", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const s = await setup({ profiles: [{ id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" }] });
  const url = "https://github.com/acme/core/pull/7";
  let answer = { code: 0, stdout: "" };
  const daemon = client(s.ctx, async () => answer);
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url });
    answer = {
      code: 0,
      stdout: JSON.stringify({
        number: 7, url, title: "Fix the flaky login test", state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    };
    const read = await gm.paseo.pluginReadOn(daemon, { plugin: "dashboard", operation: "task_result", args: { task: "TST-FX001" } });
    assert.equal(read.data.refused, undefined, read.text);
    assert.equal(read.data.untrusted, true);
    assert.deepEqual([read.data.result.pr, read.data.result.state, read.data.result.checks, read.data.result.failing, read.data.result.review], ["#7", "open", "failing", ["lint"], "approved"]);
    for (const field of ["pr", "state", "checks", "failing", "review"]) assert.match(read.text, new RegExp(`^${field}: `, "m"), field);

    s.dashboard.projectRoots.clear();
    const away = await gm.paseo.pluginReadOn(daemon, { plugin: "dashboard", operation: "task_result", args: { task: "TST-FX001" } });
    assert.equal(away.data.refused, true);
    assert.match(away.text, /no checkout on this Mac/);
    assert.ok(away.text.includes(url), "the spoken reason carries the link");
  } finally {
    s.stop();
  }
});

test("God Mode reviews a task: send_back reaches the agent and moves the task, accept_task reads back checks and holder, then marks it done", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginActionOn } = gm.paseo;
  const s = await setup({ profiles: [{ id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" }] });
  const url = "https://github.com/acme/core/pull/7";
  const view = (checks: { name: string; status: string; conclusion: string }[]) => ({
    code: 0,
    stdout: JSON.stringify({ number: 7, url, title: "Fix the flaky login test", state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: checks.map((c) => ({ __typename: "CheckRun", ...c })) }),
  });
  let answer = view([{ name: "build", status: "IN_PROGRESS", conclusion: "" }]);
  const daemon = client(s.ctx, async () => answer);
  const secret = "test-secret";
  const toReview = async (at: string) => {
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await s.sync().record([{ op_id: `op-${at}`, kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at }]).outcomes;
    assert.equal(s.task("TST-FX001")?.status, "review");
  };
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url });
    await toReview("2026-10-26T10:00:00Z");
    const agent = s.fake.agents.get(run.agentId!)!;

    // Sending back runs at once, like send_message; a refusal says why and sends nothing.
    const back = { plugin: "dashboard", operation: "send_back", args: { task: "Fix flaky login", comment: "Cover the logout path too" }, secret };
    agent.status = "running";
    const busy = await pluginActionOn(daemon, back);
    assert.deepEqual([busy.data.outcome, busy.data.delivered, s.fake.sent.length], ["refused", false, 0]);
    assert.match(busy.data.reason, /still working/);
    agent.status = "idle";
    const sent = await pluginActionOn(daemon, back);
    assert.equal(sent.data.outcome, "done", sent.text);
    assert.equal(sent.data.result.status, "in_progress");
    assert.equal(s.task("TST-FX001")?.status, "in_progress", "back in progress, as the screen's Send back does");
    assert.match(s.fake.sent.at(-1)!.text, /^Review feedback from the user on TST-FX001 «Fix flaky login test»:\n\nCover the logout path too\n/);
    assert.match(sent.text, /status: in_progress/);

    // Accepting asks first and reads back the checks, the review and who holds the task.
    await toReview("2026-10-26T11:00:00Z");
    const accept = { plugin: "dashboard", operation: "accept_task", args: { task: "TST-FX001" }, secret };
    const asked = await pluginActionOn(daemon, accept);
    assert.equal(asked.data.outcome, "needs_confirmation");
    assert.equal(asked.data.risk, "disruptive");
    assert.match(asked.data.confirm_text, /^Accept the work on «Fix flaky login test» and mark it done: PR #7 open, checks pending, review approved\. Held by \S+ on \S+ since [^;]+; its agent on this Mac is stopped; its chat stays\. Accept it\?$/);
    assert.equal(s.task("TST-FX001")?.status, "review", "nothing runs before the yes");

    // CI finished red between the read-back and the yes: the user hears it again before anything happens.
    answer = view([{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }]);
    const changed = await pluginActionOn(daemon, { ...accept, confirmation: asked.data.confirmation });
    assert.equal(changed.data.outcome, "needs_confirmation");
    assert.equal(changed.data.target_changed, true);
    assert.match(changed.data.confirm_text, /checks failing \(build\)/);
    assert.equal(s.task("TST-FX001")?.status, "review");

    const done = await pluginActionOn(daemon, { ...accept, confirmation: changed.data.confirmation });
    assert.equal(done.data.outcome, "done", done.text);
    assert.equal(s.task("TST-FX001")?.status, "done");
    assert.equal(done.data.result.status, "done");

    // Not in review: refused with the reason before any read-back. Another Mac's run: said so.
    const elsewhere = await pluginActionOn(daemon, { ...accept, args: { task: "TST-RD002" } });
    assert.equal(elsewhere.data.outcome, "refused");
    assert.match(elsewhere.data.reason, /is in_progress, not in review/);
    const anna = s.task("TST-RD002")!;
    await s.sync().record([{ op_id: "op-anna", kind: "transition", id: "TST-RD002", to: "review", run_id: anna.run_id!, at: "2026-10-26T12:00:00Z" }]).outcomes;
    const theirs = await pluginActionOn(daemon, { ...accept, args: { task: "TST-RD002" } });
    assert.match(theirs.data.confirm_text, /: no PR\/MR\. Held by anna on anna-mbp since 08:05; its agent on anna-mbp keeps running; stop it in its chat if it should\. Accept it\?$/);
    const away = await pluginActionOn(daemon, { ...back, args: { task: "TST-RD002", comment: "Rename it" } });
    assert.equal(away.data.outcome, "refused");
    assert.match(away.data.reason, /runs on anna-mbp; send it there/);
  } finally {
    s.stop();
  }
});

test("a full task read keeps status, activity and progress within God Mode's spoken 1,500 characters", async (t) => {
  const gm = await godMode();
  if (!gm.caps) return t.skip(gm.why);
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-RD002", brief: "Long brief. ".repeat(200) });
    const op = gm.caps.parseCapabilities(describeDashboard()).capabilities.operations.find((o: { id: string }) => o.id === "task");
    const spoken = gm.caps.resultLines(gm.caps.projectResult(op, await getTaskWithRuns(s.ctx, { task: "TST-RD002" })), 1500);
    for (const field of ["status", "activity", "progress", "held_by", "since"]) assert.match(spoken, new RegExp(`^${field}: `, "m"), field);
  } finally {
    s.stop();
  }
});

test("God Mode sends «PD» and the plugin's names to the installed plugin, with a development copy installed next to it", async (t) => {
  const gm = await godMode();
  if (!gm.caps) return t.skip(gm.why);
  const entry = (id: string, dev: boolean) => ({ id, name: "Paseo Dash", capabilities: gm.caps!.parseCapabilities(describeDashboard(false, dev)).capabilities });
  // Either order: God Mode takes the first plugin that matches, in the order Paseo lists them.
  for (const entries of [[entry("dashboard-dev", true), entry("dashboard", false)], [entry("dashboard", false), entry("dashboard-dev", true)]]) {
    for (const query of ["PD", "pd", "ПД", "Paseo Dash", "paseo dash", "dashboard", "tasks", "задачі"]) {
      assert.equal(gm.caps.pickPlugin(entries, query).match?.id, "dashboard", query);
    }
    for (const query of ["Paseo Dash Dev", "PD Dev", "dashboard-dev"]) {
      assert.equal(gm.caps.pickPlugin(entries, query).match?.id, "dashboard-dev", query);
    }
  }
});

test("God Mode starts a set the user named with one read-back: what starts now, what later, what not; a set of which nothing starts is refused first", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn, pluginActionOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  try {
    const plan = await pluginReadOn(daemon, { plugin: "dashboard", operation: "start_plan", args: { tasks: ["TST-DEP01", "TST-TASK1", "TST-RD002"] } });
    assert.equal(plan.data.untrusted, true);
    assert.match(plan.data.result.rules, /not permission/);
    assert.deepEqual(
      plan.data.result.tasks.map((x: Record<string, unknown>) => [x.id, x.decision, x.order]),
      [["TST-TASK1", "can_start", 1], ["TST-DEP01", "after_prerequisites", 2], ["TST-RD002", "already_started", 0]],
    );

    const start = { plugin: "dashboard", operation: "start_tasks", args: { tasks: ["TST-DEP01", "TST-TASK1", "TST-RD002"] }, secret };
    const asked = await pluginActionOn(daemon, start);
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    assert.match(asked.data.confirm_text, /^Start on this Mac now: TST-TASK1 «one»\. Later, .*: TST-DEP01 «Blocked thing» after TST-TASK1\. Not started: TST-RD002 «Login page redesign» \(already_started\)\. Agents: .* in Auto mode/);
    assert.match(asked.data.confirm_text, /Start them\?$/);
    assert.equal(s.dashboard.runs!.runs.size, 0, "nothing before the yes");

    const ran = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(ran.data.outcome, "done", ran.text);
    assert.deepEqual(ran.data.result.started.map((x: Record<string, unknown>) => [x.id, x.state]), [["TST-TASK1", "launching"]]);
    assert.deepEqual(ran.data.result.queued.map((x: Record<string, unknown>) => x.id), ["TST-DEP01"]);
    await settled(() => s.task("TST-TASK1")?.status === "in_progress");

    // The same confirmed call again: the set reads differently now, so it is read back again and nothing more runs.
    const again = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(again.data.outcome, "needs_confirmation", again.text);
    assert.equal(again.data.target_changed, true);
    assert.equal(s.dashboard.runs!.runs.size, 1);

    const draft = await createTask(s.ctx, { title: "Just an idea" });
    const nothing = await pluginActionOn(daemon, { ...start, args: { tasks: [draft.id] } });
    assert.equal(nothing.data.outcome, "refused", nothing.text);
    assert.match(nothing.data.reason, /Nothing of the set would start/);
    assert.equal(nothing.data.confirmation, undefined, "refused without a read-back");
  } finally {
    s.stop();
  }
});

test("God Mode's read-back of a start of a person's work says the label, and the yes starts it; start_plan says needs_owner", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn, pluginActionOn } = gm.paseo;
  const s = await setup();
  s.f.external("ergo", (root) => {
    const space = join(root, "space.yaml");
    writeFileSync(space, `${readFileSync(space, "utf8")}defaults:\n  human_labels: [manual]\n`);
    const task = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
    writeFileSync(task, readFileSync(task, "utf8").replace("status: todo\n", "status: todo\nlabels: [manual]\n"));
  });
  await s.sync().sync();
  const daemon = client(s.ctx);
  const secret = "test-secret";
  try {
    const plan = await pluginReadOn(daemon, { plugin: "dashboard", operation: "start_plan", args: { tasks: ["TST-FX001"] } });
    assert.deepEqual(plan.data.result.tasks.map((x: Record<string, unknown>) => [x.decision, x.needs]), [["needs_owner", "human_label"]]);

    const start = { plugin: "dashboard", operation: "start_task", args: { task: "TST-FX001" }, secret };
    const asked = await pluginActionOn(daemon, start);
    assert.equal(asked.data.outcome, "needs_confirmation", asked.text);
    assert.match(asked.data.confirm_text, /Label manual marks it as a person's work: an agent starts it only because this one task was asked for\. Start it\?$/);
    const ran = await pluginActionOn(daemon, { ...start, confirmation: asked.data.confirmation });
    assert.equal(ran.data.outcome, "done", ran.text);
    assert.equal(s.task("TST-FX001")?.status, "in_progress");
  } finally {
    s.stop();
  }
});

test("ChatGPT finds a task by a dictated id or a vague name and a feature by its name, within what God Mode speaks", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn } = gm.paseo;
  const s = await setup();
  const daemon = client(s.ctx);
  const read = (operation: string, args: Record<string, unknown>) => pluginReadOn(daemon, { plugin: "dashboard", operation, args });
  try {
    assert.match((await read("task", { task: "tst fx001" })).text, /^id: TST-FX001$/m);
    // No title has every word whole: the one task search points to, and how it was found.
    const vague = await read("task", { task: "flaky logins test" });
    assert.match(vague.text, /^id: TST-FX001$/m);
    assert.match(vague.text, /^found_by: title: «Fix flaky login test»$/m);
    // Nothing clear: refused, naming the closest tasks with their ids.
    const unclear = await read("task", { task: "login audit" });
    assert.match(unclear.text, /could not read it\. No task matches «login audit»\. Closest: TST-\w+ «.+» \(\w+\), TST-\w+ «.+» \(\w+\)\. Use the id\./);
    // A feature by its name, before the rows, where a long answer is not cut.
    const login = await read("tasks", { query: "login" });
    assert.match(login.text, /^Paseo Dash[^\n]* · Find tasks\n/);
    assert.ok(login.text.indexOf("also: ") < login.text.indexOf("tasks: "), login.text);
    assert.match(login.text, /^also: \[\{"kind":"feature","id":"TST-FEAT1","title":"Login"\}\]$/m);
  } finally {
    s.stop();
  }
});

test("God Mode reads and acts through JOBBY-YV2QS's operations, refusals included", async (t) => {
  const gm = await godMode();
  if (!gm.paseo) return t.skip(gm.why);
  const { pluginReadOn, pluginActionOn } = gm.paseo;
  const s = await setup({
    profiles: [
      { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" },
      { id: "p2", name: "Sonnet 5.5 High", provider: "claude", model: "claude-sonnet-5-5", modeId: "default", thinkingOptionId: "high" },
    ],
  });
  const daemon = client(s.ctx);
  const secret = "test-secret";
  const read = (operation: string, args: Record<string, unknown> = {}) => pluginReadOn(daemon, { plugin: "dashboard", operation, args });
  try {
    const profiles = await read("tasks_profiles", { tasks: ["TST-FX001", "TST-DEP01"] });
    assert.match(profiles.data.result.tasks[0].next_start, /per-task pick/, profiles.text);
    const batch = { plugin: "dashboard", operation: "update_tasks", secret, args: { items: [{ task: "TST-FX001", agent_profile: "Sonnet 5.5 High" }, { task: "TST-DEP01", agent_profile: "Nope" }], revision: profiles.data.result.revision, key: "gm-batch-0001" } };
    const done = await pluginActionOn(daemon, batch);
    assert.deepEqual(done.data.result.items.map((i: { result: string }) => i.result), ["applied", "refused"], done.text);
    assert.notEqual(done.data.outcome, "done", "a refused item is not hidden behind a success");
    const again = await pluginActionOn(daemon, batch);
    assert.equal(again.data.result.items[0].result, "applied", "the retry applies nothing twice");
    assert.equal(s.task("TST-FX001")!.agent_profile, "Sonnet 5.5 High");
    const stale = await pluginActionOn(daemon, { ...batch, args: { ...batch.args, key: "gm-batch-0002" } });
    assert.match(stale.data.result.error, /changed since they were read/);

    const text = await read("task_text", { task: "TST-FX001", section: "acceptance" });
    assert.equal(text.data.result.text, "1. [x] first\n2. [ ] second");
    const missing = await read("task_text", { task: "TST-NOPE1", section: "brief" });
    assert.match(missing.data.result.error, /TST-NOPE1/);

    const candidates = await read("start_candidates", { group: "agent" });
    assert.ok(candidates.data.result.tasks.length > 0, candidates.text);
    assert.match(candidates.data.result.note, /Read only/);
    const review = await read("ready_review", { project: "core" });
    assert.equal(review.data.refused, undefined, review.text);
    assert.ok(review.data.result.tasks.length > 0, review.text);
    assert.match(review.data.result.note, /Read only/);
    // The spoken text is cut short: every listed card's line comes before the roots, so it survives.
    for (const line of review.data.result.summary) assert.ok(review.text.includes(line.slice(0, 40)), `${line} is spoken: ${review.text}`);
    const reconciled = await read("reconcile", {});
    assert.equal(reconciled.data.result.error, "", reconciled.text);
    const delivery = await read("delivery", { task: "TST-FX001" });
    assert.equal(delivery.data.result.stage, "in_work", delivery.text);
  } finally {
    s.stop();
  }
});
