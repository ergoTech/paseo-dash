import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./api/testing.ts";
import { startTask } from "./api/writes.ts";
import { settled } from "./runner/testing.ts";
import { acceptCheck, feedbackText, sendBack, taskChecks, taskResult } from "./result.ts";
import { acceptCheckRpc, tasksResultRpc } from "../shared/api.ts";
import { ghChecks, gitlabIid, prDetails } from "./tracker/details.ts";
import type { CommandRunner } from "./tracker/forge.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const PR_URL = "https://github.com/acme/core/pull/7";

/** `gh pr view` as gh 2.83 answers it with the fields details.ts asks for. */
function ghView(extra: Record<string, unknown> = {}) {
  const files = Array.from({ length: 23 }, (_, i) => ({ path: `src/file${i}.ts`, additions: i + 1, deletions: i }));
  return {
    number: 7,
    url: PR_URL,
    title: "Fix the flaky login test",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/login",
    additions: 276,
    deletions: 253,
    changedFiles: 23,
    files,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/deploy-preview", state: "PENDING" },
    ],
    reviewDecision: "CHANGES_REQUESTED",
    ...extra,
  };
}

test("GitHub checks: runs and statuses are counted as GitHub sums them up", () => {
  assert.deepEqual(ghChecks([]), { state: "none", passed: 0, failed: 0, pending: 0, failing: [], url: "" });
  assert.equal(ghChecks(null)?.state, "none");
  const mixed = ghChecks([
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
  ]);
  assert.deepEqual([mixed?.state, mixed?.passed, mixed?.pending, mixed?.failed], ["pending", 3, 1, 0]);
  const failing = ghChecks([
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT" },
    { __typename: "StatusContext", context: "ci/old", state: "ERROR" },
    { __typename: "CheckRun", name: "build", status: "QUEUED" },
  ]);
  assert.deepEqual([failing?.state, failing?.failing], ["failing", ["test", "ci/old"]], "a failure wins over checks still running");
  const rerun = ghChecks([
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "STALE", context: null, state: null } as never,
  ]);
  assert.deepEqual([rerun?.state, rerun?.passed, rerun?.pending, rerun?.failed], ["pending", 1, 1, 0], "a rerun counts once, as its latest; stale is not finished");
  const twoWorkflows = ghChecks([
    { __typename: "CheckRun", name: "test", workflowName: "Unit", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-26T10:00:00Z" },
    { __typename: "CheckRun", name: "test", workflowName: "Integration", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-26T10:01:00Z" },
  ]);
  assert.deepEqual([twoWorkflows?.state, twoWorkflows?.failing], ["failing", ["test"]], "a failed check is not hidden by another workflow's check of the same name");
  const rerunEarlierInList = ghChecks([
    { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-26T11:00:00Z" },
    { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-26T10:00:00Z" },
  ]);
  assert.equal(rerunEarlierInList?.state, "passing", "the run started last counts, wherever it is in the list");
});

test("a GitHub PR's details: state, files with the rest counted, checks and review", async () => {
  const calls: string[][] = [];
  const gh: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: JSON.stringify(ghView()) };
  };
  const details = await prDetails("/tmp", "git@github.com:acme/core.git", PR_URL, gh);
  assert.deepEqual([details.label, details.state, details.head, details.base, details.title], ["#7", "open", "feat/login", "main", "Fix the flaky login test"]);
  assert.deepEqual([details.changes?.files, details.changes?.additions, details.changes?.deletions, details.changes?.list.length, details.changes?.more], [23, 276, 253, 20, 3]);
  assert.deepEqual([details.checks?.state, details.checks?.passed, details.checks?.failed, details.checks?.pending, details.checks?.failing], ["failing", 1, 1, 1, ["lint"]]);
  assert.equal(details.review, "changes requested");
  assert.deepEqual(calls[0]!.slice(0, 4), ["gh", "pr", "view", PR_URL]);
  assert.equal((await prDetails("/tmp", "git@github.com:acme/core.git", PR_URL, async () => ({ code: 0, stdout: JSON.stringify(ghView({ isDraft: true })) }))).state, "draft");

  const refused = await prDetails("/tmp", "git@github.com:acme/core.git", "https://github.com/evil/core/pull/7", gh).catch((e: Error) => e.message);
  assert.match(String(refused), /is not a pull request of github.com\/acme\/core/);
  assert.equal(calls.length, 1, "another repository's URL never reaches gh");
  const noGh = await prDetails("/tmp", "git@github.com:acme/core.git", PR_URL, async () => ({ code: 1, stdout: "" })).catch((e: Error) => e.message);
  assert.match(String(noGh), /gh could not read it/);
});

test("a GitLab MR's details: the web host may differ from the SSH remote's, the path may not", async () => {
  const remote = "git@gitlab-ssh.example.com:backend/core.git";
  assert.equal(gitlabIid("https://gitlab.example.com/backend/core/-/merge_requests/840", remote), "840", "web host gitlab.example.com, SSH host gitlab-ssh");
  assert.equal(gitlabIid("https://gitlab.example.com/backend/other/-/merge_requests/840", remote), undefined);
  assert.equal(gitlabIid("https://gitlab.example.com/backend/core/-/issues/840", remote), undefined);

  const views: Record<string, unknown>[] = [];
  const glab: CommandRunner = async (command, args) => {
    assert.deepEqual([command, ...args], ["glab", "mr", "view", "840", "-F", "json"]);
    return { code: 0, stdout: JSON.stringify(views.shift()) };
  };
  const base = { iid: 840, web_url: "https://gitlab.example.com/backend/core/-/merge_requests/840", title: "fix(dictation): guard", source_branch: "fix/x", target_branch: "master" };
  views.push({ ...base, state: "opened", draft: true, changes_count: "5", head_pipeline: { status: "running", web_url: "https://gitlab.example.com/backend/core/-/pipelines/1" }, detailed_merge_status: "not_approved" });
  const open = await prDetails("/tmp", remote, base.web_url, glab);
  assert.deepEqual([open.label, open.state, open.changes?.files, open.changes?.list.length, open.checks?.state, open.checks?.url, open.review], ["!840", "draft", 5, 0, "pending", "https://gitlab.example.com/backend/core/-/pipelines/1", "review required"]);
  views.push({ ...base, state: "merged", draft: false, changes_count: "1000+", head_pipeline: { status: "failed", web_url: "" } });
  const merged = await prDetails("/tmp", remote, base.web_url, glab);
  assert.deepEqual([merged.state, merged.changes?.files, merged.changes?.at_least, merged.checks?.state, merged.checks?.failing], ["merged", 1000, true, "failing", ["pipeline failed"]]);
  views.push({ ...base, state: "closed", head_pipeline: null });
  const closed = await prDetails("/tmp", remote, base.web_url, glab);
  assert.deepEqual([closed.state, closed.changes, closed.checks?.state], ["closed", null, "none"]);
  views.push({ ...base, state: "opened", changes_count: "2", head_pipeline: { status: "manual", web_url: "" }, detailed_merge_status: "requested_changes" });
  const manual = await prDetails("/tmp", remote, base.web_url, glab);
  assert.deepEqual([manual.checks?.state, manual.changes?.at_least, manual.review], ["waiting", false, "changes requested"], "a manual job waits for a person, not running");
  views.push({ ...base, state: "opened", head_pipeline: { status: "skipped", web_url: "" } });
  assert.equal((await prDetails("/tmp", remote, base.web_url, glab)).checks?.state, "none");
  // glab reads the MR of the project its remotes name: another project's !840 is not this task's.
  views.push({ ...base, web_url: "https://gitlab.example.com/someone/core-fork/-/merge_requests/840", state: "opened" });
  const fork = await prDetails("/tmp", remote, base.web_url, glab).catch((e: Error) => e.message);
  assert.match(String(fork), /glab answered with https:\/\/gitlab.example.com\/someone\/core-fork\/-\/merge_requests\/840, which is not/);
});

test("the task screen's result: the run's PR/MR from the forge, and the link alone when it cannot be asked", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    assert.deepEqual(await taskResult(s.ctx, { task: "TST-FX001" }).then((r) => [r.pr, r.error]), [null, ""], "no run, no PR/MR: nothing to read");
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url: PR_URL });
    const result = await taskResult(s.ctx, { task: "TST-FX001" }, async () => ({ code: 0, stdout: JSON.stringify(ghView()) }));
    assert.deepEqual([result.pr?.label, result.changes?.files, result.checks?.state, result.review, result.error], ["#7", 23, "failing", "changes requested", ""]);
    const failed = await taskResult(s.ctx, { task: "TST-FX001" }, async () => ({ code: 1, stdout: "" }));
    assert.deepEqual([failed.pr?.url, failed.pr?.label, failed.changes], [PR_URL, "", null]);
    assert.match(failed.error, /gh could not read it/);

    s.dashboard.projectRoots.clear();
    const unmapped = await taskResult(s.ctx, { task: "TST-FX001" }, async () => assert.fail("no checkout: the CLI is not run"));
    assert.equal(unmapped.pr?.url, PR_URL);
    assert.match(unmapped.error, /no checkout on this Mac/);
  } finally {
    s.stop();
  }
});

