import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { runWorkspaces } from "./activity.ts";
import { trackWorkspace } from "./adopt.ts";
import type { RpcOutput } from "@getpaseo/plugin";
import type { activityTrackRpc } from "../shared/activity.ts";
import { setup } from "./api/testing.ts";
import { releaseTask, startTask } from "./api/writes.ts";
import { sendBack } from "./result.ts";
import { RunStore } from "./runner/runs.ts";
import { FakeHooks, settled } from "./runner/testing.ts";
import { type CommandRunner, ForgeCli } from "./tracker/forge.ts";
import { taskView } from "./views.ts";
import { readOverview } from "./overview.ts";

/** "Track as task" (05-architecture.md, Tracking a Paseo workspace as a task) against a real plan repo and a faked forge. */

type Track = RpcOutput<typeof activityTrackRpc>;

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

type Pr = { number: number; url: string; state: string; mergedAt: string | null; headRefName: string; isCrossRepository: boolean };

function fakeGh(prs: Pr[], calls: string[][] = []): ForgeCli {
  const gh: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(prs.filter((p) => p.headRefName === args[3])) };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prs.find((p) => p.url === args[2]) ?? {}) };
    return { code: 1, stdout: "" };
  };
  return new ForgeCli(gh);
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

test("a worktree with an open PR becomes a task that goes to review, and to done on its merge; tracking it again opens that task", async () => {
  // Opened long before the workspace is tracked, as a tracked PR usually is.
  const prs: Pr[] = [{ number: 9, url: "https://github.com/acme/core/pull/9", state: "OPEN", mergedAt: null, headRefName: "feat/own", isCrossRepository: false, createdAt: "2026-10-01T09:00:00Z" } as Pr];
  const forge = fakeGh(prs);
  const s = await setup({ profiles: [PROFILE] }, { prs: { forge }, forge });
  try {
    s.fake.addOwn({ id: "wks_own", projectId: "prj_core", branch: "feat/own", kind: "worktree", directory: "/tmp/own", name: "core: own work", agent: { id: "agent-own", status: "idle" } });
    // Two taps at once: one task; the second hears it is the existing one.
    const [answer, racing] = (await Promise.all([1, 2].map(() => trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_own" })))) as [Track, Track];
    assert.deepEqual([answer.ok, answer.existing, answer.kind, answer.error], [true, false, "branch", ""]);
    assert.deepEqual([racing.ok, racing.existing, racing.id], [true, true, answer.id]);
    const run = s.dashboard.runs!.byTask(answer.id)!;
    assert.deepEqual([run.claim, run.workspaceId, run.agentId, run.adopted?.kind, run.attempts.length], ["won", "wks_own", "agent-own", "worktree", 0]);
    const file = await s.remoteFile(new RegExp(answer.id));
    assert.match(file ?? "", /run_branch: feat\/own/);
    assert.match(file ?? "", /run_host: ergo-mbp/);
    assert.match(file ?? "", /title: "?core: own work"?/);
    assert.equal(s.fake.calls.length, 0, "nothing was created in Paseo");

    // Tracking checks the PR/MR in the background already; a pass meanwhile only asks for one more.
    await s.dashboard.prs.checkAll();
    await settled(() => s.task(answer.id)?.status === "review");
    assert.deepEqual([s.task(answer.id)?.status, s.task(answer.id)?.run_pr], ["review", prs[0]!.url]);
    const view = taskView(s.dashboard, { task: answer.id }, s.ctx.now!());
    assert.equal(view.run?.tracked?.kind, "branch");
    assert.match(view.run?.tracked?.note ?? "", /no Paseo Dash tools/);

    // The same workspace again: the task it already is, also after a restart of the run store.
    const again = await trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_own" });
    assert.deepEqual([again.ok, again.existing, again.id], [true, true, answer.id]);
    assert.ok(runWorkspaces(s.dashboard).has("wks_own"), "no longer listed as work outside the plan");
    const reloaded = new RunStore(join(s.dashboard.dataDir, "runs.json"));
    assert.deepEqual([reloaded.byAgent("agent-own")?.run_id, reloaded.runs.get(run.run_id)?.adopted?.kind], [run.run_id, "worktree"], "an adopted run survives a restart");

    // The tracker follows the adopted agent like a started one.
    const hooks = new FakeHooks(s.fake.api());
    s.dashboard.tracker.register(hooks as unknown as PluginLifecycleRegistration);
    await hooks.fire("agent.turn_started", { agent: { id: "agent-own" } });
    assert.equal(run.activity, "working");

    prs[0]!.state = "MERGED";
    prs[0]!.mergedAt = "2026-10-26T10:30:00Z";
    await s.dashboard.prs.checkAll();
    await settled(() => s.task(answer.id)?.status === "done");
    assert.deepEqual([s.task(answer.id)?.status, s.task(answer.id)?.run_ended], ["done", "2026-10-26T10:30:00Z"]);
    assert.deepEqual(s.sync().state.conflicts, []);
    // Its run over, the workspace is Paseo work again: tracked anew it becomes a new task.
    assert.ok(!runWorkspaces(s.dashboard).has("wks_own"), "listed again as work outside the plan");
    const later = await trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_own" });
    assert.deepEqual([later.ok, later.existing], [true, false], later.error);
    assert.notEqual(later.id, answer.id);
    // The same agent now works for the new run: its hooks go to it, and the ended run stops nothing.
    const fresh = s.dashboard.runs!.byTask(later.id)!;
    assert.equal(fresh.agentId, "agent-own");
    assert.equal(s.dashboard.runs!.byAgent("agent-own"), fresh);
    await hooks.fire("agent.turn_started", { agent: { id: "agent-own" } });
    assert.equal(fresh.activity, "working");
    assert.equal(await s.dashboard.stopAgentOf(run), "", "the ended run's agent is the live run's now");
  } finally {
    s.stop();
  }
});

test("a tracked workspace whose agent asks questions reads as question from the start", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: fakeGh([]), prs: { forge: fakeGh([]) } });
  try {
    s.fake.addOwn({ id: "wks_ask", projectId: "prj_core", branch: "feat/ask", kind: "worktree", directory: "/tmp/ask", name: "core: asks", agent: { id: "agent-ask", status: "running" } });
    const questions = [{ header: "Release", question: "Ship it today?", options: [{ label: "Yes" }, { label: "No" }] }];
    s.fake.agents.get("agent-ask")!.pendingPermissions = [{ name: "AskUserQuestion", kind: "question", input: { questions } }];
    const answer = (await trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_ask" })) as Track;
    assert.equal(answer.error, "");
    const run = s.dashboard.runs!.byTask(answer.id)!;
    assert.deepEqual([run.activity, run.waitingFor, run.waitingKind], ["needs_input", "Release: Ship it today?", "question"]);
    assert.deepEqual(readOverview(s.dashboard, {}).needs_you.find((n) => n.task === answer.id)?.kind, "question");
  } finally {
    s.stop();
  }
});

test("only an open workspace of the line's own Paseo project on a branch is tracked", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: fakeGh([]), prs: { forge: fakeGh([]) } });
  try {
    s.fake.addOwn({ id: "wks_other", projectId: "prj_site", branch: "feat/x", kind: "worktree", directory: "/tmp/x", name: "site" });
    s.fake.addOwn({ id: "wks_detached", projectId: "prj_core", branch: "", kind: "worktree", directory: "/tmp/d", name: "core" });
    s.fake.addOwn({ id: "wks_gone", projectId: "prj_core", branch: "feat/g", kind: "worktree", directory: "/tmp/g", name: "core" });
    s.fake.archived.push("wks_gone");
    const track = (workspace_id: string) => trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id });
    assert.match((await track("wks_other")).error, /not in the Paseo project core maps to/);
    assert.match((await track("wks_detached")).error, /not on a branch/);
    assert.match((await track("wks_gone")).error, /not open in Paseo/);
    assert.match((await track("wks_none")).error, /not open in Paseo/);
    assert.equal(s.dashboard.runs!.runs.size, 0, "nothing stored for a refusal");
  } finally {
    s.stop();
  }
});

