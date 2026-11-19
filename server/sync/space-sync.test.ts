import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Task } from "../../shared/model.ts";
import { opaqueId } from "../plan/ids.ts";
import { loadPlan } from "../plan/load.ts";
import type { Operation, RunFields } from "./ops.ts";
import { SpaceSync } from "./space-sync.ts";
import { CUT, fixture, remoteLog, scriptedGit, sh, UNREACHABLE } from "./testing.ts";
import { systemGit } from "./git.ts";

function run(by: string, id = opaqueId("r")): RunFields {
  return { run_id: id, run_by: by, run_host: `${by}-mbp`, run_branch: "feat/totp", run_started: "2026-10-26T08:00:00Z" };
}

function task(sync: { plan: ReturnType<typeof loadPlan> }, id: string): Task {
  return sync.plan.entities.get(id)!.entity as Task;
}

function op<T extends Operation["kind"]>(kind: T, fields: Omit<Extract<Operation, { kind: T }>, "op_id" | "kind">): Operation {
  return { op_id: opaqueId("op"), kind, ...fields } as unknown as Operation;
}

test("two machines claim the same task at once: exactly one wins, the other hears who", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  const [ra, rb] = await Promise.all([a.claim("TST-TASK1", run("anna")), b.claim("TST-TASK1", run("ergo"))]);
  const results = [ra.result, rb.result].sort();
  assert.deepEqual(results, ["lost", "won"]);
  const loser = ra.result === "lost" ? ra : rb;
  const winner = ra.result === "won" ? "anna" : "ergo";
  assert.ok("reason" in loser && loser.reason.includes(`already started by ${winner}`));
  await a.sync();
  assert.equal(task(a, "TST-TASK1").run_by, winner);
  assert.equal(a.state.pending + b.state.pending, 0, "claims never stay in the journal once decided");
});

test("a claim whose push landed but whose answer was lost is decided as won from origin", async () => {
  const f = fixture();
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (await real(), CUT) }) });
  const result = await a.claim("TST-TASK1", run("anna", "r-lost-ack"));
  assert.deepEqual(result, { result: "won" });
  assert.equal(a.state.pending, 0);
});

test("a push that landed before a crash leaves the journal on restart, with no conflict", async () => {
  const f = fixture();
  const journalPath = join(f.dir, "anna.journal.json");
  const crashy = f.sync("anna", { runner: scriptedGit({ push: async (real) => (await real(), CUT) }) });
  await crashy.submit([op("set", { id: "TST-TASK2", field: "priority", value: "high", expect: undefined })]);
  assert.equal(crashy.state.pending, 1, "the answer was lost, so the operation is still pending");
  const restarted = new (crashy.constructor as typeof import("./space-sync.ts").SpaceSync)({
    root: crashy.root,
    branch: "main",
    journalPath,
  });
  await restarted.sync();
  assert.equal(restarted.state.pending, 0);
  assert.deepEqual(restarted.state.conflicts, []);
  assert.equal(task(restarted, "TST-TASK2").priority, "high");
});

test("operations of an abandoned run never touch the next run (ABA)", async () => {
  const f = fixture();
  let offline = false;
  const a = f.sync("anna", {
    runner: scriptedGit({
      fetch: async (real) => (offline ? UNREACHABLE : real()),
      push: async (real) => (offline ? UNREACHABLE : real()),
    }),
  });
  const b = f.sync("ergo");
  assert.equal((await a.claim("TST-TASK1", run("anna", "r-anna"))).result, "won");
  offline = true;
  await a.submit([
    op("progress", { id: "TST-TASK1", run_id: "r-anna", done: 1, total: 2, note: "late note", at: "2026-10-26T09:00:00Z" }),
    op("check", { id: "TST-TASK1", line: "first", done: true, run_id: "r-anna" }),
  ]);
  await b.sync();
  await b.submit([op("release", { id: "TST-TASK1", run_id: "r-anna", to: "todo", at: "2026-10-26T09:05:00Z" })]);
  assert.equal((await b.claim("TST-TASK1", run("ergo", "r-ergo"))).result, "won");
  offline = false;
  await a.sync();
  const after = task(a, "TST-TASK1");
  assert.equal(after.run_id, "r-ergo");
  assert.equal(after.progress_note, undefined, "the old run's progress was dropped");
  assert.equal(a.plan.entities.get("TST-TASK1")!.acceptance[0]!.done, false, "the old run's tick was dropped");
  assert.equal(a.state.pending, 0);
  assert.deepEqual(a.state.conflicts, [], "dropped, not reported as a conflict");
});