test("ChatGPT's result read: checks and review flat, the link in the error when the forge cannot be asked, nothing written", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const none = await taskChecks(s.ctx, { task: "TST-FX001" }, async () => assert.fail("no PR/MR: the CLI is not run"));
    assert.deepEqual(tasksResultRpc.output.parse(none), none);
    assert.deepEqual([none.id, none.pr, none.checks, none.url, none.error], ["TST-FX001", "", "", "", ""], "no PR/MR yet is an answer, not an error");
    const unknown = await taskChecks(s.ctx, { task: "no such task anywhere" });
    assert.equal(unknown.id, "");
    assert.notEqual(unknown.error, "");

    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url: PR_URL });
    const before = s.task("TST-FX001");
    const failures = Array.from({ length: 8 }, (_, i) => ({ __typename: "CheckRun", name: `job ${i} ${"x".repeat(i === 0 ? 200 : 0)}`, status: "COMPLETED", conclusion: "FAILURE" }));
    const calls: string[][] = [];
    const read = await taskChecks(s.ctx, { task: "Fix flaky login" }, async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: JSON.stringify(ghView({ statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }, ...failures] })) };
    });
    assert.deepEqual(tasksResultRpc.output.parse(read), read);
    assert.deepEqual(
      [read.id, read.pr, read.state, read.checks, read.passed, read.failed, read.pending, read.review, read.url, read.checks_url, read.pr_title, read.error],
      ["TST-FX001", "#7", "open", "failing", 1, 8, 0, "changes requested", PR_URL, `${PR_URL}/checks`, "Fix the flaky login test", ""],
    );
    assert.equal(read.failing.length, 5, "a few names; failed counts them all");
    assert.ok(read.failing[0]!.length <= 100 && read.failing[0]!.endsWith("…"), "a long name is cut");
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["gh", "pr", "view"]], "only a read of the PR");
    assert.deepEqual(s.task("TST-FX001"), before, "the plan is not written");

    const noGh = await taskChecks(s.ctx, { task: "TST-FX001" }, async () => ({ code: 127, stdout: "" }));
    assert.deepEqual([noGh.pr, noGh.checks, noGh.url], ["", "", PR_URL]);
    assert.match(noGh.error, /gh could not read it.*repository\. Link: https:\/\/github.com\/acme\/core\/pull\/7$/);
    s.dashboard.projectRoots.clear();
    const unmapped = await taskChecks(s.ctx, { task: "TST-FX001" }, async () => assert.fail("no checkout: the CLI is not run"));
    assert.match(unmapped.error, /no checkout on this Mac.* Link: https:\/\/github.com\/acme\/core\/pull\/7$/);
    assert.equal(unmapped.checks_url, "", "the checks page is not guessed without the forge");
  } finally {
    s.stop();
  }
});