test("a trunk checkout shows landed only once its commits are pushed and its tree is clean; archived and landed offers mark done; the next start never uses the trunk", async () => {
  const calls: string[][] = [];
  const forge = fakeGh([], calls);
  const s = await setup({ profiles: [PROFILE] }, { forge, prs: { forge } });
  try {
    const root = s.dashboard.projectRoots.get("prj_core")!;
    git(root, "commit", "--quiet", "--allow-empty", "-m", "local work");
    s.fake.addOwn({ id: "wks_trunk", projectId: "prj_core", branch: "main", kind: "local_checkout", directory: root, name: "core", agent: { id: "agent-trunk", status: "running" } });
    const answer = await trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_trunk" });
    assert.deepEqual([answer.ok, answer.kind], [true, "trunk"]);
    const run = s.dashboard.runs!.byTask(answer.id)!;
    assert.equal(run.adopted?.trunk, "main");
    const landed = async () => {
      await s.dashboard.refreshLanded(run);
      return taskView(s.dashboard, { task: answer.id }, s.ctx.now!());
    };

    let view = await landed();
    assert.match(view.run?.tracked?.landed ?? "", /^not landed: HEAD is not on origin\/main yet/);
    assert.equal(view.actions.landed_done, false);

    git(root, "push", "--quiet", "origin", "HEAD:main");
    writeFileSync(join(root, "scratch.txt"), "not committed\n");
    view = await landed();
    assert.match(view.run?.tracked?.landed ?? "", /uncommitted changes/, "pushed, but the tree is not clean");

    execFileSync("rm", [join(root, "scratch.txt")]);
    view = await landed();
    assert.equal(view.run?.tracked?.landed, "landed on origin/main");
    assert.equal(view.actions.landed_done, false, "still open in Paseo: done is offered once it is archived");

    s.fake.archived.push("wks_trunk");
    view = await landed();
    assert.deepEqual([view.run?.tracked?.archived, view.actions.landed_done, s.task(answer.id)?.status], [true, true, "in_progress"], "offered, never done by itself");
    // The person's checkout outlives the archive; work after it is not this run's.
    git(root, "commit", "--quiet", "--allow-empty", "-m", "later, other work");
    view = await landed();
    assert.equal(view.run?.tracked?.landed, "landed on origin/main", "the HEAD read when it was archived stands");

    // Another machine knows the run only from the plan, maybe without a trunk in space.yaml: the
    // task's base names the trunk, so no PR/MR is looked for there either.
    assert.equal(s.task(answer.id)?.base, "main");
    await s.settle();
    const core = s.sync().plan.space!.projects.core!;
    const trunk = core.trunk;
    core.trunk = undefined;
    s.dashboard.runs!.runs.delete(run.run_id);
    try {
      await s.dashboard.prs.checkAll();
    } finally {
      core.trunk = trunk;
      s.dashboard.runs!.runs.set(run.run_id, run);
    }

    await s.dashboard.prs.checkAll();
    assert.deepEqual(calls.filter((c) => c.includes("main")), [], "no PR/MR is looked for on the trunk");
    assert.ok(calls.length > 0, "other live runs were checked");

    // Released, the task starts again on a fresh task branch in a new worktree, never on main.
    assert.equal((await releaseTask(s.ctx, { task: answer.id, to: "todo" })).ok, true);
    const started = await startTask(s.ctx, { task: answer.id, profile: "Review" });
    assert.equal(started.ok, true, started.error);
    assert.match(started.branch, /^task\//);
    // The test clock stands still, so the new run is found by the plan's run id, not by its start time.
    const next = s.dashboard.runs!.runs.get(s.task(answer.id)!.run_id!)!;
    assert.notEqual(next.run_id, run.run_id);
    await settled(() => next.activity !== "launching");
    const source = next.attempts[0]!.workspaceRequest.source as { action: string; branchName: string };
    assert.deepEqual([source.action, source.branchName], ["branch-off", started.branch]);
    assert.notEqual(next.workspaceId, "wks_trunk", "the person's checkout is never handed to the new agent");
    assert.equal(s.task(answer.id)?.run_branch, started.branch);
  } finally {
    s.stop();
  }
});

test("send back on a tracked workspace only sends the comment: its agent cannot report again, so the task stays in review", async () => {
  const prs: Pr[] = [{ number: 9, url: "https://github.com/acme/core/pull/9", state: "OPEN", mergedAt: null, headRefName: "feat/own", isCrossRepository: false }];
  const forge = fakeGh(prs);
  const s = await setup({ profiles: [PROFILE] }, { prs: { forge }, forge });
  try {
    s.fake.addOwn({ id: "wks_own", projectId: "prj_core", branch: "feat/own", kind: "local_checkout", directory: "/tmp/own", name: "core", agent: { id: "agent-own", status: "idle" } });
    const answer = await trackWorkspace(s.ctx, { space: "TST", project: "core", workspace_id: "wks_own" });
    await s.dashboard.prs.checkAll();
    await settled(() => s.task(answer.id)?.status === "review");
    assert.equal(s.task(answer.id)?.status, "review");

    const sent = await sendBack(s.ctx, s.dashboard.paseo!, { task: answer.id, comment: "Cover the logout path" });
    assert.deepEqual([sent.ok, sent.status, sent.error, s.task(answer.id)?.status], [true, "review", "", "review"]);
    const text = s.fake.sent.at(-1)!;
    assert.equal(text.agentId, "agent-own");
    assert.match(text.text, /Address it in this workspace on branch feat\/own and push to the same branch/);
    assert.doesNotMatch(text.text, /worktree|Report again/);

    // The merge of its PR/MR still finishes it.
    prs[0]!.state = "MERGED";
    prs[0]!.mergedAt = "2026-10-26T10:30:00Z";
    await s.dashboard.prs.checkAll();
    await settled(() => s.task(answer.id)?.status === "done");
    assert.equal(s.task(answer.id)?.status, "done");
  } finally {
    s.stop();
  }
});