test("the same transition recorded by two machines lands once, without a conflict", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  assert.equal((await a.claim("TST-TASK1", run("anna", "r1"))).result, "won");
  await b.sync();
  const before = remoteLog(f.remote).length;
  const transition = () =>
    op("transition", { id: "TST-TASK1", to: "review", run_id: "r1", run_pr: "https://example.com/pr/1", at: "2026-10-26T09:00:00Z" });
  await a.submit([transition()]);
  await b.submit([transition()]);
  assert.equal(remoteLog(f.remote).length, before + 1, "one commit");
  assert.deepEqual(b.state.conflicts, []);
  assert.equal(b.state.pending, 0);
});

test("a claim that fails before sending reports nothing started and is never pushed later", async () => {
  const f = fixture();
  let down = true;
  const journalPath = join(f.dir, "anna.journal.json");
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  const result = await a.claim("TST-TASK1", run("anna"));
  assert.equal(result.result, "not_started");
  assert.equal(a.state.pending, 0);
  const before = remoteLog(f.remote).length;
  down = false;
  await a.submit([op("set", { id: "TST-TASK2", field: "priority", value: "high", expect: undefined })]);
  assert.equal(remoteLog(f.remote).length, before + 1, "only the later edit was pushed");
  assert.equal(task(a, "TST-TASK1").run_id, undefined);
  const restarted = new (a.constructor as typeof import("./space-sync.ts").SpaceSync)({ root: a.root, branch: "main", journalPath });
  await restarted.sync();
  assert.equal(remoteLog(f.remote).length, before + 1, "nor after a restart");
});

test("an undecided claim that did land is decided as won by a later fetch", async () => {
  const f = fixture();
  let fetchDown = false;
  const decided: [string, string, boolean][] = [];
  const a = f.sync("anna", {
    runner: scriptedGit({
      push: async (real) => {
        await real();
        fetchDown = true;
        return CUT;
      },
      fetch: async (real) => (fetchDown ? UNREACHABLE : real()),
    }),
    onClaimDecided: (taskId, runId, won) => decided.push([taskId, runId, won]),
  });
  assert.equal((await a.claim("TST-TASK1", run("anna", "r-late"))).result, "unknown");
  fetchDown = false;
  await a.sync();
  assert.deepEqual(decided, [["TST-TASK1", "r-late", true]]);
  assert.equal(a.state.pending, 0);
  assert.equal(task(a, "TST-TASK1").run_id, "r-late");
});

test("a claim that waited too long behind another write starts nothing", async () => {
  const f = fixture();
  let clock = Date.parse("2026-10-26T08:00:00Z");
  const a = f.sync("anna", {
    now: () => new Date(clock),
    runner: scriptedGit({
      push: async (real) => {
        clock += 30_000;
        return real();
      },
    }),
  });
  const write = a.submit([op("set", { id: "TST-TASK2", field: "priority", value: "high", expect: undefined })]);
  const claim = a.claim("TST-TASK1", run("anna"));
  await write;
  const result = await claim;
  assert.equal(result.result, "not_started");
  const check = f.sync("check");
  assert.equal(task(check, "TST-TASK1").run_id, undefined);
});

test("an operation that would break its file is refused and the next one still lands", async () => {
  const f = fixture();
  const a = f.sync("anna");
  await a.submit([
    op("set", { id: "TST-TASK1", field: "priority", value: "extreme", expect: undefined }),
    op("set", { id: "TST-TASK2", field: "priority", value: "high", expect: undefined }),
  ]);
  assert.equal(a.state.conflicts.length, 1);
  assert.equal(a.state.conflicts[0]!.id, "TST-TASK1");
  assert.equal(a.state.pending, 0);
  const check = f.sync("check");
  assert.equal(task(check, "TST-TASK2").priority, "high");
  assert.equal(task(check, "TST-TASK1").priority, undefined);
});

test("a run's own merge moves it to done and ends the run once its acceptance is ticked; a transition outside the table is dropped", async () => {
  const f = fixture();
  const a = f.sync("anna");
  assert.equal((await a.claim("TST-TASK1", run("anna", "r1"))).result, "won");
  await a.submit([op("transition", { id: "TST-TASK1", to: "todo", run_id: "r1", at: "2026-10-26T09:00:00Z" })]);
  assert.equal(task(a, "TST-TASK1").status, "in_progress", "a run cannot move its task back to todo");
  assert.deepEqual(a.state.conflicts, [], "dropped as a run step, not a person's conflict");
  await a.submit([op("check", { id: "TST-TASK1", line: "first", done: true, run_id: "r1" })]);
  await a.submit([op("transition", { id: "TST-TASK1", to: "done", run_id: "r1", at: "2026-10-26T09:30:00Z" })]);
  assert.equal(task(a, "TST-TASK1").status, "in_progress", "one acceptance line left: the merge alone does not finish the task");
  assert.deepEqual(a.state.conflicts, [], "dropped, not a person's conflict");
  await a.submit([
    op("check", { id: "TST-TASK1", line: "second", done: true, run_id: "r1" }),
    op("transition", { id: "TST-TASK1", to: "done", run_id: "r1", at: "2026-10-26T10:00:00Z" }),
  ]);
  const after = task(a, "TST-TASK1");
  assert.equal(after.status, "done");
  assert.equal(after.run_ended, "2026-10-26T10:00:00Z");
});

