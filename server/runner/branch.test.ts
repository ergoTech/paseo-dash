import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { startCheck } from "../api/reads.ts";
import { projectCheckout, setup } from "../api/testing.ts";
import { releaseTask, startTask } from "../api/writes.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { decideBranch, LookupCache } from "./branch.ts";
import { settled } from "./testing.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const REMOTE = "git@github.com:acme/core.git";

const checkout = projectCheckout;

function forgeWith(prs: { number: number; state: string; mergedAt?: string; headRefName: string }[] | "down"): ForgeCli {
  const gh: CommandRunner = async (_c, args) => {
    if (prs === "down") return { code: 1, stdout: "" };
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(prs.filter((p) => p.headRefName === args[3]).map((p) => ({ ...p, url: `https://github.com/acme/core/pull/${p.number}`, isCrossRepository: false, mergedAt: p.mergedAt ?? null }))) };
    return { code: 1, stdout: "" };
  };
  return new ForgeCli(gh);
}

const base = { id: "TST-FX001", title: "Fix", type: "task", status: "todo", project: "core", depends_on: [], links: [] } as unknown as Task;
const ran = { ...base, run_id: "r-old", run_by: "anna", run_host: "anna-mbp", run_branch: "feat/login", run_ended: "2026-10-26T09:00:00Z" } as Task;
const input = (task: Task, root: string, forge: ForgeCli, extra = {}) => ({ task, planned: "feat/login", root, remote: REMOTE, host: "ergo-mbp", git: systemGit, forge, ...extra });

