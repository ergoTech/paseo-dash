import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTaskWithRuns } from "../api/reads.ts";
import { releaseTask, startTask } from "../api/writes.ts";
import { setup } from "../api/testing.ts";
import { settled } from "../runner/testing.ts";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { fixture, sh } from "../sync/testing.ts";
import { taskRuns } from "../views.ts";
import { RunHistory, runsFromSnapshots } from "./run-history.ts";
import { historyWithin } from "../api/runs.ts";
import type { Dashboard } from "../dashboard.ts";
import type { LoadedEntity } from "./load.ts";
import type { SpaceSync } from "../sync/space-sync.ts";

/** Sets front matter keys of a task file as a person would by hand; `null` removes the key. */
function editFront(path: string, fields: Record<string, string | null>, body?: (text: string) => string): void {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---", 4);
  let lines = text.slice(4, end).split("\n");
  for (const [key, value] of Object.entries(fields)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (value === null) lines = lines.filter((_, i) => i !== at);
    else if (at >= 0) lines[at] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  const rest = text.slice(end);
  writeFileSync(path, `---\n${lines.join("\n")}${body ? body(rest) : rest}`);
}

const RD002 = "tasks/TST-RD002-login-page-redesign.md";
const RENAMED = "tasks/TST-RD002-renamed-by-hand.md";
const PR1 = "https://github.com/acme/core/pull/1";
const PR2 = "https://github.com/acme/core/pull/2";
/** gh as a start asks it about the previous run's branch: no PR/MR there. */
const noPrs: CommandRunner = async (_command, args) => ({ code: args[1] === "list" ? 0 : 1, stdout: args[1] === "list" ? "[]" : "" });

test("runs come from the plan's commits: claims, releases, a merge, a reopen, a hand rename and a git merge in a row", async () => {
  const s = await setup(undefined, { forge: new ForgeCli(noPrs) });
  try {
    // anna's run (seeded live) leaves a PR, progress and a handoff, then a person here releases it.
    s.f.external("anna", (root) =>
      editFront(join(root, RD002), { run_pr: PR1, progress_note: "Half done." }, (rest) => `${rest}\n## Handoff\n\n*Run r-anna · 2026-10-26T09:00:00.000Z*\n\nDone: half.\nLeft: the form.\n`),
    );
    await s.sync().sync();
    assert.equal((await releaseTask(s.ctx, { task: "TST-RD002", to: "todo" })).ok, true);
    // This machine claims it again: a new run_id, its agent here.
    const started = await startTask(s.ctx, { task: "TST-RD002" });
    assert.equal(started.ok, true, started.error);
    const mine = s.task("TST-RD002")!.run_id!;
    const me = s.task("TST-RD002")!.run_by!;
    await settled(() => Boolean(s.dashboard.runs?.runs.get(mine)?.agentId));
    await s.sync().sync();
    // Another machine sees this run's PR merged; a person reopens the task.
    s.f.external("bob", (root) =>
      editFront(join(root, RD002), { run_pr: PR2, run_ended: "2026-10-26T11:00:00.000Z", status: "done", progress_note: "All done." }),
    );
    s.f.external("carol", (root) => editFront(join(root, RD002), { status: "todo" }));
    // bob claims it on his machine and renames the file by hand in the same commit.
    s.f.external("bob", (root) => {
      editFront(join(root, RD002), {
        status: "in_progress",
        run_id: "r-bob",
        run_by: "bob",
        run_host: "bob-mbp",
        run_branch: "feat/login-redesign-2",
        run_started: "2026-10-26T12:00:00.000Z",
        run_ended: null,
        run_pr: null,
        progress_note: null,
      });
      renameSync(join(root, RD002), join(root, RENAMED));
    });
    // Two people edit the renamed file apart, and one merges the other's commit.
    const one = s.f.clone("one");
    const two = s.f.clone("two");
    editFront(join(one, RENAMED), { progress_note: "Bob halfway." });
    sh(one, "commit", "--quiet", "-am", "progress");
    sh(one, "push", "--quiet", "origin", "HEAD:main");
    editFront(join(two, RENAMED), { title: "Login page redesign, again" });
    sh(two, "commit", "--quiet", "-am", "title");
    sh(two, "fetch", "--quiet", "origin");
    sh(two, "merge", "--quiet", "--no-edit", "origin/main");
    sh(two, "push", "--quiet", "origin", "HEAD:main");
    await s.sync().sync();
    assert.equal(s.task("TST-RD002")?.run_id, "r-bob");

    const view = await taskRuns(s.dashboard, { task: "TST-RD002" }, new Date(2026, 9, 26, 13, 0), "ergo-mbp");
    assert.equal(view.error, "");
    assert.deepEqual(
      view.runs.map((r) => [r.id, r.by, r.host, r.live, r.result, r.pr, r.progress]),
      [
        ["r-bob", "bob", "bob-mbp", true, "holds the task now", "", "Bob halfway."],
        [mine, me, "ergo-mbp", false, "ended: done", PR2, "All done."],
        ["r-anna", "anna", "anna-mbp", false, "released back to todo", PR1, "Half done."],
      ],
    );
    assert.equal(view.runs[0]!.branch, "feat/login-redesign-2");
    assert.equal(view.runs[0]!.local, null);
    assert.equal(view.runs[0]!.elsewhere, "Its agent ran on bob-mbp, not on this Mac.");
    assert.ok(view.runs[1]!.local?.agentId, "this machine's run leads to its agent");
    assert.equal(view.runs[1]!.elsewhere, "");
    assert.ok(view.runs[1]!.ended, "the merge's end shows");
    assert.equal(view.runs[2]!.local, null);
    assert.equal(view.runs[2]!.elsewhere, "Its agent ran on anna-mbp, not on this Mac.");
    assert.equal(view.runs[2]!.handoff?.text, "Done: half.\nLeft: the form.");
    assert.equal(view.runs[1]!.handoff, null, "a handoff belongs to the run its stamp names");

    // God Mode reads the same runs, with chat_id only where the agent is here.
    const read = await getTaskWithRuns(s.ctx, { task: "TST-RD002" });
    assert.equal(read.runs_error, "");
    assert.deepEqual(
      read.runs.map((r) => [r.run_id, r.result, Boolean(r.chat_id)]),
      [
        ["r-bob", "holds the task now", false],
        [mine, "ended: done", true],
        ["r-anna", "released back to todo", false],
      ],
    );
    assert.equal(read.runs[1]!.chat_id, s.dashboard.runs?.runs.get(mine)?.agentId);
    assert.equal(read.runs[2]!.handoff, "Done: half.\nLeft: the form.");

    // This machine's run_id copied into another task's file leads to no agent there.
    s.f.external("mallory", (root) =>
      editFront(join(root, "tasks/TST-DEP01-blocked-thing.md"), { run_id: mine, run_by: "mallory", run_host: "ergo-mbp", run_ended: "2026-10-26T12:30:00.000Z", status: "canceled" }),
    );
    await s.sync().sync();
    const copied = await taskRuns(s.dashboard, { task: "TST-DEP01" }, new Date(2026, 9, 26, 13, 0), "ergo-mbp");
    assert.deepEqual(
      copied.runs.map((r) => [r.id, r.local, r.elsewhere]),
      [[mine, null, "Started on this Mac, but this Mac no longer knows its agent."]],
    );
    assert.equal((await getTaskWithRuns(s.ctx, { task: "TST-DEP01" })).runs[0]!.chat_id, "");
  } finally {
    s.stop();
  }
});

test("the history is read when asked and again only after the clone's HEAD moves", async () => {
  const f = fixture();
  const root = f.clone("me");
  const calls: string[] = [];
  const runner: GitRunner = {
    run(cwd, args, timeoutMs) {
      calls.push(args.find((a) => a === "log" || a === "rev-parse") ?? args[0]!);
      return systemGit.run(cwd, args, timeoutMs);
    },
  };
  const history = new RunHistory();
  const path = "tasks/TST-TASK1-one.md";
  assert.deepEqual(await history.read(runner, root, "TST-TASK1", path), []);
  assert.deepEqual(await history.read(runner, root, "TST-TASK1", path), []);
  assert.deepEqual(calls, ["rev-parse", "log", "log", "rev-parse"], "the second read is the cache's");
  // A claim, committed with CRLF line endings whatever the user's git config says, moves HEAD.
  sh(root, "config", "core.autocrlf", "false");
  editFront(join(root, path), { status: "in_progress", run_id: "r-one", run_by: "me", run_host: "me-mbp", run_started: "2026-10-26T08:00:00Z" });
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace(/\n/g, "\r\n"));
  sh(root, "commit", "--quiet", "-am", "claim");
  calls.length = 0;
  const runs = await history.read(runner, root, "TST-TASK1", path);
  assert.deepEqual(calls, ["rev-parse", "log", "log"]);
  assert.deepEqual(
    runs.map((r) => [r.run_id, r.by, r.host, r.started, r.result]),
    [["r-one", "me", "me-mbp", "2026-10-26T08:00:00Z", "live"]],
  );
  assert.deepEqual(await history.read(runner, root, "TST-TASK2", "tasks/TST-TASK2-two.md"), [], "another task's file has no runs");
});

