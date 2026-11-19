import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../plan/load.ts";
import { validateEntityText } from "../plan/load.ts";
import { namedThings, onlyOne, search, type Searchable } from "./core.ts";

/** A plan in memory from entity files, with the space.yaml facts search reads. */
function plan(...files: string[]): Plan {
  const entities = new Map(
    files.map((text) => {
      const type = /^type: (\w+)$/m.exec(text)![1] as "task" | "feature" | "milestone";
      const loaded = validateEntityText(text, type);
      return [loaded.entity.id, loaded] as const;
    }),
  );
  return {
    space: {
      schema: "paseo-dashboard/1",
      key: "LAC",
      name: "Laconote",
      projects: { core: { remote: "git@github.com:acme/laconote-core.git" } },
      people: { ergo: { name: "Egor Ryzhov", emails: [], gitlab: {} } },
      labels: {},
      defaults: {},
    } as unknown as Plan["space"],
    entities,
    duplicates: new Set(),
    problems: [],
  };
}

const task = (id: string, title: string, front = "", body = "") => `---\nid: ${id}\ntype: task\ntitle: ${title}\n${front}---\n${body}`;

/** The task of the audit's reproduction: todo, never started. */
const LOGIN = task(
  "LAC-7K3QX",
  "Виправити логін через Google",
  'status: todo\nproject: core\nfeature: "[[LAC-0F00D-sign-in]]"\nmilestone: "[[LAC-00002-release-2-0]]"\nassignee: ergo\nlabels: ["bug", "security"]\n',
  "\n## Brief\n\nКористувачі не можуть увійти через Google після оновлення.\n",
);
const FEATURE = "---\nid: LAC-0F00D\ntype: feature\ntitle: Sign-in\nstatus: active\n---\n";
const RELEASE = "---\nid: LAC-00002\ntype: milestone\ntitle: Release 2.0\nstatus: active\n---\n";

const tasksOf = (p: Plan): Searchable[] => [...p.entities.values()].filter((l) => l.entity.type === "task").map((loaded) => ({ loaded, plan: p }));
const ids = (p: Plan, query: string, partial = false) => (search(tasksOf(p), query, { partial })?.hits ?? []).map((h) => h.item.loaded.entity.id);

test("every query of the audit finds the task: its id in any form, its facets, word forms, typos, the other layout", () => {
  const p = plan(LOGIN, FEATURE, RELEASE, task("LAC-AAAAA", "Unrelated chore", "status: todo\n"));
  for (const query of ["LAC-7K3QX", "lac-7k3qx", "lac7k3qx", "LAC 7K3QX", "7K3QX", "bug", "ergo", "Egor", "core", "laconote-core", "sign-in", "Release 2.0", "логіну", "логін", "Gogle", "kjusy"]) {
    assert.deepEqual(ids(p, query), ["LAC-7K3QX"], query);
  }
  // One word is in the task and one is not: a partial match, said so.
  const found = search(tasksOf(p), "Google login", { partial: true })!;
  assert.deepEqual([found.hits.map((h) => h.item.loaded.entity.id), found.partial], [["LAC-7K3QX"], true]);
  assert.equal(search(tasksOf(p), "Google login")!.hits.length, 0, "without partial, every word is needed");
  // The layout swap says what it searched for.
  assert.equal(search(tasksOf(p), "kjusy")!.searchedFor, "логін");
  // Where each was found.
  const field = (query: string) => search(tasksOf(p), query)!.hits[0]!.match;
  assert.deepEqual(field("7K3QX"), { ...field("7K3QX"), field: "id", quote: "LAC-7K3QX", exact: true });
  assert.equal(field("bug").field, "labels");
  assert.equal(field("Egor").field, "assignee");
  assert.equal(field("Release 2.0").field, "release");
  assert.equal(field("увійти").field, "brief");
});