test("a create that landed before a crash is not a conflict after an offline restart", async () => {
  const f = fixture();
  const journalPath = join(f.dir, "anna.journal.json");
  const crashy = f.sync("anna", { runner: scriptedGit({ push: async (real) => (await real(), CUT) }) });
  const body = "## Brief\n\nNew.\n\n## Acceptance\n\n## Notes\n";
  await crashy.submit([
    op("create", { type: "task", id: "TST-NEW01", fields: { title: "new", status: "inbox" }, body }),
  ]);
  assert.equal(crashy.state.pending, 1);
  const offline = new (crashy.constructor as typeof import("./space-sync.ts").SpaceSync)({
    root: crashy.root,
    branch: "main",
    journalPath,
    runner: scriptedGit({ fetch: async () => UNREACHABLE, push: async () => UNREACHABLE }),
  });
  await offline.sync();
  assert.deepEqual(offline.state.conflicts, []);
  assert.equal(offline.state.pending, 0);
  assert.equal(task(offline, "TST-NEW01").title, "new");
});

test("a claim cut midway stays undecided, is never pushed again, and is given up later", async () => {
  const f = fixture();
  let clock = Date.parse("2026-10-26T08:00:00Z");
  let cut = true;
  const decided: [string, boolean][] = [];
  const a = f.sync("anna", {
    now: () => new Date(clock),
    runner: scriptedGit({ push: async (real) => (cut ? CUT : real()) }),
    onClaimDecided: (taskId, _run, won) => decided.push([taskId, won]),
  });
  const result = await a.claim("TST-TASK1", run("anna", "r-cut"));
  assert.equal(result.result, "unknown");
  cut = false;
  const before = remoteLog(f.remote).length;
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "the undecided claim was not pushed");
  clock += 11 * 60_000;
  await a.sync();
  assert.deepEqual(decided, [["TST-TASK1", false]]);
  assert.equal(a.state.pending, 0);
});

test("ordinary status changes cannot touch a live run; a release ends it and keeps its history", async () => {
  const f = fixture();
  const a = f.sync("anna");
  assert.equal((await a.claim("TST-TASK1", run("anna", "r1"))).result, "won");
  await a.submit([op("status", { id: "TST-TASK1", to: "todo", expect: "in_progress" })]);
  assert.match(a.state.conflicts[0]!.reason, /held by anna/);
  await a.submit([op("release", { id: "TST-TASK1", run_id: "r1", to: "todo", at: "2026-10-26T10:00:00Z" })]);
  const after = task(a, "TST-TASK1");
  assert.equal(after.status, "todo");
  assert.equal(after.run_id, "r1");
  assert.equal(after.run_by, "anna");
  assert.equal(after.run_ended, "2026-10-26T10:00:00Z");
});

test("different fields land from both machines; the same field becomes a conflict, nothing is lost", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  await a.submit([op("set", { id: "TST-TASK1", field: "priority", value: "high", expect: undefined })]);
  await b.submit([op("set", { id: "TST-TASK1", field: "assignee", value: "ergo", expect: undefined })]);
  await a.sync();
  assert.equal(task(a, "TST-TASK1").priority, "high");
  assert.equal(task(a, "TST-TASK1").assignee, "ergo");
  await b.submit([op("set", { id: "TST-TASK2", field: "priority", value: "urgent", expect: undefined })]);
  await a.submit([op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: undefined })]);
  assert.equal(task(a, "TST-TASK2").priority, "urgent");
  assert.equal(a.state.conflicts.length, 1);
  assert.match(a.state.conflicts[0]!.reason, /priority of TST-TASK2 is now "urgent"/);
});

test("with the remote unreachable, operations survive a restart and are pushed once it is back", async () => {
  const f = fixture();
  const journalPath = join(f.dir, "anna.journal.json");
  const offline = f.sync("anna", {
    runner: scriptedGit({ fetch: async () => UNREACHABLE, push: async () => UNREACHABLE }),
  });
  await offline.submit([op("set", { id: "TST-TASK1", field: "priority", value: "high", expect: undefined })]);
  assert.equal(task(offline, "TST-TASK1").priority, "high", "visible locally at once");
  assert.equal(offline.state.pending, 1);
  const back = new (offline.constructor as typeof import("./space-sync.ts").SpaceSync)({ root: offline.root, branch: "main", journalPath });
  await back.sync();
  assert.equal(back.state.pending, 0);
  const check = f.sync("check");
  assert.equal(task(check, "TST-TASK1").priority, "high");
});

