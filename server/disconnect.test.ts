import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dashboard } from "./dashboard.ts";
import { readOverview } from "./overview.ts";
import { readMap } from "./map/read.ts";
import { listSpaces } from "./spaces/list.ts";
import { getTask } from "./api/reads.ts";
import { startTask, updateTask } from "./api/writes.ts";
import { NOW, setup } from "./api/testing.ts";
import type { RunRecord } from "./runner/runs.ts";
import { type GitResult, type GitRunner, systemGit } from "./sync/git.ts";
import type { Operation } from "./sync/ops.ts";
import { sh } from "./sync/testing.ts";

/** Disconnecting a space (05-architecture.md, Disconnecting a space). */

const HOST = "ergo-mbp";

/** Git that can hold the next call matching a test, until the test lets it go (or answers for it). */
function gatedGit() {
  let gate: { match: (args: string[]) => boolean; reached: () => void; open: Promise<GitResult | undefined> } | undefined;
  const runner: GitRunner = {
    async run(cwd, args, timeoutMs) {
      const held = gate;
      if (held?.match(args)) {
        gate = undefined;
        held.reached();
        const answer = await held.open;
        if (answer) return answer;
      }
      return systemGit.run(cwd, args, timeoutMs);
    },
  };
  const hold = (match: (args: string[]) => boolean) => {
    let release!: (answer?: GitResult) => void;
    let reached!: () => void;
    const open = new Promise<GitResult | undefined>((resolve) => (release = resolve));
    const hit = new Promise<void>((resolve) => (reached = resolve));
    gate = { match, reached, open };
    return { hit, release };
  };
  return { runner, hold };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached in time");
}

/** Every ref of the remote and every file of its default branch. */
function remoteState(remote: string): string {
  return `${sh(remote, "for-each-ref")}\n${sh(remote, "ls-tree", "-r", "main")}`;
}

function runRecord(run_id: string, space: string, task: string, state: RunRecord["attempts"][number]["state"], claim: RunRecord["claim"] = "won"): RunRecord {
  return {
    run_id,
    space,
    task,
    project: "core",
    projectId: "prj_core",
    branch: `task/${run_id}`,
    started: NOW.toISOString(),
    attempts: [{ n: 1, key: `dashboard:${run_id}:1`, workspaceRequest: {}, agentRequest: {}, state }],
    claim,
    activity: state === "done" ? "stopped" : "launching",
    activityAt: NOW.toISOString(),
  };
}

const labelOp = (op_id: string, label = "urgent"): Operation => ({ op_id, kind: "label", id: "TST-FX001", label, add: true });

test("a space with nothing pending disconnects, leaves every list, and connects again afresh", async () => {
  const s = await setup();
  try {
    await s.sync().sync();
    const before = remoteState(s.f.remote);
    s.dashboard.runs!.put(runRecord("r-old", "TST", "TST-TASK1", "done"));
    s.dashboard.runs!.put(runRecord("r-other", "OTH", "OTH-TASK1", "done"));

    assert.deepEqual(await s.dashboard.removeSpace("tst", HOST), { key: "TST" });
    assert.equal(readOverview(s.dashboard, {}).spaces.length, 0);
    assert.deepEqual(listSpaces(s.dashboard).spaces, []);
    assert.match(readMap(s.dashboard, { space: "TST" }).error, /No space TST/);
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).error, /No task TST-FX001/);
    assert.equal(remoteState(s.f.remote), before, "the plan repository is not touched");
    assert.equal(existsSync(join(s.dashboard.dataDir, "spaces", "TST")), false, "the clone and the journal are deleted");
    assert.doesNotMatch(readFileSync(join(s.dashboard.dataDir, "spaces.json"), "utf8"), /"TST"/);
    assert.deepEqual([...s.dashboard.runs!.runs.keys()], ["r-other"], "the space's finished run records go, others stay");
    await assert.rejects(s.dashboard.removeSpace("TST", HOST), /no space TST is connected/);

    const restarted = new Dashboard({ dataDir: s.dashboard.dataDir });
    s.stop();
    await restarted.start();
    try {
      assert.equal(restarted.spaces.size, 0, "a restart does not bring it back");
      assert.deepEqual(await restarted.addSpace({ remote: s.f.remote }), { key: "TST" });
      const sync = restarted.spaces.get("TST")!.sync;
      assert.equal(sync.journalEntries.length, 0);
      assert.equal(sync.plan.entities.get("TST-FX001")?.entity.title, "Fix flaky login test");
    } finally {
      restarted.stop();
    }
  } finally {
    s.stop();
  }
});