test("send back: the comment goes to the run's agent once it waits, and a task in review is in progress again", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const none = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Rename it" });
    assert.match(none.error, /has no live run/);
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const agent = s.fake.agents.get(run.agentId!)!;

    agent.status = "running";
    const busy = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Rename it" });
    assert.deepEqual([busy.ok, s.fake.sent.length], [false, 0]);
    assert.match(busy.error, /still working/);

    agent.status = "idle";
    const inProgress = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Rename it" });
    assert.deepEqual([inProgress.ok, inProgress.status, s.fake.sent.length], [true, "in_progress", 1]);

    await s.sync().record([{ op_id: "op-review", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:00:00Z" }]).outcomes;
    assert.equal(s.task("TST-FX001")?.run_review_at, "2026-10-26T10:00:00Z", "the move to review is dated");
    // A reply goes as written and moves nothing, also in review.
    const reply = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Yes, use the shared helper.", reply: true });
    assert.deepEqual([reply.ok, reply.status, s.task("TST-FX001")?.status, s.fake.sent.at(-1)?.text], [true, "review", "review", "Yes, use the shared helper."]);
    const back = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Also cover the logout path" });
    assert.deepEqual([back.ok, back.status, back.note, back.error, s.task("TST-FX001")?.status], [true, "in_progress", "", "", "in_progress"]);
    assert.equal(s.fake.sent.at(-1)?.agentId, run.agentId);
    assert.equal(s.fake.sent.at(-1)?.text, feedbackText(s.task("TST-FX001")!, "Also cover the logout path", run.branch, false));
    assert.match(s.fake.sent.at(-1)!.text, /^Review feedback from the user on TST-FX001 «Fix flaky login test»:\n\nAlso cover the logout path\n\nAddress it in this worktree on branch feat\/login\. Report again/);

    // The plan's run_branch is anyone's to edit: the agent is told the run's own branch.
    await s.sync().record([{ op_id: "op-review-2", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T11:00:00Z" }]).outcomes;
    await s.settle();
    const loaded = s.sync().plan.entities.get("TST-FX001")!;
    s.sync().plan.entities.set("TST-FX001", { ...loaded, entity: { ...loaded.entity, run_branch: "master" } as typeof loaded.entity });
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url: PR_URL });
    await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "One more thing" });
    assert.match(s.fake.sent.at(-1)!.text, /on branch feat\/login and push to the same branch, so the open PR\/MR is updated/);
    assert.doesNotMatch(s.fake.sent.at(-1)!.text, /master/);

    // Sent, but the move failed: said in note, never in error, which would tell God Mode nothing was sent.
    await s.sync().record([{ op_id: "op-review-3", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T12:00:00Z" }]).outcomes;
    const sync = s.sync();
    const real = sync.record.bind(sync);
    sync.record = () => {
      throw new Error("disk full");
    };
    const stuck = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "And the docs" });
    sync.record = real;
    assert.deepEqual([stuck.ok, stuck.status, stuck.error, s.fake.sent.at(-1)?.text.includes("And the docs")], [true, "review", "", true]);
    assert.match(stuck.note, /^Sent, but the task stays in review: unknown whether it moved: disk full/);

    agent.gone = true;
    const gone = await sendBack(s.ctx, s.dashboard.paseo!, { task: "TST-FX001", comment: "Anything" });
    assert.match(gone.error, /is gone/);
  } finally {
    s.stop();
  }
});

test("accept check: a task in review with its PR/MR's checks, review and holder; anything else is refused with the reason", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    const todo = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => assert.fail("not in review: the forge is not asked"));
    assert.match(todo.error, /is todo, not in review: there is no work to accept\. release_task sets it done anyway/);
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.match((await acceptCheck(s.ctx, { task: "TST-FX001" })).error, /is in_progress, not in review/);
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:00:00Z" }]).outcomes;

    const bare = await acceptCheck(s.ctx, { task: "Fix flaky login" }, async () => assert.fail("no PR/MR: the forge is not asked"));
    assert.deepEqual(acceptCheckRpc.output.parse(bare), bare);
    assert.deepEqual([bare.title, bare.result, bare.agent, bare.error], ["Fix flaky login test", "no PR/MR", "its agent on this Mac is stopped; its chat stays", ""]);
    assert.notEqual(bare.held_by, "");

    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "open", url: PR_URL });
    const before = s.task("TST-FX001");
    const failures = ["lint", "unit", "e2e", "docs"].map((name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE" }));
    const red = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 0, stdout: JSON.stringify(ghView({ statusCheckRollup: failures })) }));
    assert.equal(red.result, "PR #7 open, checks failing (lint, unit, e2e), review changes requested");
    assert.deepEqual(s.task("TST-FX001"), before, "a check writes nothing");
    const undecided = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 0, stdout: JSON.stringify(ghView({ reviewDecision: "" })) }));
    assert.equal(undecided.result, "PR #7 open, checks failing (lint), no review decision");
    const running = [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" }];
    const pending = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 0, stdout: JSON.stringify(ghView({ statusCheckRollup: running })) }));
    assert.equal(pending.result, "PR #7 open, checks pending, review changes requested", "no counts, so a check finishing elsewhere does not change the read-back");
    const green = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 0, stdout: JSON.stringify(ghView({ statusCheckRollup: [], reviewDecision: "APPROVED" })) }));
    assert.equal(green.result, "PR #7 open, no checks, review approved");
    const unread = await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 1, stdout: "" }));
    assert.match(unread.result, /^the PR\/MR https:\/\/github\.com\/acme\/core\/pull\/7 could not be read: gh could not read it/);
    assert.equal(unread.error, "", "an unread forge is said in the read-back, it does not block accepting");

    run.activity = "stopped";
    assert.equal((await acceptCheck(s.ctx, { task: "TST-FX001" }, async () => ({ code: 1, stdout: "" }))).agent, "no agent of it runs on this Mac");

    // Another Mac's run: its agent is not stopped by a release to done.
    const anna = s.task("TST-RD002")!;
    await s.sync().record([{ op_id: "op-anna", kind: "transition", id: "TST-RD002", to: "review", run_id: anna.run_id!, at: "2026-10-26T10:00:00Z" }]).outcomes;
    const away = await acceptCheck(s.ctx, { task: "TST-RD002" }, async () => assert.fail("no PR/MR: the forge is not asked"));
    assert.deepEqual([away.held_by, away.host, away.agent, away.error], ["anna", "anna-mbp", "its agent on anna-mbp keeps running; stop it in its chat if it should", ""]);
  } finally {
    s.stop();
  }
});