test("branch decisions: a new task's name must be free; a merged run gets a fresh suffix; a released one continues", async () => {
  const root = checkout(["feat/login-2"], ["feat/other"]);
  assert.deepEqual(await decideBranch(input(base, root, forgeWith([]))), { ok: true, branch: "feat/login", workspace: { kind: "new", action: "branch-off" }, note: "" });
  const taken = await decideBranch(input({ ...base }, checkout([], ["feat/login"]), forgeWith([])));
  assert.match((taken as { error: string }).error, /A branch feat\/login already exists in core \(on origin\) and belongs to no run/);

  const merged = await decideBranch(input(ran, root, forgeWith([{ number: 3, state: "MERGED", mergedAt: "2026-10-26T08:00:00Z", headRefName: "feat/login" }])));
  assert.deepEqual(merged.ok && [merged.branch, merged.workspace], ["feat/login-3", { kind: "new", action: "branch-off" }], "-2 exists, so -3");

  const open = await decideBranch(input(ran, checkout([], ["feat/login"]), forgeWith([{ number: 4, state: "OPEN", headRefName: "feat/login" }])));
  assert.ok(open.ok);
  assert.deepEqual([open.branch, open.workspace, open.continuesPr], ["feat/login", { kind: "new", action: "checkout" }, "https://github.com/acme/core/pull/4"]);
  assert.equal(open.note, "continues anna's released run; #4 stays open; their agent on anna-mbp may still push to it");

  const nowhere = await decideBranch(input(ran, root, forgeWith([])));
  assert.deepEqual(nowhere.ok && nowhere.workspace, { kind: "new", action: "branch-off" }, "never pushed: branch off with the same name");

  const here = { ...ran, run_host: "ergo-mbp" } as Task;
  const reuse = await decideBranch(input(here, root, forgeWith([]), { previous: { workspaceId: "wks_1", agentStatus: "idle" } }));
  assert.deepEqual(reuse.ok && reuse.workspace, { kind: "reuse", workspaceId: "wks_1" });
  const busy = await decideBranch(input(here, root, forgeWith([]), { previous: { workspaceId: "wks_1", agentStatus: "running" } }));
  assert.match((busy as { error: string }).error, /stop the previous run's agent first/);
  const unsure = await decideBranch(input(here, root, forgeWith([]), { previous: { workspaceId: "wks_1", agentStatus: "unknown" } }));
  assert.match((unsure as { error: string }).error, /Cannot tell whether the previous run's agent still works/);

  const unknown = await decideBranch(input(ran, root, forgeWith("down")));
  assert.match((unknown as { error: string }).error, /Cannot tell whether the previous run's PR\/MR on feat\/login was merged/);
});

test("a start that failed before its agent releases itself and starts again on the same branch", async () => {
  let renames = 1;
  const s = await setup({ profiles: [PROFILE], actualBranch: (b) => (renames-- > 0 ? `${b}-1` : b) }, { forge: forgeWith([]) });
  try {
    s.dashboard.projectRoots.set("prj_core", checkout());
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const first = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => first.activity !== "launching");
    assert.equal(first.activity, "failed");
    await settled(() => Boolean(s.task("TST-FX001")?.run_ended));
    assert.equal(s.task("TST-FX001")!.status, "todo");
    await s.sync().sync(); // the release reaches origin before the next claim reads it
    assert.match((await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" })).error, /has no live run; nothing to release/);
    const facts = await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(facts.error, "");
    assert.match(facts.branch, /^feat\/login \(continues .+'s released run\)$/);
    assert.equal(facts.workspace, "a new worktree, «TST-FX001 · Fix flaky login test»", "the stray workspace was archived, so not reused");
    const again = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(again.ok, true, again.error);
    const second = [...s.dashboard.runs!.runs.values()].find((run) => run.run_id === s.task("TST-FX001")!.run_id)!;
    assert.notEqual(second.run_id, first.run_id);
    await settled(() => second.activity !== "launching");
    assert.equal(second.activity, "working", second.error);
    assert.equal(s.task("TST-FX001")!.status, "in_progress");
  } finally {
    s.stop();
  }
});

test("the previous run's workspace on this Mac is reused when it is on the run's branch and its agent rests", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: forgeWith([]) });
  try {
    s.dashboard.projectRoots.set("prj_core", checkout());
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const first = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => first.activity !== "launching");
    const agent = s.fake.agents.get(first.agentId!)!;
    await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" });
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" })).error, /stop the previous run's agent first/, "its agent still works");
    agent.status = "idle";
    const facts = await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(facts.workspace, "the previous run's workspace «TST-FX001 · Fix flaky login test»");
    const again = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(again.ok, true, again.error);
    const second = s.dashboard.runs!.runs.get(s.task("TST-FX001")!.run_id!)!;
    await settled(() => second.activity !== "launching");
    assert.notEqual(second.run_id, first.run_id);
    assert.equal(second.workspaceId, first.workspaceId);
    assert.equal(s.fake.workspaces.size, 1, "no second workspace");
    assert.equal(s.fake.agents.size, 2, "a new agent in the same workspace");
    assert.match(String([...s.fake.agents.values()][1]!.request.prompt), /This branch already has an earlier run's work/);
  } finally {
    s.stop();
  }
});

test("when git or its origin cannot answer, or time runs out, the start is refused, never guessed", async () => {
  const root = checkout();
  const failingRemote = {
    run: async (cwd: string, args: string[], timeoutMs: number) =>
      args[0] === "ls-remote" ? { code: 128, stdout: "", stderr: "fatal: Could not read from remote repository.", timedOut: false } : systemGit.run(cwd, args, timeoutMs),
  };
  const never = await decideBranch({ ...input(base, root, forgeWith([])), git: failingRemote });
  assert.match((never as { error: string }).error, /Cannot tell which branches exist in core/);
  const resumed = await decideBranch({ ...input(ran, root, forgeWith([])), git: failingRemote });
  assert.match((resumed as { error: string }).error, /Cannot tell which branches exist in core/);

  let clock = 0;
  const slowForge = new ForgeCli(async () => {
    clock += 6_000;
    return { code: 0, stdout: "[]" };
  });
  const late = await decideBranch({ ...input(ran, root, slowForge), now: () => clock, deadline: 5_000 });
  assert.match((late as { error: string }).error, /took too long/);
  assert.match(((await decideBranch({ ...input(base, undefined as unknown as string, forgeWith([])) })) as { error: string }).error, /no checkout known/);
});

test("the confirmation's lookups are kept for a minute and shared while under way; a start's own lookups replace them", async () => {
  const root = checkout([], ["feat/other"]);
  let branchesAsked = 0;
  let down = false;
  let pushed = "";
  const counting: GitRunner = {
    run: async (cwd, args, timeoutMs) => {
      if (args[0] !== "ls-remote") return systemGit.run(cwd, args, timeoutMs);
      branchesAsked += 1;
      if (down) return { code: 128, stdout: "", stderr: "fatal: Could not read from remote repository.", timedOut: false };
      const answer = await systemGit.run(cwd, args, timeoutMs);
      return pushed ? { ...answer, stdout: `${answer.stdout}${"0".repeat(40)}\trefs/heads/${pushed}\n` } : answer;
    },
  };
  let prsAsked = 0;
  const forge = new ForgeCli(async () => {
    prsAsked += 1;
    return { code: 0, stdout: "[]" };
  });
  let clock = 0;
  const cache = new LookupCache(60_000, () => clock);
  const shown = { cache, reuseLookups: true };
  const decide = (task: Task, extra = {}) => decideBranch({ ...input(task, root, forge), git: counting, ...extra });

  await Promise.all([decide(base, shown), decide(base, shown)]);
  assert.equal(branchesAsked, 1, "a lookup under way is shared");
  assert.equal((await decide(base, shown)).ok, true);
  assert.equal(branchesAsked, 1, "and kept");

  // Someone pushes the planned branch: the confirmation does not know yet, a start does, and says so next time.
  pushed = "feat/login";
  assert.equal((await decide(base, shown)).ok, true, "a minute's old answer");
  assert.match(((await decide(base, { cache })) as { error: string }).error, /A branch feat\/login already exists/, "a start asks origin again");
  assert.equal(branchesAsked, 2);
  assert.match(((await decide(base, shown)) as { error: string }).error, /already exists/, "and its answer is what the confirmation shows next");
  assert.equal(branchesAsked, 2);
  pushed = "";

  await decide(ran, shown);
  await decide(ran, shown);
  assert.deepEqual([prsAsked, branchesAsked], [1, 2], "the PRs/MRs of the previous run's branch are kept too");

  clock = 60_000;
  await decide(base, shown);
  assert.equal(branchesAsked, 3, "a minute later origin is asked again");

  clock = 120_000;
  down = true;
  assert.match(((await decide(base, shown)) as { error: string }).error, /Cannot tell which branches exist in core/);
  down = false;
  assert.equal((await decide(base, shown)).ok, true, "an answer that could not tell is not kept");
  assert.equal(branchesAsked, 5);
});

test("an older lookup that could not tell does not drop a newer answer", async () => {
  const cache = new LookupCache();
  let answerOld: (value: string | undefined) => void = () => undefined;
  const old = cache.get("k", () => new Promise<string | undefined>((resolve) => (answerOld = resolve)));
  assert.equal(await cache.get("k", async () => "new", true), "new");
  answerOld(undefined);
  assert.equal(await old, undefined);
  assert.equal(await cache.get("k", async () => "read again"), "new");
});

test("a reused workspace found on another branch at launch is left as it is, not archived", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: forgeWith([]) });
  try {
    await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    const first = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => first.activity !== "launching");
    await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" });
    // The plan holds a new run, decided to reuse the old workspace; its branch moved before the launch.
    s.f.external("ergo", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      const text = readFileSync(path, "utf8").replace(/status: todo\n/, "status: in_progress\n").replace(/run_id: .*\n/, "run_id: r-reuse\n").replace(/run_ended: .*\n/, "");
      writeFileSync(path, text);
    });
    await s.sync().sync();
    s.fake.workspaces.get(first.workspaceId!)!.branch = "feat/other";
    const run = s.dashboard.starts!.launch({
      run_id: "r-reuse",
      space: "TST",
      task: "TST-FX001",
      title: "T",
      project: "core",
      projectId: "prj_core",
      branch: "feat/login",
      base: undefined,
      workspace: { kind: "reuse", workspaceId: first.workspaceId! },
      prompt: "P",
      settings: { provider: "claude/claude-haiku-5-5", label: "Review", mode: "", modes: [], asks: false, effort: "", efforts: [] },
      started: "2026-10-26T10:00:00Z",
    });
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "failed", run.error);
    assert.match(run.error ?? "", /the previous run's workspace was left as it is/);
    assert.deepEqual(s.fake.archived, [], "never archived");
  } finally {
    s.stop();
  }
});

