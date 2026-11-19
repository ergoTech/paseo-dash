import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../../shared/model.ts";
import { getTask } from "../api/reads.ts";
import { setup } from "../api/testing.ts";
import { startTask } from "../api/writes.ts";
import { FakeHooks, settled } from "../runner/testing.ts";
import { type CommandRunner, ForgeCli, type ForgePr, prUrlOfProject } from "./forge.ts";
import { PrTracker } from "./prs.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const STARTED = "2026-10-26T08:00:00.000Z";
const task = { id: "TST-FX001", type: "task", status: "in_progress", run_id: "r1", run_started: STARTED, run_branch: "feat/login", depends_on: [], links: [] } as unknown as Task;
const pr = (n: number, state: ForgePr["state"], mergedAt?: string): ForgePr => ({ url: `https://github.com/acme/core/pull/${n}`, label: `#${n}`, state, mergedAt, head: "feat/login" });

function decide(t: Task, found: ForgePr[]) {
  const tracker = new PrTracker({ spaces: () => [], runs: () => undefined, projectRoot: () => undefined, forge: new ForgeCli(), now: () => new Date("2026-10-26T12:00:00Z") });
  return tracker.decide(t, found);
}

test("PR rules: first seen open → review once; own merge → done; an earlier merge needs a person", () => {
  const open = decide(task, [pr(7, "open")]);
  assert.deepEqual([open.op?.kind, (open.op as { to: string }).to, (open.op as { run_pr: string }).run_pr], ["transition", "review", pr(7, "open").url]);

  const own = decide({ ...task, status: "review", run_pr: pr(7, "open").url }, [pr(7, "merged", "2026-10-26T11:00:00Z")]);
  assert.deepEqual([(own.op as { to: string }).to, (own.op as { at: string }).at], ["done", "2026-10-26T11:00:00Z"]);

  const seenOpenAgain = decide({ ...task, status: "in_progress", run_pr: pr(7, "open").url }, [pr(7, "open")]);
  assert.equal(seenOpenAgain.op, undefined, "a person moved it back to in_progress: the same open PR does not move it again");

  const laterMerge = decide(task, [pr(8, "merged", "2026-10-26T09:00:00Z")]);
  assert.equal((laterMerge.op as { to: string }).to, "done", "first seen merged, an hour after the run started");
  const earlyMerge = decide(task, [pr(8, "merged", "2026-10-26T08:05:00Z")]);
  assert.equal(earlyMerge.op, undefined, "inside the clock margin");
  assert.match(earlyMerge.view?.note ?? "", /mark the task done/);
  assert.equal(decide(task, [pr(8, "merged")]).op, undefined, "no merge time: never decided alone");

  const replaced = decide({ ...task, run_pr: pr(7, "closed").url }, [pr(9, "open"), pr(7, "closed")]);
  assert.equal((replaced.op as { run_pr: string }).run_pr, pr(9, "open").url);
  const closed = decide({ ...task, run_pr: pr(7, "closed").url }, [pr(7, "closed")]);
  assert.deepEqual([closed.op, closed.view?.note], [undefined, "closed without a merge; the task stays where it is"]);
});

