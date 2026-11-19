import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToInbox, createTask, releaseTask, startTask } from "../api/writes.ts";
import { setup } from "../api/testing.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { fixture, sh } from "../sync/testing.ts";
import { parseSince, RECAP_MAX_CHARS, readRecap } from "../recap.ts";
import { changesFromCommits, changesOf, type LoggedCommit, PlanRecap, readChanges } from "./recap.ts";

/** Sets front matter keys of a task file as a person would by hand; `null` removes the key. */
function editFront(path: string, fields: Record<string, string | null>): void {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---", 4);
  let lines = text.slice(4, end).split("\n");
  for (const [key, value] of Object.entries(fields)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (value === null) lines = lines.filter((_, i) => i !== at);
    else if (at >= 0) lines[at] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  writeFileSync(path, `---\n${lines.join("\n")}${text.slice(end)}`);
}

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RD002 = "tasks/TST-RD002-login-page-redesign.md";
const TASK1 = "tasks/TST-TASK1-one.md";
const PR = "https://github.com/acme/core/pull/7";

/** The start of the next whole second, once it has come: commits from then on are dated at or after it. */
async function nextSecond(): Promise<Date> {
  await new Promise((resolve) => setTimeout(resolve, 1010 - (Date.now() % 1000)));
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

test("a recap lists the plan's changes from its commits: through the dashboard and by hand, with who, when and a link", async () => {
  const s = await setup();
  try {
    const before = await nextSecond();
    // By hand: anna marks a task done in her editor, then blocks the live run and renames its file.
    s.f.external("anna", (root) => editFront(join(root, TASK1), { status: "done" }));
    s.f.external("anna", (root) => {
      editFront(join(root, RD002), { progress_note: '"blocked: waiting for the API keys"' });
      renameSync(join(root, RD002), join(root, "tasks/TST-RD002-renamed.md"));
    });
    await s.sync().sync();
    // Through the dashboard: a start, a draft, a new task, a release.
    assert.equal((await startTask(s.ctx, { task: "TST-FX001" })).ok, true);
    assert.equal((await addToInbox(s.ctx, { items: [{ title: "Probe draft" }] })).ok, true);
    assert.equal((await createTask(s.ctx, { title: "Probe task", project: "core" })).ok, true);
    assert.equal((await releaseTask(s.ctx, { task: "TST-RD002", to: "todo" })).ok, true);
    await s.sync().sync();
    // By hand again: bob starts the task released and his PR/MR merges it; carol reopens it.
    s.f.external("bob", (root) =>
      editFront(join(root, "tasks/TST-RD002-renamed.md"), {
        status: "in_progress",
        run_id: "r-bob",
        run_by: "bob",
        run_host: "bob-mbp",
        run_branch: "feat/login-2",
        run_started: "2026-10-26T12:00:00.000Z",
        run_ended: null,
        progress_note: null,
      }),
    );
    s.f.external("bob", (root) =>
      editFront(join(root, "tasks/TST-RD002-renamed.md"), { status: "done", run_pr: PR, run_ended: "2026-10-26T13:00:00.000Z" }),
    );
    s.f.external("carol", (root) => editFront(join(root, "tasks/TST-RD002-renamed.md"), { status: "todo" }));
    await s.sync().sync();

    const recap = await readRecap(s.dashboard, { since: before.toISOString() });
    assert.equal(recap.error, "");
    assert.equal(recap.partial, "");
    const me = (await s.sync().gitUser()) || s.task("TST-FX001")!.run_by!;
    const created = (title: string) => recap.events.find((e) => e.title === title)!.task_id;
    const rows = recap.events.map((e) => [e.kind, e.task_id, e.by, e.by_hand, e.detail]);
    // The draft and the task may share one commit, where git lists files by path, not by when.
    const at = rows.findIndex((row) => row[0] === "created" || row[0] === "draft");
    rows.splice(at, 2, ...rows.slice(at, at + 2).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.deepEqual(
      rows,
      [
        ["status", "TST-RD002", "carol", true, "done → todo"],
        ["merged", "TST-RD002", "bob", true, "in_progress → done"],
        ["started", "TST-RD002", "bob", true, "on bob-mbp, branch feat/login-2"],
        ["released", "TST-RD002", me, false, "in_progress → todo"],
        ["created", created("Probe task"), me, false, "todo"],
        ["draft", created("Probe draft"), me, false, "inbox"],
        ["started", "TST-FX001", s.task("TST-FX001")!.run_by, false, `on ergo-mbp, branch ${s.task("TST-FX001")!.run_branch}`],
        ["blocked", "TST-RD002", "anna", true, "blocked: waiting for the API keys"],
        ["done", "TST-TASK1", "anna", true, "todo → done"],
      ],
    );
    const merged = recap.events.find((e) => e.kind === "merged")!;
    assert.equal(merged.pr, PR);
    assert.equal(merged.space, "TST");
    assert.equal(merged.project, "core");
    assert.equal(merged.link, "", "a plan on a local path has no web page");
    assert.ok(Date.parse(merged.at) >= before.getTime());
    assert.deepEqual(recap.counts, { done: 1, merged: 1, started: 2, blocked: 1, released: 1, created: 1, draft: 1, status: 1 });
    assert.equal(recap.total, 9);
    assert.equal(recap.more, false);

    const only = await readRecap(s.dashboard, { since: before.toISOString(), kinds: ["done", "merged"], limit: 1 });
    assert.deepEqual(only.events.map((e) => e.kind), ["merged"]);
    assert.deepEqual([only.total, only.more], [2, true]);
    assert.deepEqual(only.counts, { done: 1, merged: 1 });

    const unknown = await readRecap(s.dashboard, { space: "nope" });
    assert.match(unknown.error, /No space matches «nope»/);
  } finally {
    s.stop();
  }
});

test("since: a date is midnight here, the default is 7 days, and the window is 31 days by the calendar", () => {
  const now = new Date(2026, 9, 27, 10, 0);
  assert.equal((parseSince(undefined, now) as Date).getTime(), now.getTime() - 7 * 24 * 3600 * 1000);
  assert.equal((parseSince("2026-10-23", now) as Date).getTime(), new Date(2026, 9, 23).getTime());
  assert.equal((parseSince("2026-10-26T09:00:00Z", now) as Date).toISOString(), "2026-10-26T09:00:00.000Z");
  assert.equal((parseSince("2026-09-26", now) as Date).getTime(), new Date(2026, 8, 26).getTime(), "31 days ago as a date is inside");
  assert.match(parseSince("2026-09-25", now) as string, /more than 31 days ago/);
  assert.match(parseSince("2026-10-28", now) as string, /in the future/);
  assert.match(parseSince("last friday", now) as string, /is not a date/);
  assert.match(parseSince("2026-09-31", now) as string, /is not a date/, "no roll over into the next month");
});

test("the changes of one task version to the next", () => {
  const task = (fields: Record<string, unknown>) => ({ id: "TST-AAAAA", type: "task", title: "A", status: "todo", ...fields });
  // A workspace adopted: the task is created and claimed in one commit.
  assert.deepEqual(
    changesOf(undefined, task({ status: "in_progress", run_id: "r1", run_by: "ann", run_host: "h" })).map((c) => c.kind),
    ["created", "started"],
  );
  // The agent's report: review.
  assert.deepEqual(changesOf(task({ status: "in_progress", run_id: "r1" }), task({ status: "review", run_id: "r1", run_pr: PR })).map((c) => c.kind), ["review"]);
  // A reopened task marked done again keeps its old PR/MR, but its run ended earlier: done, not merged.
  assert.deepEqual(
    changesOf(task({ status: "todo", run_id: "r1", run_pr: PR, run_ended: "x" }), task({ status: "done", run_id: "r1", run_pr: PR, run_ended: "x" })).map((c) => c.kind),
    ["done"],
  );
  // Released as canceled; the same blocked note written again is no news.
  assert.deepEqual(
    changesOf(task({ status: "in_progress", run_id: "r1", progress_note: "blocked: x" }), task({ status: "canceled", run_id: "r1", run_ended: "y", progress_note: "blocked: x" })).map((c) => [c.kind, c.detail]),
    [["released", "in_progress → canceled"]],
  );
  // A file that did not parse before tells nothing; a feature is not a task.
  const commit = (files: LoggedCommit["files"]): LoggedCommit => ({ at: "2026-10-27T10:00:00+01:00", author: "a", email: "a@x", dashboard: false, files });
  const text = (front: string) => `---\n${front}\n---\n\nBody.\n`;
  assert.deepEqual(changesFromCommits([commit([{ before: "---\nid: [\n---\n", after: text("id: TST-AAAAA\ntype: task\ntitle: A\nstatus: done") }])]), []);
  assert.deepEqual(changesFromCommits([commit([{ after: text("id: TST-FFFFF\ntype: feature\ntitle: F\nstatus: active") }])]), []);
});

/** A plan with `n` hand commits that each create a task, a minute apart; the runner counts `git log` calls. */
function busyPlan(n: number): { root: string; runner: GitRunner; logs: () => number; dates: Date[] } {
  const f = fixture();
  const root = f.clone("busy");
  const dates: Date[] = [];
  for (let i = 0; i < n; i++) {
    // After the fixture's own commits, which are dated now.
    const at = new Date(Date.now() + (i + 1) * 60_000);
    dates.push(at);
    const id = `TST-B${"ABCDEFGHJK"[i]}000`;
    writeFileSync(join(root, "tasks", `${id}-busy.md`), `---\nid: ${id}\ntype: task\ntitle: Busy ${i}\nstatus: todo\nproject: core\n---\n`);
    sh(root, "add", "-A");
    const date = at.toISOString();
    execGit(root, date, ["commit", "--quiet", "-m", `busy ${i}`]);
  }
  let logs = 0;
  const runner: GitRunner = {
    run(cwd, args, timeoutMs) {
      if (args.includes("log")) logs++;
      return systemGit.run(cwd, args, timeoutMs);
    },
  };
  return { root, runner, logs: () => logs, dates };
}

function execGit(root: string, date: string, args: string[]): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
}

test("a period with more commits than the cap is said to be covered only back to the oldest read; a later since reads from the cache", async () => {
  const plan = busyPlan(4);
  const head = sh(plan.root, "rev-parse", "HEAD").trim();
  const from = new Date(plan.dates[0]!.getTime() - 1000);
  const cut = await readChanges(plan.runner, plan.root, head, from, 3);
  assert.deepEqual(cut.changes.map((c) => c.title), ["Busy 1", "Busy 2", "Busy 3"]);
  assert.equal(Date.parse(cut.cutAt!), Math.floor(plan.dates[1]!.getTime() / 1000) * 1000);
  const exact = await readChanges(plan.runner, plan.root, head, from, 4);
  assert.equal(exact.cutAt, undefined, "exactly as many commits as the cap is the whole period");

  const recap = new PlanRecap();
  const logs = plan.logs();
  const all = await recap.read(plan.runner, plan.root, from);
  assert.equal(all.changes.length, 4);
  const later = await recap.read(plan.runner, plan.root, new Date(plan.dates[2]!.getTime() - 1000));
  assert.deepEqual(later.changes.map((c) => c.title), ["Busy 2", "Busy 3"]);
  assert.equal(plan.logs() - logs, 1, "one git log for both reads");
  await recap.read(plan.runner, plan.root, new Date(from.getTime() - 60_000));
  assert.equal(plan.logs() - logs, 2, "an earlier since reads again");
});

test("a recap of many changes stays under its size in characters, and says more", async () => {
  const s = await setup();
  try {
    const before = await nextSecond();
    s.f.external("anna", (root) => {
      for (let i = 0; i < 100; i++) {
        const id = `TST-M${BASE32[i >> 5]}${BASE32[i & 31]}00`;
        writeFileSync(join(root, "tasks", `many-${i}.md`), `---\nid: ${id}\ntype: task\ntitle: ${"Long title ".repeat(30)}${i}\nstatus: todo\nproject: core\n---\n`);
      }
    });
    await s.sync().sync();
    const recap = await readRecap(s.dashboard, { since: before.toISOString(), limit: 100 });
    assert.equal(recap.error, "");
    assert.ok(recap.total >= 100, String(recap.total));
    assert.ok(JSON.stringify(recap).length <= RECAP_MAX_CHARS, String(JSON.stringify(recap).length));
    assert.ok(recap.events.length < 100 && recap.events.length > 10, String(recap.events.length));
    assert.equal(recap.more, true);
  } finally {
    s.stop();
  }
});

test("a long brief is read once, when its file is created: later commits carry only the front matter", async () => {
  const f = fixture();
  const root = f.clone("long");
  const path = join(root, "tasks", "TST-LLLLL-long.md");
  const body = "A long brief line.\n".repeat(50_000);
  const write = (status: string, extra = "") => writeFileSync(path, `---\nid: TST-LLLLL\ntype: task\ntitle: Long\nstatus: ${status}\nproject: core\n---\n\n${body}${extra}`);
  const commit = (message: string) => {
    sh(root, "add", "-A");
    sh(root, "commit", "--quiet", "-m", message);
  };
  const from = await nextSecond();
  write("todo");
  commit("create");
  for (const status of ["in_progress", "review", "done"]) {
    write(status);
    commit(status);
  }
  // A change at the end of the body: its hunk does not start at line 1, and says nothing.
  write("done", "One more line.\n");
  commit("body");
  let bytes = 0;
  const runner: GitRunner = {
    async run(cwd, args, timeoutMs) {
      const result = await systemGit.run(cwd, args, timeoutMs);
      if (args.includes("log")) bytes += result.stdout.length;
      return result;
    },
  };
  const read = await readChanges(runner, root, sh(root, "rev-parse", "HEAD").trim(), from);
  assert.deepEqual(read.changes.map((c) => [c.kind, c.detail]), [
    ["created", "todo"],
    ["status", "todo → in_progress"],
    ["review", "in_progress → review"],
    ["done", "review → done"],
  ]);
  assert.ok(bytes < body.length * 1.2, `${bytes} bytes read for a ${body.length}-byte brief`);
});