test("a feature completes once when two machines finish its last two tasks at once", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  await Promise.all([
    a.submit([op("status", { id: "TST-TASK1", to: "done", expect: "todo" })]),
    b.submit([op("status", { id: "TST-TASK2", to: "done", expect: "todo" })]),
  ]);
  await a.sync();
  await b.sync();
  await a.sync();
  assert.equal(a.plan.entities.get("TST-FEAT0")!.entity.status, "done");
  assert.deepEqual([...a.state.conflicts, ...b.state.conflicts], []);
  const featureCommits = sh(f.remote, "log", "-p", "main", "--", "features").split("\n").filter((l) => l === "+status: done");
  assert.equal(featureCommits.length, 1);
});

test("a task closed by hand in another clone completes the feature after a fetch; manual done stands until the next task change", async () => {
  const f = fixture();
  const a = f.sync("anna");
  f.external("ergo", (root) => {
    for (const name of ["TST-TASK1-one.md", "TST-TASK2-two.md"]) {
      const path = join(root, "tasks", name);
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: done"));
    }
  });
  await a.sync();
  assert.equal(a.plan.entities.get("TST-FEAT0")!.entity.status, "done");

  const g = fixture();
  const p = g.sync("anna");
  await p.submit([op("set", { id: "TST-FEAT0", field: "status", value: "done", expect: "active" })]);
  await p.sync();
  assert.equal(p.plan.entities.get("TST-FEAT0")!.entity.status, "done", "manual done stands");
  await p.submit([op("status", { id: "TST-TASK1", to: "done", expect: "todo" })]);
  assert.equal(p.plan.entities.get("TST-FEAT0")!.entity.status, "active", "TASK2 is still open");
});

test("an invalid file is listed and left untouched; duplicate ids refuse writes", async () => {
  const f = fixture();
  f.external("ergo", (root) => {
    writeFileSync(join(root, "tasks", "TST-BADXX-broken.md"), "---\nid: TST-BADXX\ntype: task\n---\nno title\n");
    writeFileSync(join(root, "tasks", "TST-TASK1-copy.md"), readFileSync(join(root, "tasks", "TST-TASK1-one.md"), "utf8"));
  });
  const a = f.sync("anna");
  assert.ok(a.plan.problems.some((p) => p.path === "tasks/TST-BADXX-broken.md"));
  assert.ok(a.plan.duplicates.has("TST-TASK1"));
  await a.submit([op("set", { id: "TST-TASK1", field: "priority", value: "high", expect: undefined })]);
  assert.match(a.state.conflicts[0]!.reason, /two files/);
  const check = f.sync("check");
  assert.ok(readFileSync(join(check.root, "tasks", "TST-BADXX-broken.md"), "utf8").includes("no title"));
});

test("a not-started claim leaves the in-memory plan at origin, and a manual feature status stands", async () => {
  const f = fixture();
  let down = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  await a.submit([op("set", { id: "TST-FEAT0", field: "status", value: "done", expect: "active" })]);
  down = true;
  assert.equal((await a.claim("TST-TASK1", run("anna"))).result, "not_started");
  assert.equal(task(a, "TST-TASK1").status, "todo", "the claim is not visible after it was not started");
  down = false;
  const before = remoteLog(f.remote).length;
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "no spurious feature write");
  assert.equal(a.plan.entities.get("TST-FEAT0")!.entity.status, "done");
});

test("an entity directory that is a symlink is listed as a problem and never written through", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "dashboard-outside-"));
  const target = join(outside, "milestones");
  mkdirSync(target);
  const file = "---\nid: TST-MILE1\ntype: milestone\ntitle: Outside\nstatus: planned\n---\n";
  writeFileSync(join(target, "TST-MILE1-outside.md"), file);
  f.external("ergo", (root) => symlinkSync(target, join(root, "milestones")));
  const a = f.sync("anna");
  assert.ok(a.plan.problems.some((p) => p.path === "milestones/"));
  assert.equal(a.plan.entities.has("TST-MILE1"), false);
  await a.submit([op("set", { id: "TST-MILE1", field: "title", value: "pwned", expect: undefined })]);
  assert.equal(readFileSync(join(target, "TST-MILE1-outside.md"), "utf8"), file);
  await a.submit([
    op("create", { type: "milestone", id: "TST-MILE2", fields: { title: "new", status: "planned" }, body: "" }),
  ]);
  assert.equal(existsSync(join(target, "TST-MILE2-new.md")), false);
  assert.equal(a.state.pending, 0, "refused, not stuck");
});

