import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opaqueId } from "../plan/ids.ts";
import { factText, taskInstructions } from "../runner/seen.ts";
import { settled } from "../runner/testing.ts";
import { systemGit } from "../sync/git.ts";
import { liveRuns, taskView } from "../views.ts";
import { getTask, uiStartCheck } from "./reads.ts";
import { setup } from "./testing.ts";
import { continueTask, createTask, markSeen, startTask, updateTask } from "./writes.ts";

/** The actions only the dashboard's own screens offer (shared/ui.ts), and the task screen's facts for them. */

test("a new task gets its acceptance lines, and a draft merges into another task as its duplicate", async () => {
  const s = await setup();
  try {
    const made = await createTask(s.ctx, { title: "Export", project: "core", acceptance: ["CSV works", "tested"] });
    assert.equal(made.ok, true, made.error);
    assert.deepEqual(getTask(s.ctx, { task: made.id }).acceptance, [
      { text: "CSV works", done: false },
      { text: "tested", done: false },
    ]);
    const draft = await createTask(s.ctx, { title: "Export again" });
    const merged = await updateTask(s.ctx, { task: draft.id, duplicate_of: made.id, status: "canceled" });
    assert.equal(merged.ok, true, merged.error);
    assert.deepEqual(merged.changed, ["duplicate_of", "status"]);
    assert.match(s.task(draft.id)!.duplicate_of ?? "", new RegExp(`^\\[\\[${made.id}-export`));
    assert.equal(s.task(draft.id)!.status, "canceled");
    assert.match((await updateTask(s.ctx, { task: made.id, duplicate_of: made.id, status: "canceled" })).error, /cannot duplicate itself/);
    const open = await updateTask(s.ctx, { task: made.id, duplicate_of: "TST-TASK1" });
    assert.match(open.error, /duplicate_of goes with status canceled/);
    assert.equal(s.task(made.id)!.duplicate_of, undefined, "nothing was changed");
  } finally {
    s.stop();
  }
});

test("the task screen says what can be done from here", async () => {
  const s = await setup();
  try {
    const actions = (id: string) => taskView(s.dashboard, { task: id }, s.ctx.now!()).actions;
    assert.deepEqual(actions("TST-FX001"), { start: "", blocked_by: [], release: false, continue: false, landed_done: false, close: true, reopen: false, triage: false, line: "", archive: false });
    assert.equal(actions("TST-DEP01").start, "", "a blocked task starts only anyway, which the screen offers");
    assert.deepEqual(actions("TST-DEP01").blocked_by, ["TST-TASK1 «one» (todo)"]);
    assert.equal(actions("TST-ST001").start, "project site is not mapped on this Mac");
    const held = actions("TST-RD002");
    assert.match(held.start, /^started by anna on anna-mbp since 08:05$/);
    assert.deepEqual([held.release, held.continue, held.close], [true, false, false], "its run is on another machine");
  } finally {
    s.stop();
  }
});

test("a blocked task starts from the dashboard only when asked to start anyway", async () => {
  const s = await setup();
  try {
    const check = await uiStartCheck(s.ctx, { task: "TST-DEP01", anyway: false });
    assert.match(check.error, /blocked by TST-TASK1/);
    assert.deepEqual(check.blocked_by, ["TST-TASK1 «one» (todo)"]);
    assert.deepEqual(check.waits, [{ id: "TST-TASK1", title: "one", status: "todo", glyph: "todo", can_start: true }], "the blocker can start itself");
    const anyway = await uiStartCheck(s.ctx, { task: "TST-DEP01", anyway: true });
    assert.equal(anyway.error, "");
    assert.deepEqual(anyway.blocked_by, ["TST-TASK1 «one» (todo)"], "still listed in the confirmation");
    assert.deepEqual(
      anyway.parts.map((p) => [p.key, p.state]),
      [["task:TST-DEP01", "unseen"]],
    );
    assert.deepEqual(anyway.blocked_ids, ["TST-TASK1"]);
    const seen = anyway.parts.map((p) => p.hash);
    assert.match((await startTask(s.ctx, { task: "TST-DEP01" }, { seen })).error, /blocked by TST-TASK1/, "not without start past");
    const started = await startTask(s.ctx, { task: "TST-DEP01" }, { startPast: anyway.blocked_ids, seen });
    assert.equal(started.ok, true, started.error);
    assert.equal(s.task("TST-DEP01")!.status, "in_progress");
    const part = { key: "task:TST-DEP01", name: "x", text: taskInstructions("Do it.", ["first", "second"]), author: "" };
    assert.equal(s.dashboard.seen!.facts("TST", [part])[0]!.state, "unchanged", "the start marked what its confirmation showed");
  } finally {
    s.stop();
  }
});