test("ranking: the id, then the exact title, then words in the title before facets and text; stronger before weaker; open before done", () => {
  const p = plan(
    task("LAC-00010", "Login page", "status: todo\n", "\n## Brief\n\nThe login form.\n"),
    task("LAC-00011", "Reset password", "status: todo\n", "\n## Brief\n\nLink it from the login page.\n"),
    task("LAC-00012", "Login page", "status: done\n"),
    task("LAC-00013", "Login pages for admins", "status: todo\n"),
    task("LAC-00014", "Login", "status: todo\n"),
    task("LAC-00015", "Logins audit", "status: canceled\n"),
  );
  assert.deepEqual(ids(p, "login page"), ["LAC-00010", "LAC-00012", "LAC-00013", "LAC-00011"], "exact title (open, then done), a form in the title, then the brief");
  assert.deepEqual(
    ids(p, "login"),
    ["LAC-00014", "LAC-00010", "LAC-00013", "LAC-00012", "LAC-00015", "LAC-00011"],
    "the exact title; the word in a title, open before done; another form of it, canceled; the brief last",
  );
  // An id inside the words: the task that has it first, found as the id.
  const withId = search(tasksOf(p), "LAC-00011 login")!.hits;
  assert.deepEqual([withId[0]!.item.loaded.entity.id, withId[0]!.match.field, withId[0]!.match.key[0]], ["LAC-00011", "id", 0]);
  // A word found nowhere as typed is looked for with a typo, and ranks after exact matches of others.
  assert.deepEqual(ids(p, "pasword"), ["LAC-00011"]);
});

test("a typo is tried only for a word found nowhere: a word that exists is not widened", () => {
  const p = plan(task("LAC-00020", "Cache warmup", "status: todo\n"), task("LAC-00021", "Catch errors", "status: todo\n"));
  assert.deepEqual(ids(p, "cache"), ["LAC-00020"], "«catch» is one edit away, but «cache» exists");
  assert.deepEqual(ids(p, "cahce"), ["LAC-00020"]);
  // With several words, only the word no task holds gets a typo: «login» exists, so «logon» is not it.
  const pages = plan(task("LAC-00022", "Login page", "status: todo\n"), task("LAC-00023", "Logon page", "status: todo\n"));
  assert.deepEqual(ids(pages, "login pagr"), ["LAC-00022"]);
});

test("a word ranks by the one field that places it best: a part of a title word is a part, not the word", () => {
  const p = plan(
    task("LAC-00050", "Blog redesign", "status: todo\n", "\n## Brief\n\nKeep the log of changes.\n"),
    task("LAC-00051", "Log viewer", "status: todo\n"),
    task("LAC-00052", "Payments", "status: todo\n", "\n## Brief\n\nWrite a log line per payment.\n"),
  );
  assert.deepEqual(ids(p, "log"), ["LAC-00051", "LAC-00050", "LAC-00052"]);
  const blog = plan(
    task("LAC-00053", "Blog redesign", "status: todo\n", "\n## Brief\n\nKeep the log of changes.\n"),
    task("LAC-00054", "Payments", "status: todo\n", "\n## Brief\n\nWrite a log line per payment.\n"),
  );
  const found = search(tasksOf(blog), "log")!;
  assert.equal(onlyOne(found, "log"), undefined, "the whole word is in both briefs: ask which");
  // Where it was found is where the whole word is, not the title «log» is only a part of.
  const one = plan(task("LAC-00057", "Blog redesign", "status: todo\n", "\n## Brief\n\nKeep the log of changes.\n"), task("LAC-00058", "Payments", "status: todo\n"));
  const picked = onlyOne(search(tasksOf(one), "log")!, "log");
  assert.deepEqual([picked?.item.loaded.entity.id, picked?.match.field, picked?.match.quote], ["LAC-00057", "brief", "Keep the log of changes."]);
  // In one field too: the quote is around the whole word, not a part of an earlier one.
  const later = plan(task("LAC-00059", "Engine", "status: todo\n", `\n## Brief\n\nThe blog engine ${"x ".repeat(120)}and we log every change.\n`));
  assert.match(search(tasksOf(later), "log")!.hits[0]!.match.quote, /we log every change/);
  // A part of a title word ranks below the whole word in a label.
  const bug = plan(task("LAC-00055", "Debugger panel", "status: todo\n"), task("LAC-00056", "Crash on save", 'status: todo\nlabels: ["bug"]\n'));
  assert.deepEqual(ids(bug, "bug"), ["LAC-00056", "LAC-00055"]);
});