test("a branch name that could be read as an option is refused", () => {
  const f = fixture();
  assert.throws(
    () => new SpaceSync({ root: f.clone("anna"), branch: "--upload-pack=/tmp/x", journalPath: join(f.dir, "j.json") }),
    /unsafe branch name/,
  );
});

test("a derived feature transition whose push failed is computed again once origin answers", async () => {
  const f = fixture();
  let down = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  f.external("ergo", (root) => {
    for (const name of ["TST-TASK1-one.md", "TST-TASK2-two.md"]) {
      const path = join(root, "tasks", name);
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: done"));
    }
  });
  down = true;
  await a.sync();
  down = false;
  await a.sync();
  const check = f.sync("check");
  assert.equal(check.plan.entities.get("TST-FEAT0")!.entity.status, "done");
});

function closeBothTasks(root: string): void {
  for (const name of ["TST-TASK1-one.md", "TST-TASK2-two.md"]) {
    const path = join(root, "tasks", name);
    writeFileSync(path, readFileSync(path, "utf8").replace("status: todo", "status: done"));
  }
}

function setFeatureStatus(from: string, to: string): (root: string) => void {
  return (root) => {
    const path = join(root, "features", "TST-FEAT0-totp.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(`status: ${from}`, `status: ${to}`));
  };
}

test("a person's feature status set during a push outage stands over the pending derived one", async () => {
  const f = fixture();
  let down = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  f.external("ergo", closeBothTasks);
  down = true;
  await a.sync();
  assert.equal(a.plan.entities.get("TST-FEAT0")!.entity.status, "done", "derived locally");
  await a.submit([op("set", { id: "TST-FEAT0", field: "status", value: "active", expect: "done" })]);
  down = false;
  await a.sync();
  const check = f.sync("check");
  assert.equal(check.plan.entities.get("TST-FEAT0")!.entity.status, "active");
});

test("a pending derived transition is dropped when someone edited the feature's status on origin since", async () => {
  const f = fixture();
  let cut = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (cut ? CUT : real()) }) });
  f.external("ergo", closeBothTasks);
  cut = true;
  await a.sync();
  assert.equal(a.state.pending, 1, "the derived transition waits in the journal");
  f.external("ergo", setFeatureStatus("active", "done"));
  f.external("ergo", setFeatureStatus("done", "active"));
  cut = false;
  const before = remoteLog(f.remote).length;
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "nothing pushed over the person's choice");
  assert.equal(a.plan.entities.get("TST-FEAT0")!.entity.status, "active");
  assert.equal(a.state.pending, 0);
});

function closeBothAndAddLoose(root: string): void {
  closeBothTasks(root);
  writeFileSync(
    join(root, "tasks", "TST-TASK3-three.md"),
    "---\nid: TST-TASK3\ntype: task\ntitle: three\nstatus: todo\nproject: core\n---\n\n## Brief\n\nThree.\n",
  );
}

test("transitions answering origin's changes survive a claim that does not start, and ride with one that wins", async () => {
  const f = fixture();
  let down = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  f.external("ergo", closeBothAndAddLoose);
  down = true;
  assert.equal((await a.claim("TST-TASK3", run("anna"))).result, "not_started");
  down = false;
  await a.sync();
  assert.equal(f.sync("check").plan.entities.get("TST-FEAT0")!.entity.status, "done");

  const g = fixture();
  const b = g.sync("anna");
  g.external("ergo", closeBothAndAddLoose);
  const before = remoteLog(g.remote).length;
  assert.equal((await b.claim("TST-TASK3", run("anna"))).result, "won");
  assert.equal(remoteLog(g.remote).length, before + 1, "one commit carries the claim and the transition");
  assert.equal(g.sync("check").plan.entities.get("TST-FEAT0")!.entity.status, "done");
  assert.equal(b.state.pending, 0);
});

test("a body line that reads like a status does not drop a pending derived transition", async () => {
  const f = fixture();
  let cut = false;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (cut ? CUT : real()) }) });
  f.external("ergo", closeBothTasks);
  cut = true;
  await a.sync();
  f.external("ergo", (root) => {
    const path = join(root, "features", "TST-FEAT0-totp.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nstatus: notes about the rollout\n`);
  });
  cut = false;
  await a.sync();
  assert.equal(f.sync("check").plan.entities.get("TST-FEAT0")!.entity.status, "done");
});