test("a start refuses when the instructions changed after its confirmation showed them", async () => {
  const s = await setup();
  try {
    const check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.error, "");
    await updateTask(s.ctx, { task: "TST-FX001", brief: "Do something else." });
    const refused = await startTask(s.ctx, { task: "TST-FX001" }, { seen: check.parts.map((p) => p.hash) });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /instructions changed after the confirmation/);
    assert.equal(s.task("TST-FX001")!.status, "todo", "nothing was claimed");
  } finally {
    s.stop();
  }
});

test("the confirmation answers origin's branches from the last minute; the start asks origin again", async () => {
  let asked = 0;
  const s = await setup(undefined, {
    runner: {
      run: (cwd, args, timeoutMs) => {
        if (args[0] === "ls-remote" && args[1] === "--heads") asked += 1;
        return systemGit.run(cwd, args, timeoutMs);
      },
    },
  });
  try {
    const check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.error, "");
    assert.equal((await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false })).branch, check.branch);
    assert.equal(asked, 1, "opened again, the confirmation does not wait for origin");
    const started = await startTask(s.ctx, { task: "TST-FX001" }, { seen: check.parts.map((p) => p.hash) });
    assert.equal(started.ok, true, started.error);
    assert.equal(asked, 2, "the start decides the branch from origin as it is now");
  } finally {
    s.stop();
  }
});

test("a start refuses when its project, branch, workspace or agent is not the one the confirmation showed", async () => {
  const s = await setup();
  try {
    const check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.error, "");
    const seen = check.parts.map((p) => p.hash);
    const shown = (facts: typeof check) => ({ project: facts.project, branch: facts.branch, workspace: facts.workspace, profile: facts.profile, issue: facts.issue });
    // The space's default agent changes after the confirmation read its facts (a sync, another screen).
    s.sync().plan.space!.defaults.agent_profile = "Review";
    const refused = await startTask(s.ctx, { task: "TST-FX001" }, { seen, shown: shown(check) });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, `What the start would do changed after the confirmation showed it: the agent is now Review (the space's), not ${check.profile}. Check the start again.`);
    assert.equal(s.task("TST-FX001")!.status, "todo", "nothing was claimed");
    const again = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    // The issue the agent is told to close changes too: it is not part of the instructions' hash.
    const task = s.task("TST-FX001")!;
    task.issue = "https://github.com/acme/core/issues/2";
    const otherIssue = await startTask(s.ctx, { task: "TST-FX001" }, { seen, shown: shown(again) });
    assert.match(otherIssue.error, /changed after the confirmation showed it: the issue is now Its issue acme\/core#2 .*, not none\./);
    const last = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    const started = await startTask(s.ctx, { task: "TST-FX001" }, { seen, shown: shown(last) });
    assert.equal(started.ok, true, started.error);
  } finally {
    s.stop();
  }
});

test("the task screen marks the brief seen only as it still is; a later edit shows as a diff", async () => {
  const s = await setup();
  try {
    const shown = taskView(s.dashboard, { task: "TST-FX001" }).instructions_hash;
    assert.match(markSeen(s.ctx, { task: "TST-FX001", hash: "0".repeat(24) }).error, /changed since the screen read them/);
    assert.deepEqual(markSeen(s.ctx, { task: "TST-FX001", hash: shown }), { ok: true, error: "" });
    let check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.equal(check.instructions, "unchanged since you last saw them");
    assert.deepEqual(check.parts[0]!.diff, []);

    await updateTask(s.ctx, { task: "TST-FX001", brief: "Do it twice." });
    check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.match(check.instructions, /^changed since you last saw them/);
    assert.deepEqual(check.parts[0]!.diff.slice(0, 2), [
      { op: "+", text: "Do it twice." },
      { op: "-", text: "Do it." },
    ]);
  } finally {
    s.stop();
  }
});

