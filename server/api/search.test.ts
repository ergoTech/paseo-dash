import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeLargePlan } from "../../fixtures/large-plan.ts";
import type { Task } from "../../shared/model.ts";
import { Dashboard } from "../dashboard.ts";
import { validateEntityText } from "../plan/load.ts";
import { FakePaseo } from "../runner/testing.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { listTasks } from "./reads.ts";
import { matchTask, parseQuery } from "./search.ts";

const TASK = `---
id: TST-SR001
type: task
title: Cache the session list
status: done
run_branch: task/tst-sr001-cache
run_pr: https://github.com/acme/core/pull/38
links: ["https://docs.example.com/cache"]
progress_note: Swapped the LRU for a plain Map
---

## Brief

Keep the session list in memory between polls.

## Acceptance

- [x] Opening the sidebar does not refetch

## Notes

Рішення: Кеш у пам'яті, а не в SQLite — менше залежностей.
Supersedes https://github.com/acme/core/pull/40.
`;

const loaded = validateEntityText(TASK, "task");
const task = loaded.entity as Task;
const match = (text: string) => matchTask(task, loaded, parseQuery(text)!);

test("a task's Notes section is read and kept with the task", () => {
  assert.equal(loaded.notes, "Рішення: Кеш у пам'яті, а не в SQLite — менше залежностей.\nSupersedes https://github.com/acme/core/pull/40.");
});