test("a disconnect is refused while changes are pending, a run of this machine holds a task, or a start is unfinished", async () => {
  const s = await setup();
  const aside = `${s.f.remote}.aside`;
  try {
    await s.sync().sync();
    // The remote is gone: the change cannot be pushed, and nothing is discarded.
    renameSync(s.f.remote, aside);
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", priority: "high" })).ok, true);
    await s.sync().sync();
    await assert.rejects(
      s.dashboard.removeSpace("TST", HOST),
      /Test space \(TST\) was not disconnected: 1 change \(priority of TST-FX001\) cannot be pushed: the plan repository .* could not be reached \(.*\); restore access/,
    );
    assert.ok(s.dashboard.spaces.has("TST"));
    renameSync(aside, s.f.remote);
    await s.sync().sync();
    assert.equal(s.sync().journalEntries.length, 0);

    // A live run of this machine, here only in the plan (its record is gone).
    const started = new Date(2026, 9, 26, 9, 0).toISOString();
    const edit = (extra: string) =>
      s.f.external("ergo", (root) => {
        const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
        writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", `status: in_progress\nrun_id: r-here\nrun_by: ergo\nrun_host: ${HOST}\nrun_branch: feat/login\nrun_started: ${started}\n${extra}`));
      });
    edit("");
    await s.sync().sync();
    await assert.rejects(s.dashboard.removeSpace("TST", HOST), /TST-FX001 «Fix flaky login test» has a live run on this machine; release it/);
    assert.equal(await s.dashboard.removeSpace("TST", "anna-mbp").then(() => "removed", () => "refused"), "refused", "TST-RD002 runs on anna-mbp");

    // Run records whose start is not finished, or whose claim is not decided.
    s.dashboard.runs!.put(runRecord("r-making", "TST", "TST-TASK2", "workspace"));
    await assert.rejects(s.dashboard.removeSpace("TST", "elsewhere"), /the start of TST-TASK2 «two» is still creating its workspace or agent/);
    s.dashboard.runs!.remove("r-making");
    s.dashboard.runs!.put(runRecord("r-maybe", "TST", "TST-TASK2", "pending", "undecided"));
    await assert.rejects(s.dashboard.removeSpace("TST", "elsewhere"), /whether the start of TST-TASK2 «two» landed is not decided yet/);
    s.dashboard.runs!.remove("r-maybe");
    assert.deepEqual(await s.dashboard.removeSpace("TST", "elsewhere"), { key: "TST" });
  } finally {
    if (existsSync(aside)) renameSync(aside, s.f.remote);
    s.stop();
  }
});

test("a claim left undecided by a restart refuses the disconnect", async () => {
  const s = await setup();
  await s.sync().sync();
  s.stop();
  const journal = join(s.dashboard.dataDir, "spaces", "TST", "journal.json");
  const run = { run_id: "r-cut", run_by: "ergo", run_host: HOST, run_branch: "task/one", run_started: NOW.toISOString() };
  writeFileSync(journal, JSON.stringify({ version: 1, entries: [{ op: { op_id: "op_cut", kind: "claim", id: "TST-TASK1", run }, inflight: true }], abandonedClaims: [] }));
  const restarted = new Dashboard({ dataDir: s.dashboard.dataDir, fetchIntervalMs: 3_600_000 });
  try {
    await restarted.start();
    await assert.rejects(restarted.removeSpace("TST", "elsewhere"), /whether the start of TST-TASK1 «one» landed is not decided yet; wait for the next syncs/);
    assert.ok(restarted.spaces.has("TST"));
  } finally {
    restarted.stop();
  }
});

test("a write journaled before the disconnect reaches the queue makes it refuse, and the space stays in its place", async () => {
  const git = gatedGit();
  const s = await setup(undefined, { runner: git.runner });
  try {
    const other = join(mkdtempSync(join(tmpdir(), "dashboard-remote-")), "other.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", other]);
    await s.dashboard.addSpace({ remote: other, key: "OTH", name: "Other" });
    await s.sync().sync();
    const entry = s.dashboard.spaces.get("TST")!;
    // The fetch loop's pass is in the queue, waiting for a fetch that will fail.
    const held = git.hold((args) => args[0] === "fetch");
    const busy = entry.sync.sync();
    await held.hit;
    const removing = s.dashboard.removeSpace("TST", HOST);
    await until(() => !s.dashboard.spaces.has("TST"));
    // A caller that resolved the space before its removal writes now; nothing can push it.
    const write = entry.sync.record([labelOp("op_race")]);
    await assert.rejects(s.dashboard.addSpace({ remote: s.f.remote }), /space TST is being disconnected/);
    await assert.rejects(s.dashboard.removeSpace("TST", HOST), /space TST is being disconnected already/);
    held.release({ code: 128, stdout: "", stderr: "fatal: could not read from remote repository", timedOut: false });
    await busy;
    await assert.rejects(removing, /1 change \(label of TST-FX001\) cannot be pushed: the plan repository .* could not be reached \(fatal: could not read from remote repository\)/);
    assert.equal(s.dashboard.spaces.get("TST"), entry, "the space is back");
    assert.deepEqual([...s.dashboard.spaces.keys()], ["TST", "OTH"], "in its place");
    assert.equal((await write.outcomes).get("op_race")?.status, "applied");
    assert.match((await s.remoteFile(/TST-FX001-/)) ?? "", /urgent/, "the next sync pushes it");
    assert.deepEqual(await s.dashboard.removeSpace("TST", HOST), { key: "TST" });
  } finally {
    s.stop();
  }
});