test("PR rules: a draft is not review yet, and a merge with acceptance lines left ends nothing", () => {
  const tracker = new PrTracker({ spaces: () => [], runs: () => undefined, projectRoot: () => undefined, forge: new ForgeCli(), now: () => new Date("2026-10-26T12:00:00Z") });
  const draft = { ...pr(7, "open"), draft: true };

  const firstDraft = tracker.decide(task, [draft]);
  assert.equal(firstDraft.op, undefined, "the agent's draft at its first push moves nothing");
  assert.deepEqual([firstDraft.view?.state, firstDraft.view?.note], ["draft", "a draft; the task moves to review when it is marked ready"]);
  const ready = tracker.decide(task, [pr(7, "open")]);
  assert.equal((ready.op as { to: string }).to, "review", "marked ready: review once");
  const draftAfterClosed = tracker.decide({ ...task, run_pr: pr(6, "closed").url }, [draft, pr(6, "closed")]);
  assert.equal(draftAfterClosed.op, undefined, "a draft does not replace a closed PR either");
  assert.equal(tracker.decide(task, [draft, pr(5, "open")]).op?.kind, "transition", "a ready PR of the branch counts beside a draft");

  const ownMerge = tracker.decide({ ...task, status: "review", run_pr: pr(7, "open").url }, [pr(7, "merged", "2026-10-26T11:00:00Z")], 2);
  assert.equal(ownMerge.op, undefined, "two acceptance lines left: not done");
  assert.match(ownMerge.view?.note ?? "", /merged with 2 acceptance lines not ticked; archive the run's workspace or mark the task done/);
  const firstSeenMerged = tracker.decide(task, [pr(8, "merged", "2026-10-26T09:00:00Z")], 1);
  assert.equal(firstSeenMerged.op, undefined);
  assert.match(firstSeenMerged.view?.note ?? "", /1 acceptance line not ticked/);
  assert.equal((tracker.decide(task, [pr(8, "merged", "2026-10-26T09:00:00Z")], 0).op as { to: string }).to, "done", "all ticked: the merge lands");

  // A follow-up PR on the branch after the recorded one merged: the task follows the follow-up.
  const merged7 = { ...task, status: "review", run_pr: pr(7, "open").url } as Task;
  const followUp = tracker.decide(merged7, [pr(9, "open"), pr(7, "merged", "2026-10-26T11:00:00Z")], 0);
  assert.deepEqual([(followUp.op as { to: string }).to, (followUp.op as { run_pr: string }).run_pr], ["review", pr(9, "open").url], "#9 replaces #7, nothing finishes");
  const followUpDraft = tracker.decide(merged7, [{ ...pr(9, "open"), draft: true }, pr(7, "merged", "2026-10-26T11:00:00Z")], 0);
  assert.deepEqual([followUpDraft.op, followUpDraft.view?.label, followUpDraft.view?.note], [undefined, "#9", "#7 merged earlier; a draft"]);
  assert.equal(tracker.decide({ ...task, status: "review" } as Task, [draft]).view?.note, "a draft", "already in review: no promise of a move");
  const olderOpen = tracker.decide(merged7, [pr(7, "merged", "2026-10-26T11:00:00Z"), pr(5, "open")], 0);
  assert.equal((olderOpen.op as { to: string }).to, "done", "an older open PR of the branch (another base) is not the rest of this run's work");
});

test("PR rules: the run's workspace archived, its own merge finishes the task with lines left, and nothing else does", () => {
  const tracker = new PrTracker({ spaces: () => [], runs: () => undefined, projectRoot: () => undefined, forge: new ForgeCli(), now: () => new Date("2026-10-26T12:00:00Z") });
  const review = { ...task, status: "review", run_pr: pr(7, "open").url } as Task;
  const own = tracker.decide(review, [pr(7, "merged", "2026-10-26T11:00:00Z")], 2, true);
  assert.deepEqual(
    [(own.op as { to: string }).to, (own.op as { at: string }).at, (own.op as { archived?: true }).archived, own.view?.note],
    ["done", "2026-10-26T11:00:00Z", true, undefined],
  );
  const firstSeenMerged = tracker.decide(task, [pr(8, "merged", "2026-10-26T09:00:00Z")], 1, true);
  assert.equal((firstSeenMerged.op as { archived?: true }).archived, true, "first seen merged after the run started: its own");
  const ticked = tracker.decide(review, [pr(7, "merged", "2026-10-26T11:00:00Z")], 0, true);
  assert.equal("archived" in ticked.op!, false, "all ticked: an ordinary done");

  assert.equal(tracker.decide(task, [pr(8, "merged", "2026-10-26T08:05:00Z")], 1, true).op, undefined, "a merge inside the clock margin is not the run's own");
  assert.equal(tracker.decide(task, [{ ...pr(7, "open"), draft: true }], 1, true).op, undefined, "an open draft is not a merge");
  const followUpDraft = tracker.decide(review, [{ ...pr(9, "open"), draft: true }, pr(7, "merged", "2026-10-26T11:00:00Z")], 1, true);
  assert.equal(followUpDraft.op, undefined, "a newer PR of the branch holds the rest of the work");
  assert.equal(tracker.decide({ ...task, run_pr: pr(7, "closed").url }, [pr(7, "closed")], 1, true).op, undefined, "closed is not merged");
});

for (const via of ["poll", "hook"] as const) {
  test(`archiving a run's workspace finishes its own merge with lines left (${via}); a kept workspace, a failed read and another machine's run do not`, async () => {
    const prs = [
      { number: 7, url: "https://github.com/acme/core/pull/7", state: "MERGED", mergedAt: "2026-10-26T10:30:00Z", headRefName: "feat/login", isCrossRepository: false },
      // anna's run on her machine, merged long after it started, with the fixture's line "second" left.
      { number: 8, url: "https://github.com/acme/core/pull/8", state: "MERGED", mergedAt: "2026-10-26T23:00:00Z", headRefName: "feat/login-redesign", isCrossRepository: false },
    ];
    const gh: CommandRunner = async (_command, args) => {
      if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(prs.filter((p) => p.headRefName === args[3])) };
      if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prs.find((p) => p.url === args[2]) ?? {}) };
      return { code: 1, stdout: "" };
    };
    let readFails = false;
    const s = await setup({ profiles: [PROFILE] }, { prs: { forge: new ForgeCli(gh) } });
    const hooks = new FakeHooks(s.fake.api());
    const unhook = s.dashboard.tracker.register(hooks as never);
    try {
      await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
      const run = s.dashboard.runs!.byTask("TST-FX001")!;
      await settled(() => run.activity !== "launching");
      // The run's own PR, recorded while it was open; the fixture's task has the line "second" left.
      await s.sync().record([{ op_id: "op-review", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, run_pr: prs[0]!.url, at: "2026-10-26T10:00:00Z" }]).outcomes;
      await s.dashboard.prs.checkAll();
      assert.equal(s.task("TST-FX001")?.status, "review", "the workspace is kept: the merge waits for the ticks");
      assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /archive the run's workspace or mark the task done/);

      // Paseo cannot be asked: nothing moves.
      const workspaces = s.dashboard.paseo!.workspaces;
      const ref = workspaces.ref.bind(workspaces);
      workspaces.ref = ((id: string) => ({ ...ref(id), refresh: async () => (readFails ? Promise.reject(new Error("daemon away")) : ref(id).refresh()) })) as typeof workspaces.ref;
      s.fake.archived.push(run.workspaceId!);
      readFails = true;
      await s.dashboard.prs.checkAll();
      assert.equal(s.task("TST-FX001")?.status, "review", "a failed read of the workspace never ends a run");
      readFails = false;

      if (via === "hook") await hooks.fire("workspace.archived", { workspace: { id: run.workspaceId, projectId: "prj_core", cwd: "/", name: null, archivedAt: "x" } });
      else await s.dashboard.prs.checkAll();
      await settled(() => s.task("TST-FX001")?.status === "done", 2_000);
      const done = s.task("TST-FX001")!;
      assert.equal(done.run_ended, "2026-10-26T10:30:00Z", "ended at the merge");
      assert.deepEqual(s.sync().plan.entities.get("TST-FX001")!.acceptance.map((line) => line.done), [true, false], "the lines stay as they were");
      await s.dashboard.prs.checkAll();
      assert.equal(s.task("TST-RD002")?.status, "in_progress", "another machine's run cannot be told archived here");
      assert.match(getTask(s.ctx, { task: "TST-RD002" }).pr, /^#8 merged — merged with 1 acceptance line not ticked/);
      assert.deepEqual(s.sync().state.conflicts, []);
    } finally {
      unhook.forEach((off) => off());
      s.stop();
    }
  });
}