test("the id matches only as itself: the space key or a piece of a suffix finds nothing", () => {
  const p = plan(task("LAC-23ABC", "Release notes", "status: todo\n"), LOGIN, FEATURE, RELEASE, task("LAC-00060", "Laconote sync", "status: todo\n"));
  assert.deepEqual(ids(p, "lac"), ["LAC-00060", "LAC-7K3QX"], "«Laconote sync» by its title, LAC-7K3QX by its project's repository, «Release notes» not by its id");
  assert.deepEqual(ids(p, "23abc"), ["LAC-23ABC"]);
  assert.deepEqual(ids(p, "23ab"), [], "a beginning of a suffix is no id");
  // Words that are in the release's title rank above an id that happens to hold their digits.
  assert.deepEqual(ids(p, "release 2.0")[0], "LAC-7K3QX");
  // A title that only looks like an id («Laconote sync» reads as no id, «Laconote» as LAC-0N0TE) is
  // still found by its words.
  assert.deepEqual(ids(p, "Laconote"), ["LAC-00060", "LAC-7K3QX"], "the title first, then the project's repository laconote-core");
});

test("one task for a vague name only when it is clearly the one; a fragment never picks", () => {
  const p = plan(LOGIN, task("LAC-00030", "Login for admins", "status: todo\n"), task("LAC-00031", "One more", "status: todo\n"));
  const one = (query: string) => {
    const found = search(tasksOf(p), query);
    return found ? onlyOne(found, query)?.item.loaded.entity.id : undefined;
  };
  assert.equal(one("логіну через гугл"), undefined, "«гугл» is in no task");
  assert.equal(one("виправити логіну"), "LAC-7K3QX");
  assert.equal(one("7K3QX"), "LAC-7K3QX");
  assert.equal(one("ne"), undefined, "«ne» is only a part of «one»");
  assert.equal(one("logi"), "LAC-00030", "a beginning of four letters names a task");
  // A better-ranked hit that cannot name a task on its own makes the name unclear.
  const pay = plan(task("LAC-00032", "Payments", "status: todo\n"), task("LAC-00033", "Ledger", "status: todo\n", "\n## Brief\n\nWhat we pay each month.\n"));
  const paid = search(tasksOf(pay), "pay")!;
  assert.equal(paid.hits[0]!.item.loaded.entity.id, "LAC-00032");
  assert.equal(onlyOne(paid, "pay"), undefined, "«Payments» ranks first but «pay» is only its beginning");
  const two = plan(task("LAC-00040", "Login page", "status: todo\n"), task("LAC-00041", "Login form", "status: todo\n"));
  const found = search(tasksOf(two), "login")!;
  assert.equal(onlyOne(found, "login"), undefined, "two equal matches: ask which");
});

test("features, releases and projects are found by their names", () => {
  const p = plan(LOGIN, FEATURE, RELEASE);
  assert.deepEqual(namedThings([{ key: "LAC", plan: p }], "sign in"), [{ kind: "feature", id: "LAC-0F00D", title: "Sign-in" }]);
  assert.deepEqual(namedThings([{ key: "LAC", plan: p }], "release 2"), [{ kind: "release", id: "LAC-00002", title: "Release 2.0" }]);
  assert.deepEqual(namedThings([{ key: "LAC", plan: p }], "laconote"), [{ kind: "project", id: "core", title: "core", space: "LAC" }]);
  assert.deepEqual(namedThings([{ key: "LAC", plan: p }], "https://github.com/acme/core/pull/1"), [], "a link names no feature");
});

test("a query with nothing to look for filters nothing", () => {
  assert.equal(search(tasksOf(plan(LOGIN)), "!!!"), undefined);
});