test("continue work moves a task from review back to in progress, only on its run's machine", async () => {
  const s = await setup();
  try {
    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    const review = (id: string, run_id: string) =>
      s.sync().record([{ op_id: opaqueId("op"), kind: "transition", id, to: "review", run_id, at: s.ctx.now!().toISOString() }]).outcomes;
    await review("TST-FX001", s.task("TST-FX001")!.run_id!);
    await review("TST-RD002", "r-anna");
    assert.equal(taskView(s.dashboard, { task: "TST-FX001" }).actions.continue, true);
    assert.equal(taskView(s.dashboard, { task: "TST-RD002" }).actions.continue, false);

    assert.match((await continueTask(s.ctx, { task: "TST-RD002" })).error, /runs on anna-mbp; continue it there/);
    const continued = await continueTask(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([continued.ok, continued.status], [true, "in_progress"], continued.error);
    assert.equal(s.task("TST-FX001")!.status, "in_progress");
    assert.match((await continueTask(s.ctx, { task: "TST-FX001" })).error, /is in_progress; only a task in review continues/);
  } finally {
    s.stop();
  }
});

test("start anyway goes past only the blockers its confirmation showed", async () => {
  const s = await setup();
  try {
    const check = await uiStartCheck(s.ctx, { task: "TST-DEP01", anyway: true });
    await updateTask(s.ctx, { task: "TST-DEP01", depends_on: ["TST-TASK1", "TST-TASK2"] });
    const refused = await startTask(s.ctx, { task: "TST-DEP01" }, { startPast: check.blocked_ids, seen: check.parts.map((p) => p.hash) });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /blocked by TST-TASK2/);
    assert.doesNotMatch(refused.error, /TST-TASK1/, "only the blocker it did not show");
  } finally {
    s.stop();
  }
});

test("the space's template: a change after the confirmation refuses, and the agent gets the text that was checked", async () => {
  const s = await setup();
  const template = (text: string) =>
    s.f.external("anna", (root) => {
      mkdirSync(join(root, "templates"), { recursive: true });
      writeFileSync(join(root, "templates", "start-prompt.md"), text);
    });
  try {
    template("Version one for {{id}}.\n");
    await s.sync().sync();
    let check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    assert.deepEqual(
      check.parts.map((p) => [p.key, p.state, p.author]),
      [
        ["task:TST-FX001", "unseen", "ergo"],
        ["template", "unseen", "anna"],
      ],
    );
    template("Version two for {{id}}.\n");
    await s.sync().sync();
    const refused = await startTask(s.ctx, { task: "TST-FX001" }, { seen: check.parts.map((p) => p.hash) });
    assert.match(refused.error, /instructions changed after the confirmation/);

    check = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: false });
    // The clone changes on disk while the start runs (a background fetch resets it to origin).
    const sync = s.sync();
    const gitUser = sync.gitUser.bind(sync);
    sync.gitUser = async () => {
      writeFileSync(join(sync.root, "templates", "start-prompt.md"), "Version three for {{id}}.\n");
      return gitUser();
    };
    const started = await startTask(s.ctx, { task: "TST-FX001" }, { seen: check.parts.map((p) => p.hash) });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(String([...s.fake.agents.values()][0]!.request.prompt), "Version two for TST-FX001.\n");
    const facts = s.dashboard.seen!.facts("TST", [{ key: "template", name: "t", text: "Version two for {{id}}.\n", author: "" }]);
    assert.equal(factText(facts), "unchanged since you last saw them", "the start marked the template it showed");
  } finally {
    s.stop();
  }
});

test("a start through God Mode marks nothing seen", async () => {
  const s = await setup();
  try {
    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    const part = { key: "task:TST-FX001", name: "x", text: taskInstructions("Do it.", ["first", "second"]), author: "" };
    assert.equal(s.dashboard.seen!.facts("TST", [part])[0]!.state, "unseen");
  } finally {
    s.stop();
  }
});

test("ui.runs lists this machine's live runs with their workspace, agent and progress, and no secret", async () => {
  const s = await setup();
  try {
    assert.deepEqual(liveRuns(s.dashboard), { runs: [], error: "" }, "anna's run is not on this machine");
    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const answer = liveRuns(s.dashboard);
    assert.deepEqual(answer.runs, [
      { task: "TST-FX001", title: "Fix flaky login test", space: "TST", status: "in_progress", workspaceId: run.workspaceId!, agentId: run.agentId!, progress: "1/2" },
    ]);
    assert.ok(run.token, "the run has a bridge token");
    assert.doesNotMatch(JSON.stringify(answer), new RegExp(run.token!), "the token never leaves the server");
    await s.sync().record([{ op_id: opaqueId("op"), kind: "release", id: "TST-FX001", run_id: run.run_id, to: "todo", at: s.ctx.now!().toISOString() }]).outcomes;
    assert.deepEqual(liveRuns(s.dashboard).runs, [], "a released run is gone");
  } finally {
    s.stop();
  }
});