test("a workspace Paseo no longer lists counts as archived only once its agent is seen stopped", async () => {
  const s = await setup({ profiles: [PROFILE] });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(await s.dashboard.workspaceArchived(run), false, "listed and not archiving");
    const gone = { ...run, workspaceId: "wks_gone" };
    assert.equal(await s.dashboard.workspaceArchived({ ...gone, activity: "working" }), false, "a listing that misses it alone is not enough");
    assert.equal(await s.dashboard.workspaceArchived({ ...gone, activity: "stopped" }), true);
    s.fake.archived.push(run.workspaceId!);
    assert.equal(await s.dashboard.workspaceArchived(run), true, "archiving");
  } finally {
    s.stop();
  }
});

test("a PR/MR URL counts only for the project's own repository", () => {
  assert.equal(prUrlOfProject("https://github.com/acme/core/pull/7", "git@github.com:acme/core.git"), true);
  assert.equal(prUrlOfProject("https://github.com/evil/core/pull/7", "git@github.com:acme/core.git"), false);
  assert.equal(prUrlOfProject("https://gitlab-ssh.example.com/backend/core/-/merge_requests/412", "git@gitlab-ssh.example.com:backend/core.git"), true);
  assert.equal(prUrlOfProject("http://github.com/acme/core/pull/7", "git@github.com:acme/core.git"), false);
});