test("a claim replayed after a rejected push derives only what origin brought, never its own unstarted claim", async () => {
  const f = fixture();
  let pushes = 0;
  const a = f.sync("anna", {
    runner: scriptedGit({
      push: async (real) => {
        pushes += 1;
        if (pushes === 1) {
          f.external("bob", (root) => writeFileSync(join(root, "notes.txt"), "unrelated\n"));
          return real();
        }
        return pushes === 2 ? UNREACHABLE : real();
      },
    }),
  });
  f.external("ergo", setFeatureStatus("active", "done"));
  assert.equal((await a.claim("TST-TASK1", run("anna"))).result, "not_started");
  assert.equal(pushes, 2, "rejected once, then unreachable");
  const before = remoteLog(f.remote).length;
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "nothing pushed");
  assert.equal(a.state.pending, 0);
  assert.equal(f.sync("check").plan.entities.get("TST-FEAT0")!.entity.status, "done", "the manual done stands");
});

test("own changes that landed without an answer are not taken for origin's changes next time", async () => {
  const f = fixture();
  let cut = true;
  const a = f.sync("anna", { runner: scriptedGit({ push: async (real) => (cut ? (await real(), CUT) : real()) }) });
  await a.submit([op("status", { id: "TST-TASK1", to: "done", expect: "todo" })]);
  f.external("ergo", setFeatureStatus("active", "done"));
  cut = false;
  const before = remoteLog(f.remote).length;
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "nothing pushed");
  assert.equal(f.sync("check").plan.entities.get("TST-FEAT0")!.entity.status, "done", "the manual done stands");
});

test("record answers each operation's outcome to its caller; a refusal is not also a conflict", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const ok = op("set", { id: "TST-TASK1", field: "priority", value: "high", expect: undefined });
  const refused = op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: "urgent" });
  const outcomes = await a.record([ok, refused]).outcomes;
  assert.equal(outcomes.get(ok.op_id)?.status, "applied");
  assert.equal(outcomes.get(refused.op_id)?.status, "refused");
  assert.deepEqual(a.state.conflicts, [], "the caller heard it");
  assert.equal(task(a, "TST-TASK1").priority, "high", "applied locally before any push");
  await a.sync();
  assert.equal(task(f.sync("check"), "TST-TASK1").priority, "high", "pushed by the background sync");
});

test("record's outcome survives a sync that picks the operation up first", async () => {
  const f = fixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const a = f.sync("anna", {
    runner: scriptedGit({
      fetch: async (real) => {
        if (first) {
          first = false;
          await gate;
        }
        return real();
      },
    }),
  });
  const running = a.sync();
  const refused = op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: "urgent" });
  const recorded = a.record([refused]);
  release();
  await running;
  const outcomes = await recorded.outcomes;
  assert.equal(outcomes.get(refused.op_id)?.status, "refused", "the sync's outcome reached the caller");
  assert.deepEqual(a.state.conflicts, []);
});

test("an operation whose caller stopped waiting reports its refusal as a conflict", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const refused = op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: "urgent" });
  const { outcomes, forget } = a.record([refused]);
  forget();
  await outcomes;
  assert.equal(a.state.conflicts.length, 1);
});

test("a refusal a sync already recorded for a caller who then stopped waiting becomes a conflict", async () => {
  const f = fixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const a = f.sync("anna", {
    runner: scriptedGit({
      fetch: async (real) => {
        if (first) {
          first = false;
          await gate;
        }
        return real();
      },
    }),
  });
  const running = a.sync();
  const refused = op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: "urgent" });
  const recorded = a.record([refused]);
  release();
  await running;
  assert.deepEqual(a.state.conflicts, [], "held for the caller");
  recorded.forget();
  assert.equal(a.state.conflicts.length, 1);
  await recorded.outcomes;
  assert.equal(a.state.conflicts.length, 1, "reported once");
});

test("when the local pass fails, the caller gets the error and later refusals are conflicts", async () => {
  const f = fixture();
  let failCommit = true;
  const a = f.sync("anna", {
    runner: {
      run: (cwd, args, timeoutMs) =>
        failCommit && args.includes("commit")
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: Unable to create index.lock", timedOut: false })
          : systemGit.run(cwd, args, timeoutMs),
    },
  });
  const ok = op("set", { id: "TST-TASK1", field: "priority", value: "high", expect: undefined });
  const refused = op("set", { id: "TST-TASK2", field: "priority", value: "low", expect: "urgent" });
  await assert.rejects(a.record([ok, refused]).outcomes, /index\.lock/);
  failCommit = false;
  await a.sync();
  await a.sync();
  assert.equal(a.state.conflicts.length, 1, "the refusal is reported");
  assert.equal(task(f.sync("check"), "TST-TASK1").priority, "high");
});