test("a claim over a run that never ended replaces it; a file's id, not its name, says whose it is", () => {
  const runs = runsFromSnapshots([
    { front: { id: "TST-A0000", status: "in_progress", run_id: "r-1", run_by: "a" } },
    { front: { id: "TST-A0000", status: "in_progress", run_id: "r-2", run_by: "b" } },
    { front: { id: "TST-A0000", status: "done", run_id: "r-2", run_by: "b", run_ended: "2026-10-26T10:00:00Z" } },
  ]);
  assert.deepEqual(
    runs.map((r) => [r.run_id, r.result]),
    [
      ["r-2", "done"],
      ["r-1", "replaced"],
    ],
  );
  assert.deepEqual(runsFromSnapshots([{ front: { id: "TST-A0000", status: "todo" } }]), [], "a task never claimed has no runs");
});

test("a failed read is not cached, and the oldest read goes first past the bound", async () => {
  const f = fixture();
  const root = f.clone("me");
  let logs = 0;
  let fail = true;
  const runner: GitRunner = {
    run(cwd, args, timeoutMs) {
      if (args.includes("log")) {
        logs++;
        if (fail) return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad object", timedOut: false });
      }
      return systemGit.run(cwd, args, timeoutMs);
    },
  };
  const history = new RunHistory(1);
  await assert.rejects(history.read(runner, root, "TST-TASK1", "tasks/TST-TASK1-one.md"), /git log failed: fatal: bad object/);
  fail = false;
  assert.deepEqual(await history.read(runner, root, "TST-TASK1", "tasks/TST-TASK1-one.md"), []);
  assert.equal(logs, 3, "the failed read is asked again");
  await history.read(runner, root, "TST-TASK2", "tasks/TST-TASK2-two.md");
  await history.read(runner, root, "TST-TASK1", "tasks/TST-TASK1-one.md");
  assert.equal(logs, 7, "with room for one, the first task's read was dropped");
});

test("a read that outlasts the wait answers without the history and keeps reading", async () => {
  let finish: (runs: never[]) => void = () => {};
  const reading = new Promise<never[]>((resolve) => (finish = resolve));
  const dashboard = { runHistory: { read: () => reading } } as unknown as Dashboard;
  const sync = { gitRunner: systemGit, root: "/nowhere" } as unknown as SpaceSync;
  const loaded = { entity: { id: "TST-TASK1" }, path: "tasks/TST-TASK1-one.md" } as unknown as LoadedEntity;
  assert.deepEqual(await historyWithin(dashboard, sync, loaded, 5), { runs: [], error: "The run history is still being read from git; ask again shortly." });
  finish([]);
  assert.deepEqual(await historyWithin(dashboard, sync, loaded, 5), { runs: [], error: "" });
});