test("a live run's PR is followed through gh: a draft waits, ready moves it to review, the merge to done once accepted, and again changes nothing", async () => {
  const prs: { number: number; url: string; state: string; mergedAt: string | null; headRefName: string; isCrossRepository: boolean; isDraft?: boolean; headRefOid?: string }[] = [];
  const calls: string[][] = [];
  // origin's tip of the run's branch, as `git ls-remote` answers; "" while not asked for.
  let tip = "";
  const gh: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") return tip ? { code: 0, stdout: `${tip}\trefs/heads/feat/login\n` } : { code: 1, stdout: "" };
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(prs.filter((p) => p.headRefName === args[3])) };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prs.find((p) => p.url === args[2]) ?? {}) };
    return { code: 1, stdout: "" };
  };
  const s = await setup({ profiles: [PROFILE] }, { prs: { forge: new ForgeCli(gh) } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");

    // The agent reports another repository's PR: ignored.
    run.reportedPr = "https://github.com/evil/core/pull/1";
    await s.dashboard.prs.checkAll();
    assert.equal(s.task("TST-FX001")?.status, "in_progress");
    assert.equal(calls.some((c) => c.includes("https://github.com/evil/core/pull/1")), false, "never asked the CLI about it");

    // A fork's PR with the same branch name comes first and is not the run's.
    prs.push({ number: 6, url: "https://github.com/acme/core/pull/6", state: "OPEN", mergedAt: null, headRefName: "feat/login", isCrossRepository: true });
    await s.dashboard.prs.checkAll();
    assert.equal(s.task("TST-FX001")?.status, "in_progress", "a fork's PR moves nothing");
    prs.push({ number: 7, url: "https://github.com/acme/core/pull/7", state: "OPEN", mergedAt: null, headRefName: "feat/login", isCrossRepository: false, isDraft: true });
    await s.dashboard.prs.checkAll();
    assert.deepEqual([s.task("TST-FX001")?.status, s.task("TST-FX001")?.run_pr], ["in_progress", undefined], "a draft: the agent still works");
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).pr, "#7 draft — a draft; the task moves to review when it is marked ready");
    assert.ok(calls.some((c) => c.includes("number,url,state,mergedAt,headRefName,headRefOid,createdAt,isCrossRepository,isDraft")), "gh is asked for the draft flag, the head commit and the creation time");
    prs[1]!.isDraft = false;
    await s.dashboard.prs.checkAll();
    assert.deepEqual([s.task("TST-FX001")?.status, s.task("TST-FX001")?.run_pr], ["review", "https://github.com/acme/core/pull/7"]);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).pr, "#7 open");
    assert.ok(s.task("TST-FX001")?.run_review_at, "the move to review is dated, so Live lists the longest waiting first");

    // The fixture's task has one acceptance line left ("second"): the merge alone does not finish it.
    prs[1]!.state = "MERGED";
    prs[1]!.mergedAt = "2026-10-26T10:30:00Z";
    await s.dashboard.prs.checkAll();
    assert.equal(s.task("TST-FX001")?.status, "review");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /^#7 merged — merged with 1 acceptance line not ticked/);
    // A done decided on an older copy of the plan is refused by the plan itself.
    const stale = s.sync().record([{ op_id: "op-stale-done", kind: "transition", id: "TST-FX001", to: "done", run_id: run.run_id, run_pr: prs[1]!.url, at: "2026-10-26T10:30:00Z" }]);
    assert.equal((await stale.outcomes).get("op-stale-done")?.status, "dropped");
    assert.equal(s.task("TST-FX001")?.status, "review");

    // The last line ticked, but the branch got commits after the merge: not done yet.
    prs[1]!.headRefOid = "a".repeat(40);
    tip = "b".repeat(40);
    await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-FX001", line: "second", done: true, run_id: run.run_id }]).outcomes;
    await s.dashboard.prs.checkAll();
    assert.equal(s.task("TST-FX001")?.status, "review");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /commits pushed after #7, without a new PR\/MR/);
    // Nothing after the merge: the next check finishes the task with the merge's time.
    tip = "a".repeat(40);
    await s.dashboard.prs.checkAll();
    const done = s.task("TST-FX001")!;
    assert.deepEqual([done.status, done.run_ended], ["done", "2026-10-26T10:30:00Z"]);
    const before = s.sync().plan.entities.get("TST-FX001")!.entity.updated;
    await s.dashboard.prs.checkAll();
    assert.equal(s.sync().plan.entities.get("TST-FX001")!.entity.updated, before, "an ended run is not checked again");
    assert.deepEqual(s.sync().state.conflicts, []);
  } finally {
    s.stop();
  }
});