test("after a tracked run on the trunk, a start takes a fresh task branch in a new worktree, never the trunk or that checkout", async () => {
  const root = checkout([], ["feat/login"]);
  const onTrunk = { ...ran, run_host: "ergo-mbp", run_branch: "main" } as Task;
  // Its checkout is still open with an idle agent: still not reused, and no forge is asked.
  const previous = { workspaceId: "wks_main", agentStatus: "idle", kind: "local_checkout" };
  const fresh = await decideBranch(input(onTrunk, root, forgeWith("down"), { previous, trunks: ["main"] }));
  assert.ok(fresh.ok);
  assert.deepEqual([fresh.branch, fresh.workspace], ["feat/login-2", { kind: "new", action: "branch-off" }], "feat/login exists, so -2");
  assert.match(fresh.note, /the previous run worked on the trunk main/);
  const free = await decideBranch({ ...input(onTrunk, checkout(), forgeWith("down"), { previous, trunks: ["main"] }), planned: "task/tst-fx001-fix" });
  assert.deepEqual(free.ok && [free.branch, free.workspace], ["task/tst-fx001-fix", { kind: "new", action: "branch-off" }]);

  // A tracked checkout on its own branch continues on it, but in a new worktree, not in the person's checkout.
  const own = { ...ran, run_host: "ergo-mbp", run_branch: "feat/login" } as Task;
  const checkedOut = await decideBranch(input(own, root, forgeWith([]), { previous: { ...previous, kind: "local_checkout" }, trunks: ["main"] }));
  assert.deepEqual(checkedOut.ok && [checkedOut.branch, checkedOut.workspace], ["feat/login", { kind: "new", action: "checkout" }]);
  const worktree = await decideBranch(input(own, root, forgeWith([]), { previous: { ...previous, kind: "worktree" }, trunks: ["main"] }));
  assert.deepEqual(worktree.ok && worktree.workspace, { kind: "reuse", workspaceId: "wks_main" });
});