test("words are found in every field, lowercased, Cyrillic too, with the field and a quote", () => {
  assert.deepEqual(match("session list"), { field: "title", quote: "Cache the session list", exact: false });
  assert.equal(match("polls")?.field, "brief");
  assert.equal(match("refetch")?.field, "acceptance");
  assert.equal(match("кеш sqlite")?.field, "notes");
  assert.match(match("КЕШ")!.quote, /Кеш у пам'яті/);
  assert.equal(match("lru")?.field, "progress_note");
  assert.equal(match("docs example")?.field, "links");
  // Words may sit in different fields; the quote comes from the one that holds the most of them.
  assert.equal(match("session memory polls")?.field, "brief");
  assert.equal(match("session redis"), undefined);
});

test("a PR/MR link or branch name finds the task that owns it exactly", () => {
  assert.deepEqual(match("https://github.com/acme/core/pull/38"), { field: "pr", quote: "https://github.com/acme/core/pull/38", exact: true });
  assert.equal(match("https://github.com/acme/core/pull/38/files#diff-1")?.exact, true);
  assert.equal(match("HTTPS://GITHUB.COM/acme/core/pull/38/")?.exact, true);
  assert.equal(match("acme/core/pull/38")?.exact, true);
  assert.equal(match("https://github.com/acme/core/pull/3"), undefined);
  assert.equal(match("https://github.com/acme/core/pull/138"), undefined);
  assert.deepEqual(match("task/tst-sr001-cache"), { field: "branch", quote: "task/tst-sr001-cache", exact: true });
  // Another PR named in the text is found there, not as the task's own, and only as a whole link.
  assert.deepEqual(match("https://github.com/acme/core/pull/40"), { field: "notes", quote: "…SQLite — менше залежностей. Supersedes https://github.com/acme/core/pull/40.", exact: false });
  assert.equal(match("https://github.com/acme/core/pull/4"), undefined);
  // "owner/repo#N" is that PR or issue, not the repository: a link to the repo is not it.
  const repo = validateEntityText(TASK.replace('links: ["https://docs.example.com/cache"]', 'links: ["https://github.com/acme/core"]'), "task");
  assert.equal(matchTask(repo.entity as Task, repo, parseQuery("acme/core#38")!), undefined);
  assert.equal(matchTask(repo.entity as Task, repo, parseQuery("https://github.com/acme/core")!)?.exact, true);
  // A query with nothing to look for is no filter.
  for (const nothing of ["!!!", "/", "#/", "../", "~/"]) assert.equal(parseQuery(nothing), undefined, nothing);
  // A branch is only ever the whole name.
  assert.equal(match("sr001-cache")?.exact, false);
  assert.equal(match("tst-sr001/cache"), undefined);
});

test("a quote is one line around the match, cut with an ellipsis", () => {
  const long = validateEntityText(TASK.replace("Keep the session list", `${"word ".repeat(60)}\nKeep the session list`), "task");
  const quote = matchTask(long.entity as Task, long, parseQuery("polls")!)!.quote;
  assert.ok(quote.startsWith("…") && !quote.includes("\n"), quote);
  assert.ok(quote.length <= 142, `${quote.length}`);
  assert.match(quote, /between polls/);
  // A match longer than the quote is quoted whole.
  const url = `https://gitlab.example.com/${"group/".repeat(30)}project/-/merge_requests/7`;
  const linked = validateEntityText(TASK.replace("Keep the session list", `${"word ".repeat(20)}see ${url} here`), "task");
  assert.ok(matchTask(linked.entity as Task, linked, parseQuery(url)!)!.quote.includes(url));
});

/** Counts git runs, so the test can tell a read made none. */
function countingGit(): GitRunner & { runs: number } {
  const runner = { runs: 0, run: (cwd: string, args: string[], timeoutMs: number) => {
    runner.runs += 1;
    return systemGit.run(cwd, args, timeoutMs);
  } };
  return runner;
}

test("search over the 500-task plan finds by brief, notes, progress, PR and branch without git or network", async () => {
  const base = mkdtempSync(join(tmpdir(), "dashboard-search-"));
  const root = join(base, "plan");
  const remote = join(base, "plan.git");
  mkdirSync(root);
  writeLargePlan(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "plan");
  git(root, "push", "--quiet", remote, "main");

  const runner = countingGit();
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-search-data-")), fetchIntervalMs: 3_600_000, runner });
  dashboard.attach(new FakePaseo({}).api());
  const realFetch = globalThis.fetch;
  let fetches = 0;
  try {
    await dashboard.addSpace({ remote });
    await dashboard.spaces.get("LPL")!.sync.sync();
    const ctx = { dashboard };
    runner.runs = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      return Promise.reject(new Error("no network in a read"));
    }) as typeof fetch;

    const ask = (query: string) => listTasks(ctx, { query, limit: 50 });
    // LPL-00XXX ids: task t is 1000 + t in Crockford base32. Task 0 is done (status list starts "done").
    const notes = await ask("sqlite");
    assert.equal(notes.total, 100, "every fifth task has the decision in its Notes, whatever its status");
    // Finished work is searched too; it lists after open work, so the canceled ones are on a later page.
    const rest = await listTasks(ctx, { query: "sqlite", limit: 50, offset: 50 });
    assert.ok([...notes.tasks, ...rest.tasks].some((t) => t.status === "done") && rest.tasks.some((t) => t.status === "canceled"));
    assert.equal(notes.tasks.length + rest.tasks.length, 100, "the pages together hold every match once");
    assert.equal(new Set([...notes.tasks, ...rest.tasks].map((t) => t.id)).size, 100);
    assert.ok(notes.tasks.every((t) => t.matched_in === "notes" && /queue in memory/.test(t.quote ?? "")));
    assert.ok((await ask("Q35")).tasks.some((t) => t.title === "Task 35 of site" && t.matched_in === "notes"));
    const brief = await ask("generated task 123");
    assert.ok(brief.tasks.some((t) => t.title.startsWith("Task 123 of") && t.matched_in === "brief"));
    assert.ok((await ask("wiring step")).tasks.every((t) => t.matched_in === "progress_note" && t.status === "in_progress"));
    const pr = await ask("https://github.com/example/core/pull/1");
    assert.deepEqual(pr.tasks.map((t) => [t.title, t.status, t.matched_in]), [["Task 0 of core", "done", "pr"]]);
    const branch = pr.tasks[0] && (await ask(`task/${pr.tasks[0].id.toLowerCase()}`));
    assert.deepEqual(branch?.tasks.map((t) => [t.id, t.matched_in]), [[pr.tasks[0]!.id, "branch"]]);
    // A status asked still narrows a search.
    assert.equal((await listTasks(ctx, { query: "sqlite", status: "open", limit: 50 })).tasks.some((t) => t.status === "done"), false);

    const rounds = 20;
    const started = performance.now();
    for (let i = 0; i < rounds; i += 1) await ask(i % 2 ? "queue memory sqlite" : "https://github.com/example/ios/pull/9");
    const each = (performance.now() - started) / rounds;
    console.log(`search over 500 tasks: ${each.toFixed(2)} ms per query`);
    assert.ok(each < 100, `${each} ms per query`);

    assert.equal(runner.runs, 0, "a read runs no git");
    assert.equal(fetches, 0, "a read makes no network call");
  } finally {
    globalThis.fetch = realFetch;
    dashboard.stop();
  }
});