test("glab's merge requests read as open, merged and closed with their merge time, newest first", async () => {
  const remote = "git@gitlab-ssh.example.com:frontend/site.git";
  const glab: CommandRunner = async (command, args) => {
    if (command === "glab" && args[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify([
          { iid: 930, web_url: "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/930", state: "closed", merged_at: null, source_branch: "feat/x", source_project_id: 4, target_project_id: 4 },
          { iid: 935, web_url: "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/935", state: "merged", merged_at: "2026-10-26T08:21:43.811Z", source_branch: "feat/x", source_project_id: 4, target_project_id: 4, sha: "d".repeat(40), created_at: "2026-10-25T08:00:00.000Z" },
          { iid: 940, web_url: "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/940", state: "opened", merged_at: null, source_branch: "feat/other", source_project_id: 4, target_project_id: 4 },
          { iid: 945, web_url: "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/945", state: "opened", merged_at: null, source_branch: "feat/x", source_project_id: 77, target_project_id: 4 },
          { iid: 950, web_url: "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/950", state: "opened", merged_at: null, source_branch: "feat/x", source_project_id: 4, target_project_id: 4, draft: true },
        ]),
      };
    if (command === "glab" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ iid: Number(args[2]), web_url: `https://gitlab-ssh.example.com/frontend/site/-/merge_requests/${args[2]}`, state: "opened", source_branch: "feat/x", source_project_id: 4, target_project_id: 4 }) };
    return { code: 1, stdout: "" };
  };
  const forge = new ForgeCli(glab);
  const listed = await forge.byBranch("/tmp", remote, "feat/x");
  assert.deepEqual(listed?.map((m) => [m.label, m.state, m.mergedAt ?? null, m.draft ?? false]), [
    ["!950", "open", null, true],
    ["!935", "merged", "2026-10-26T08:21:43.811Z", false],
    ["!930", "closed", null, false],
  ]);
  assert.deepEqual([listed?.[1]?.headSha, listed?.[1]?.createdAt], ["d".repeat(40), "2026-10-25T08:00:00.000Z"], "the merged head and the creation time");
  assert.equal((await forge.byUrl("/tmp", remote, "https://gitlab-ssh.example.com/frontend/site/-/merge_requests/950"))?.label, "!950");
  assert.equal(await forge.byUrl("/tmp", remote, "https://gitlab-ssh.example.com/other/site/-/merge_requests/950"), undefined);
  assert.equal(await new ForgeCli(async () => ({ code: 1, stdout: "" })).byBranch("/tmp", remote, "feat/x"), undefined, "no CLI: cannot tell");
});

test("no pass runs before the checkouts are known, the first peek after runs at once, and later peeks only when the last pass is old", async () => {
  let lists = 0;
  let known = false;
  const gh: CommandRunner = async (_command, args) => {
    if (args[1] === "list") lists += 1;
    return { code: 0, stdout: "[]" };
  };
  const s = await setup({ profiles: [PROFILE] }, { prs: { forge: new ForgeCli(gh), ready: () => known } });
  const passing = () => (s.dashboard.prs as unknown as { checking: boolean }).checking;
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    await settled(() => s.dashboard.runs!.byTask("TST-FX001")!.activity !== "launching");
    await s.dashboard.prs.checkAll();
    s.dashboard.prs.peek(60_000);
    assert.deepEqual([lists, passing()], [0, false], "the checkouts are not known: no pass, and none counts as fresh");

    known = true;
    s.dashboard.prs.peek(60_000);
    // Both live runs of the fixture (this machine's and anna's) are checked in the pass.
    await settled(() => lists === 2 && !passing(), 1_000);
    s.dashboard.prs.peek(60_000);
    assert.equal(lists, 2, "the last pass is fresh: no new one");
    s.dashboard.prs.peek(0);
    await settled(() => lists === 4 && !passing(), 1_000);
    s.dashboard.prs.stop();
    s.dashboard.prs.peek(0);
    assert.equal(lists, 4, "a stopped tracker does not peek");
  } finally {
    s.stop();
  }
});