const CORE = { remote: "git@github.com:acme/core.git", trunk: "main" };

test("a pinned color whose change is refused is dropped with it: no commit, no conflict", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const before = remoteLog(f.remote).length;
  // Adding a line that already exists is refused; the color pinned for it must not land alone.
  const refused = op("project", { key: "core", value: { remote: "https://github.com/acme/other", trunk: "main" }, expect: null });
  const pin = op("project", { key: "core", value: { ...CORE, color: "#3e8eed" }, expect: CORE, pin: refused.op_id });
  const recorded = a.record([refused, pin]);
  recorded.forget();
  const outcomes = await recorded.outcomes;
  assert.equal(outcomes.size, 0, "the caller stopped waiting");
  await a.sync();
  assert.equal(remoteLog(f.remote).length, before, "nothing committed, not even the color");
  assert.equal(a.plan.space!.projects.core!.color, undefined);
  assert.deepEqual(a.state.conflicts.map((c) => c.op_id), [refused.op_id], "only the change itself is a conflict");
  assert.equal(a.state.pending, 0);
});

test("a pin refused after its caller stopped waiting is dropped, never a conflict; its change still lands", async () => {
  const f = fixture();
  const a = f.sync("anna");
  // Someone names core's color while this machine pins the default it drew.
  f.external("ergo", (root) => {
    const path = join(root, "space.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("trunk: main }", 'trunk: main, color: "#e5484d" }'));
  });
  await a.sync();
  const add = op("project", { key: "lib", value: { remote: "https://github.com/acme/lib", trunk: "main", color: "#30a46c" }, expect: null });
  const pin = op("project", { key: "core", value: { ...CORE, color: "#3e8eed" }, expect: CORE, pin: add.op_id });
  const recorded = a.record([add, pin]);
  recorded.forget();
  await recorded.outcomes;
  await a.sync();
  assert.deepEqual(a.state.conflicts, []);
  assert.equal(a.state.pending, 0);
  const check = f.sync("check").plan.space!.projects;
  assert.equal(check.lib?.remote, "https://github.com/acme/lib", "the change landed");
  assert.equal(check.core!.color, "#e5484d", "their color stands");
});

test("a pin applies only right after its own change applied", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const add = op("project", { key: "lib", value: { remote: "https://github.com/acme/lib", trunk: "main" }, expect: null });
  const pin = op("project", { key: "core", value: { ...CORE, color: "#3e8eed" }, expect: CORE, pin: add.op_id });
  const outcomes = await a.record([add, pin]).outcomes;
  assert.deepEqual([outcomes.get(add.op_id)?.status, outcomes.get(pin.op_id)?.status], ["applied", "applied"]);
  await a.sync();
  assert.equal(f.sync("check").plan.space!.projects.core!.color, "#3e8eed");
});

test("two machines adding different labels to one task both land; a removal on one keeps the other's addition", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  // Both sync before either writes, so each one's push is made from the same origin.
  await Promise.all([a.sync(), b.sync()]);
  await a.submit([op("label", { id: "TST-TASK1", label: "backend", add: true })]);
  await b.submit([op("label", { id: "TST-TASK1", label: "bug", add: true })]);
  await a.sync();
  assert.deepEqual(task(a, "TST-TASK1").labels, ["backend", "bug"]);
  assert.deepEqual(a.state.conflicts.concat(b.state.conflicts), []);

  await a.submit([op("label", { id: "TST-TASK1", label: "Backend", add: false })]);
  await b.submit([op("label", { id: "TST-TASK1", label: "ui", add: true })]);
  await a.sync();
  await b.sync();
  assert.deepEqual(task(a, "TST-TASK1").labels, ["bug", "ui"]);
  assert.deepEqual(task(b, "TST-TASK1").labels, ["bug", "ui"]);
  assert.equal(a.state.pending + b.state.pending, 0);
  assert.deepEqual(a.state.conflicts.concat(b.state.conflicts), []);
  assert.deepEqual(task(f.sync("check"), "TST-TASK1").labels, ["bug", "ui"], "origin has both");
});

test("the same label typed on two machines is defined once, in the color the first push chose", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const b = f.sync("ergo");
  await Promise.all([a.sync(), b.sync()]);
  await a.submit([
    op("label_def", { name: "bug", value: { color: "#3e8eed" }, expect: null, if_absent: true }),
    op("label", { id: "TST-TASK1", label: "bug", add: true }),
  ]);
  await b.submit([
    op("label_def", { name: "Bug", value: { color: "#e5484d" }, expect: null, if_absent: true }),
    op("label", { id: "TST-TASK2", label: "Bug", add: true }),
  ]);
  await a.sync();
  assert.deepEqual(Object.keys(a.plan.space!.labels), ["bug"]);
  assert.equal(a.plan.space!.labels.bug!.color, "#3e8eed");
  assert.deepEqual(task(a, "TST-TASK2").labels, ["bug"], "written as the palette spells it once the other push won");
  assert.deepEqual(a.state.conflicts.concat(b.state.conflicts), []);
  assert.equal(remoteLog(f.remote).filter((line) => /dashboard:/.test(line)).length, 2, "each machine's label and its definition went in one commit");
});