test("a start whose claim wins while the disconnect waits in the queue makes it refuse", async () => {
  const git = gatedGit();
  const s = await setup(undefined, { runner: git.runner });
  try {
    await s.sync().sync();
    const entry = s.dashboard.spaces.get("TST")!;
    // The claim holds the queue at its first fetch, before it journals anything; the disconnect's
    // check passes outside the queue and waits behind the claim.
    const held = git.hold((args) => args[0] === "fetch");
    const starting = startTask(s.ctx, { task: "TST-FX001" });
    await held.hit;
    assert.equal(entry.sync.journalEntries.length, 0);
    const removing = s.dashboard.removeSpace("TST", HOST);
    await until(() => !s.dashboard.spaces.has("TST"));
    held.release();
    assert.equal((await starting).ok, true);
    await assert.rejects(removing, /TST-FX001 «Fix flaky login test» has a live run on this machine/);
    assert.equal(s.dashboard.spaces.get("TST"), entry, "the space is back");
  } finally {
    s.stop();
  }
});

test("an undecided claim behind an unreachable remote says so", async () => {
  const s = await setup();
  try {
    await s.sync().sync();
    s.sync().state.error = "fatal: could not read from remote repository";
    s.dashboard.runs!.put(runRecord("r-maybe", "TST", "TST-TASK2", "pending", "undecided"));
    await assert.rejects(
      s.dashboard.removeSpace("TST", "elsewhere"),
      /whether the start of TST-TASK2 «two» landed cannot be decided: the plan repository .* could not be reached \(fatal: could not read/,
    );
    // A failed push after a fetch that read origin does not stop the claim from being decided.
    s.sync().state.error = "push declined";
    await assert.rejects(s.dashboard.removeSpace("TST", "elsewhere"), /TST-TASK2 «two» landed is not decided yet; wait for the next syncs/);
    assert.equal(s.sync().journalEntries.length, 0);
    s.sync().record([labelOp("op_stuck")]);
    await assert.rejects(s.dashboard.removeSpace("TST", "elsewhere"), /1 change \(label of TST-FX001\) cannot be pushed: the plan repository .* refused the push \(push declined\)/);
  } finally {
    s.stop();
  }
});

test("a write a running sync pushes before the disconnect's check keeps its outcome, and the disconnect goes on", async () => {
  const git = gatedGit();
  const s = await setup(undefined, { runner: git.runner });
  try {
    await s.sync().sync();
    const entry = s.dashboard.spaces.get("TST")!;
    const held = git.hold((args) => args[0] === "fetch");
    const busy = entry.sync.sync();
    await held.hit;
    const removing = s.dashboard.removeSpace("TST", HOST);
    await until(() => !s.dashboard.spaces.has("TST"));
    // Journaled while the sync waits for its fetch: that sync applies and pushes it.
    const write = entry.sync.record([labelOp("op_rides", "urgent")]);
    held.release();
    await busy;
    assert.deepEqual(await removing, { key: "TST" });
    assert.equal((await write.outcomes).get("op_rides")?.status, "applied", "the caller hears what happened, not the disconnect");
    assert.match(sh(s.f.remote, "log", "-1", "--format=%B", "main"), /Dashboard-Op: op_rides/);
    assert.equal(existsSync(join(s.dashboard.dataDir, "spaces", "TST")), false);
  } finally {
    s.stop();
  }
});

test("a start or write after the disconnect's check is refused and journals nothing", async () => {
  const git = gatedGit();
  const s = await setup(undefined, { runner: git.runner });
  try {
    await s.sync().sync();
    const before = remoteState(s.f.remote);
    const entry = s.dashboard.spaces.get("TST")!;
    // The start resolved the space and waits for `git config user.name` before its claim.
    const held = git.hold((args) => args[0] === "config" && args[1] === "user.name");
    const starting = startTask(s.ctx, { task: "TST-FX001" });
    await held.hit;
    assert.deepEqual(await s.dashboard.removeSpace("TST", HOST), { key: "TST" });
    held.release();
    const started = await starting;
    assert.equal(started.ok, false);
    assert.match(started.error, /the space was disconnected from this machine; nothing was started/);

    const write = entry.sync.record([labelOp("op_late")]);
    assert.deepEqual((await write.outcomes).get("op_late"), { status: "refused", reason: "the space was disconnected from this machine" });
    await assert.rejects(entry.sync.sync(), /disconnected/);
    await assert.rejects(entry.sync.submit([labelOp("op_later")]), /disconnected/);
    assert.equal(existsSync(join(s.dashboard.dataDir, "spaces", "TST")), false, "no journal is written again");
    assert.equal([...s.dashboard.runs!.runs.values()].filter((run) => run.space === "TST").length, 0);
    assert.equal(remoteState(s.f.remote), before);
  } finally {
    s.stop();
  }
});