test("one check per task at a time: requests meanwhile run it once more, and stop ends the CLIs", async () => {
  let release: () => void = () => undefined;
  const signals: (AbortSignal | undefined)[] = [];
  let lists = 0;
  const gh: CommandRunner = async (_command, args, _cwd, _timeout, signal) => {
    signals.push(signal);
    if (args[1] !== "list") return { code: 1, stdout: "" };
    lists += 1;
    if (lists === 1) await new Promise<void>((resolve) => (release = resolve));
    return { code: 0, stdout: "[]" };
  };
  const s = await setup({ profiles: [PROFILE] }, { prs: { forge: new ForgeCli(gh) } });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    const entry = { sync: s.sync(), mapping: { core: "prj_core" } };
    const first = s.dashboard.prs.check(entry, s.task("TST-FX001")!);
    await settled(() => lists === 1, 1_000);
    await Promise.all([s.dashboard.prs.check(entry, s.task("TST-FX001")!), s.dashboard.prs.check(entry, s.task("TST-FX001")!)]);
    release();
    await first;
    assert.equal(lists, 2, "the two requests made while it ran became one more check");
    const signal = signals[0]!;
    s.dashboard.prs.stop();
    assert.equal(signal.aborted, true, "stop aborts the CLI processes started before it");
  } finally {
    s.stop();
  }
});

test("PR rules: a merge with commits pushed to its branch after it holds; an earlier run's open PR waits for the agent", () => {
  const tracker = new PrTracker({ spaces: () => [], runs: () => undefined, projectRoot: () => undefined, forge: new ForgeCli(), now: () => new Date("2026-10-26T12:00:00Z") });
  const merged = { ...pr(7, "merged", "2026-10-26T11:00:00Z"), headSha: "a".repeat(40) };
  const own = { ...task, status: "review", run_pr: merged.url } as Task;
  // The branch moved on after the merge: that work is not in the trunk.
  const held = tracker.decide(own, [merged], 0, false, "b".repeat(40));
  assert.equal(held.op, undefined);
  assert.match(held.view?.note ?? "", /commits pushed after #7, without a new PR\/MR/);
  // The branch where the merge left it, deleted after it, or not readable: done.
  for (const tip of ["a".repeat(40), "", undefined]) assert.deepEqual(tracker.decide(own, [merged], 0, false, tip).op?.kind, "transition");
  // Its workspace archived: the person ended the run, whatever the branch holds.
  assert.equal(tracker.decide(own, [merged], 0, true, "b".repeat(40)).op?.kind, "transition");

  // Started again on a branch whose PR an earlier run opened: no review before the agent's own report.
  const earlier = { ...pr(9, "open"), createdAt: "2026-10-25T09:00:00Z" };
  // A tracked workspace's own PR/MR opened before it was tracked: it moves the task as always.
  assert.equal(tracker.decide(task, [earlier], 0, false, undefined, true).op?.kind, "transition");
  // Within the clock margin of the start: this run's own.
  assert.equal(tracker.decide(task, [{ ...earlier, createdAt: "2026-10-26T07:55:00Z" }]).op?.kind, "transition");
  const waiting = tracker.decide(task, [earlier]);
  assert.equal(waiting.op, undefined);
  assert.match(waiting.view?.note ?? "", /open since an earlier run/);
  assert.equal(tracker.decide(task, [{ ...earlier, createdAt: "2026-10-26T09:00:00Z" }]).op?.kind, "transition", "opened by this run: review");
  assert.equal(tracker.decide({ ...task, status: "review" } as Task, [earlier]).op?.kind, "transition", "in review by the agent's report: the PR is recorded");
});

test("a branch's tip on origin: its commit, empty when the branch is gone, unknown when git fails", async () => {
  const sha = "c".repeat(40);
  const answers: Record<string, { code: number; stdout: string }> = {
    "feat/a": { code: 0, stdout: `${sha}\trefs/heads/feat/a\n` },
    "feat/gone": { code: 0, stdout: "" },
    "feat/err": { code: 128, stdout: "" },
  };
  const calls: string[][] = [];
  const forge = new ForgeCli(async (command, args) => {
    calls.push([command, ...args]);
    return answers[args[2]!.replace("refs/heads/", "")] ?? { code: 1, stdout: "" };
  });
  assert.equal(await forge.branchTip("/x", "feat/a"), sha);
  assert.equal(await forge.branchTip("/x", "feat/gone"), "");
  assert.equal(await forge.branchTip("/x", "feat/err"), undefined);
  assert.deepEqual(calls[0], ["git", "ls-remote", "origin", "refs/heads/feat/a"]);
});