test("labels cannot be overwritten by a set; an unusable label is refused", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const set = op("set", { id: "TST-TASK1", field: "labels", value: ["x"], expect: undefined });
  const bad = op("label", { id: "TST-TASK1", label: "#nope", add: true });
  const outcomes = await a.record([set, bad]).outcomes;
  assert.match(String((outcomes.get(set.op_id) as { reason?: string }).reason), /labels cannot be set directly/);
  assert.match(String((outcomes.get(bad.op_id) as { reason?: string }).reason), /not a usable label/);
  assert.deepEqual(task(a, "TST-TASK1").labels, []);
});

test("a claim with create makes the task todo and claims it in one commit; a cut or failed one leaves nothing behind", async () => {
  const f = fixture();
  const a = f.sync("anna");
  const before = remoteLog(f.remote).length;
  const create = { fields: { title: "Own work", project: "core", run_id: "r-sneaky", progress_note: "x" }, body: "\n## Brief\n\nTracked.\n" };
  assert.equal((await a.claim("TST-ADPT1", run("anna", "r-adopt"), undefined, create)).result, "won");
  assert.equal(remoteLog(f.remote).length, before + 1, "one commit for the task and its claim");
  const adopted = task(a, "TST-ADPT1");
  assert.deepEqual([adopted.status, adopted.run_id, adopted.run_branch, adopted.progress_note], ["in_progress", "r-adopt", "feat/totp", undefined], "the create writes no run or progress field");
  const b = f.sync("ergo");
  await b.sync();
  assert.equal(task(b, "TST-ADPT1").run_id, "r-adopt", "on origin");
  // The same id again is someone else's task: refused, not claimed over.
  assert.equal((await b.claim("TST-ADPT1", run("ergo", "r-other"), undefined, create)).result, "refused");
  assert.equal(task(b, "TST-ADPT1").run_id, "r-adopt");

  // Unreachable before sending: nothing was created, and nothing is pushed later.
  let down = true;
  const c = f.sync("carl", { runner: scriptedGit({ push: async (real) => (down ? UNREACHABLE : real()) }) });
  assert.equal((await c.claim("TST-ADPT2", run("carl", "r-down"), undefined, create)).result, "not_started");
  down = false;
  await c.sync();
  assert.equal(c.plan.entities.has("TST-ADPT2"), false);
  assert.equal(c.state.pending, 0);

  // Cut midway: undecided, never pushed again; given up later, it leaves no todo task behind.
  let clock = Date.parse("2026-10-26T08:00:00Z");
  let cut = true;
  const decided: boolean[] = [];
  const d = f.sync("dora", { now: () => new Date(clock), runner: scriptedGit({ push: async (real) => (cut ? CUT : real()) }), onClaimDecided: (_t, _r, won) => decided.push(won) });
  assert.equal((await d.claim("TST-ADPT3", run("dora", "r-cut"), undefined, create)).result, "unknown");
  assert.ok(d.takenIds().has("TST-ADPT3"), "its id is not handed out while undecided");
  cut = false;
  const tip = remoteLog(f.remote).length;
  await d.sync();
  clock += 11 * 60_000;
  await d.sync();
  assert.equal(remoteLog(f.remote).length, tip, "never pushed");
  assert.deepEqual([decided, d.plan.entities.has("TST-ADPT3"), d.state.pending], [[false], false, 0]);
});

test("many writes at once push in one pass behind them, not one pass each", async () => {
  const f = fixture();
  let fetches = 0;
  const a = f.sync("ergo", { runner: scriptedGit({ fetch: (real) => ((fetches += 1), real()) }) });
  await a.sync();
  fetches = 0;
  const writes = Array.from({ length: 8 }, (_, i) => a.record([op("set", { id: "TST-TASK1", field: "title", value: `one ${i}`, expect: i ? `one ${i - 1}` : "one" })]).outcomes);
  await Promise.all(writes);
  await a.sync();
  assert.ok(fetches <= 3, `${fetches} fetches for 8 writes`);
  assert.equal(a.state.pending, 0);
  assert.equal(task(a, "TST-TASK1").title, "one 7");
});
