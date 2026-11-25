import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { milestonesCreateInput } from "../../shared/api.ts";
import { Dashboard } from "../dashboard.ts";
import { getTask, listInbox, listTasks, readRoadmap, releaseCheck, startCheck } from "./reads.ts";
import {
  addToInbox,
  createFeature,
  createMilestone,
  createTask,
  releaseTask,
  startTask,
  updateFeature,
  updateMilestone,
  updateTask,
} from "./writes.ts";
import { NOW, projectCheckout, setup } from "./testing.ts";

test("names resolve by id, title or words across spaces; several matches are an error naming them", async () => {
  const s = await setup();
  try {
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).title, "Fix flaky login test");
    assert.equal(getTask(s.ctx, { task: "tst-fx001" }).id, "TST-FX001");
    assert.equal(getTask(s.ctx, { task: "[[TST-FX001-fix-flaky-login-test]]" }).id, "TST-FX001");
    assert.equal(getTask(s.ctx, { task: "fix flaky login test" }).id, "TST-FX001");
    assert.equal(getTask(s.ctx, { task: "flaky" }).id, "TST-FX001");
    const ambiguous = getTask(s.ctx, { task: "login" });
    assert.equal(ambiguous.id, "");
    assert.match(ambiguous.error, /2 tasks match «login»: .*TST-FX001 «Fix flaky login test» \(todo\).*TST-RD002 «Login page redesign» \(in_progress\)/);
    assert.match(getTask(s.ctx, { task: "nothing like it" }).error, /No task matches/);
    assert.match(getTask(s.ctx, { task: "TST-ZZZZZ" }).error, /No task TST-ZZZZZ/);
    assert.match((await listTasks(s.ctx, { space: "Laconote", status: "open", limit: 20 })).error, /No single space matches «Laconote»; spaces: Test space \(TST\)/);
    assert.equal((await listTasks(s.ctx, { space: "test space", status: "open", limit: 20 })).error, "");
  } finally {
    s.stop();
  }
});

test("a task read answers its run, progress, blockers and planned branch", async () => {
  const s = await setup();
  try {
    const held = getTask(s.ctx, { task: "TST-RD002" });
    assert.deepEqual([held.status, held.held_by, held.host, held.since, held.branch], ["in_progress", "anna", "anna-mbp", "08:05", "feat/login-redesign"]);
    assert.equal(held.activity, "running on anna-mbp");
    assert.equal(held.progress, "1 of 2 acceptance lines done");
    const blocked = getTask(s.ctx, { task: "Blocked thing" });
    assert.equal(blocked.blocked_by, "TST-TASK1 «one» (todo)");
    assert.equal(blocked.branch, "task/tst-dep01-blocked-thing");
    assert.equal(blocked.held_by, "");
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).branch, "feat/login", "the only task of its feature in core takes the feature's branch");
    assert.equal(getTask(s.ctx, { task: "TST-TASK1" }).branch, "feat/totp-one", "a feature with two tasks in core: feature branch plus slug");
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).milestone, "Release 2.3 (TST-MS001)", "the feature's milestone applies");
  } finally {
    s.stop();
  }
});

test("task lists filter by status, project, feature, milestone and words", async () => {
  const s = await setup();
  try {
    const open = (await listTasks(s.ctx, { status: "open", limit: 20 }));
    assert.equal(open.total, 6);
    assert.equal((await listTasks(s.ctx, { status: "open", limit: 2 })).shown, 2);
    assert.deepEqual((await listTasks(s.ctx, { status: "in_progress", limit: 20 })).tasks.map((t) => t.id), ["TST-RD002"]);
    assert.deepEqual((await listTasks(s.ctx, { project: "site", status: "open", limit: 20 })).tasks.map((t) => t.id), ["TST-ST001"]);
    assert.deepEqual((await listTasks(s.ctx, { feature: "Login", status: "open", limit: 20 })).tasks.map((t) => t.id), ["TST-FX001"]);
    assert.deepEqual((await listTasks(s.ctx, { milestone: "release 2.3", status: "open", limit: 20 })).tasks.map((t) => t.id), ["TST-FX001"]);
    assert.deepEqual((await listTasks(s.ctx, { query: "login", status: "open", limit: 20 })).tasks.map((t) => t.id).sort(), ["TST-FX001", "TST-RD002"]);
    assert.deepEqual(
      (await listTasks(s.ctx, { query: "redesign", limit: 20 })).tasks.map((t) => [t.id, t.matched_in, t.quote]),
      [["TST-RD002", "title", "Login page redesign"]],
    );
    assert.deepEqual(
      (await listTasks(s.ctx, { query: "feat/login-redesign", limit: 20 })).tasks.map((t) => [t.id, t.matched_in]),
      [["TST-RD002", "branch"]],
    );
    assert.equal((await listTasks(s.ctx, { status: "open", limit: 20 })).tasks.find((t) => t.id === "TST-DEP01")?.blocked, true);
    // Tasks that can start now first, then the blocked one with what it waits for, then the running one.
    assert.deepEqual(open.tasks.map((t) => t.id), ["TST-RD002", "TST-FX001", "TST-ST001", "TST-TASK1", "TST-TASK2", "TST-DEP01"]);
    assert.deepEqual(open.tasks.map((t) => t.blocked_by).filter(Boolean), ["TST-TASK1 «one» (todo)"]);
    assert.match((await listTasks(s.ctx, { project: "ios", status: "open", limit: 20 })).error, /No project «ios»/);
  } finally {
    s.stop();
  }
});

test("the roadmap groups features under releases with per-project progress; features without one are later", async () => {
  const s = await setup();
  try {
    const roadmap = readRoadmap(s.ctx, {});
    assert.equal(roadmap.error, "");
    const release = roadmap.milestones[0]!;
    assert.deepEqual([release.title, release.due, release.days_left, release.done, release.total], ["Release 2.3", "2026-11-30", 35, 0, 1]);
    assert.deepEqual(release.features.map((f) => [f.title, f.projects]), [["Login", "core todo"]]);
    assert.deepEqual(roadmap.later, [{ id: "TST-FEAT0", title: "TOTP", done: 0, total: 2 }]);
    assert.match(readRoadmap(s.ctx, { milestone: "Release 9" }).error, /No milestone matches/);
  } finally {
    s.stop();
  }
});

test("drafts from a meeting land in the plan repo once; asking again skips them", async () => {
  const s = await setup();
  try {
    const input = {
      items: [{ title: "Android: show the QR", project: "core" }, { title: "Decide recovery codes", note: "With security." }],
      source_url: "https://laconote.com/meeting/0d4c7e",
      source_title: "Weekly sync",
    };
    const first = await addToInbox(s.ctx, input);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.created.map((c) => c.title), ["Android: show the QR", "Decide recovery codes"]);
    const pushed = await s.remoteFile(new RegExp(`${first.created[1]!.id}-`));
    assert.match(pushed ?? "", /status: inbox/);
    assert.match(pushed ?? "", /meeting: https:\/\/laconote\.com\/meeting\/0d4c7e/);
    assert.match(pushed ?? "", /meeting_title: Weekly sync/);
    assert.match(pushed ?? "", /With security\./);
    const again = await addToInbox(s.ctx, { ...input, items: [...input.items, { title: "android:  SHOW the QR!" }] });
    assert.deepEqual([again.ok, again.created, again.skipped.length], [true, [], 3]);
    assert.equal((await listInbox(s.ctx, { limit: 20 })).total, 2);
    // One call's drafts keep the order they were given in, though their ids are random.
    assert.deepEqual((await listInbox(s.ctx, { limit: 20 })).items.map((i) => i.title), ["Android: show the QR", "Decide recovery codes"]);
    const created = (await listInbox(s.ctx, { limit: 20 })).items.map((i) => i.created);
    assert.ok(created[0]! < created[1]!, `distinct creation times in the given order: ${created.join(", ")}`);
    const bad = await addToInbox(s.ctx, { items: [{ title: "x", project: "ios" }] });
    assert.deepEqual([bad.ok, bad.created], [false, []]);
    assert.match(bad.error, /No project «ios»/);
  } finally {
    s.stop();
  }
});

test("creating tasks: todo needs a project, references become wikilinks, unknown names refuse", async () => {
  const s = await setup();
  try {
    const todo = await createTask(s.ctx, { title: "Recovery codes", project: "core", feature: "TOTP", depends_on: ["one"], priority: "high", brief: "Generate and verify." });
    assert.equal(todo.ok, true, todo.error);
    assert.equal(todo.status, "todo");
    const file = await s.remoteFile(new RegExp(`${todo.id}-recovery-codes`));
    assert.match(file ?? "", /feature: "\[\[TST-FEAT0-totp\]\]"/);
    assert.match(file ?? "", /depends_on: \["\[\[TST-TASK1-one\]\]"\]/);
    assert.match(file ?? "", /## Brief\n\nGenerate and verify\./);
    assert.equal((await createTask(s.ctx, { title: "Someday" })).status, "inbox");
    assert.match((await createTask(s.ctx, { title: "X", status: "todo" })).error, /needs a project/);
    assert.match((await createTask(s.ctx, { title: "X", project: "core", depends_on: ["login"] })).error, /2 tasks match «login»/);
    assert.match((await createTask(s.ctx, { title: "X", feature: "Payments" })).error, /No feature matches «Payments»/);
  } finally {
    s.stop();
  }
});

test("updating tasks follows the transition table and never touches a live run", async () => {
  const s = await setup();
  try {
    const draft = await createTask(s.ctx, { title: "Draft" });
    const accepted = await updateTask(s.ctx, { task: draft.id, project: "core", status: "todo", title: "Accepted draft" });
    assert.equal(accepted.ok, true, accepted.error);
    assert.deepEqual([accepted.status, accepted.title, accepted.changed], ["todo", "Accepted draft", ["title", "project", "status"]]);
    // A draft accepted without a priority takes the space's default.
    const plain = (await addToInbox(s.ctx, { items: [{ title: "Plain draft" }] })).created[0]!;
    // In memory only: the plan is read again from its files after every write, so after the push
    // the earlier writes started has finished.
    await s.settle();
    const space = [...s.ctx.dashboard.spaces.values()][0]!.sync.plan.space!;
    space.defaults.priority = "low";
    const taken = await updateTask(s.ctx, { task: plain.id, project: "core", status: "todo" });
    assert.deepEqual(taken.changed, ["project", "priority", "status"]);
    assert.match((await s.remoteFile(new RegExp(`${plain.id}-`))) ?? "", /priority: low/);
    const held = await updateTask(s.ctx, { task: "TST-RD002", status: "done" });
    assert.equal(held.ok, false);
    assert.match(held.error, /held by anna on anna-mbp since 08:05; use release_task/);
    const other = await createTask(s.ctx, { title: "Another draft" });
    const skipped = await updateTask(s.ctx, { task: other.id, status: "done" });
    assert.equal(skipped.ok, false);
    assert.match(skipped.error, /inbox → done is not allowed/);
    const brief = await updateTask(s.ctx, { task: "TST-TASK2", brief: "New brief." });
    assert.deepEqual(brief.changed, ["brief"]);
    assert.equal(getTask(s.ctx, { task: "TST-TASK2" }).brief, "New brief.");
    const nothing = await updateTask(s.ctx, { task: "TST-TASK2", title: "two" });
    assert.deepEqual([nothing.ok, nothing.changed], [true, []]);
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "done" })).status, "done");
    assert.equal((await updateTask(s.ctx, { task: "TST-TASK2", status: "todo" })).status, "todo", "reopened");
  } finally {
    s.stop();
  }
});

test("update_task names, changes and takes off the agent profile of a task, as this Mac has it", async () => {
  const s = await setup();
  try {
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).agent_profile, "");
    const set = await updateTask(s.ctx, { task: "TST-FX001", agent_profile: " review " });
    assert.deepEqual([set.ok, set.changed], [true, ["agent_profile"]]);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).agent_profile, "Review", "stored as the profile is spelled");
    assert.match((await startCheck(s.ctx, { task: "TST-FX001" })).profile, /Review \(the task's\)/, "a start uses it");
    const again = await updateTask(s.ctx, { task: "TST-FX001", agent_profile: "Review" });
    assert.deepEqual([again.ok, again.changed], [true, []]);
    const unknown = await updateTask(s.ctx, { task: "TST-FX001", agent_profile: "Sonnet 5.5 High", title: "Renamed" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /no agent profile «Sonnet 5\.5 High» on this Mac; profiles: Review\. Nothing was changed\./);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).title, "Fix flaky login test", "a refusal changes nothing");
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).agent_profile, "Review");
    const off = await updateTask(s.ctx, { task: "TST-FX001", agent_profile: "" });
    assert.deepEqual([off.ok, off.changed], [true, ["agent_profile"]]);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).agent_profile, "");
    assert.deepEqual((await updateTask(s.ctx, { task: "TST-FX001", agent_profile: "" })).changed, [], "nothing to take off");
  } finally {
    s.stop();
  }
});

test("a start check says the agent's objection first, then the base branch's, then the branch's", async () => {
  const s = await setup();
  try {
    s.dashboard.projectRoots.set("prj_core", projectCheckout([], ["feat/login"]));
    const core = s.sync().plan.space!.projects.core!;
    core.trunk = "bad..base";
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Nope" })).error, /There is no agent profile «Nope» on this Mac/);
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" })).error, /The base branch "bad\.\.base" is not usable/);
    core.trunk = "main";
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Nope" })).error, /There is no agent profile «Nope» on this Mac/);
    assert.match((await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" })).error, /A branch feat\/login already exists in core/);
  } finally {
    s.stop();
  }
});

test("a start is checked first: blocked, held and unmapped rules; a startable task is claimed once", async () => {
  const s = await setup();
  try {
    assert.match((await startCheck(s.ctx, { task: "Blocked thing" })).error, /blocked by TST-TASK1 «one» \(todo\)/);
    assert.match((await startCheck(s.ctx, { task: "TST-RD002" })).error, /already started by anna on anna-mbp since 08:05/);
    assert.match((await startCheck(s.ctx, { task: "Site thing" })).error, /Project site is not mapped on this Mac/);
    assert.match((await startCheck(s.ctx, { task: "login" })).error, /2 tasks match/);
    const facts = await startCheck(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.equal(facts.error, "");
    assert.deepEqual([facts.title, facts.project, facts.branch, facts.profile, facts.workspace], ["Fix flaky login test", "core", "feat/login", "Review (asked for); model claude-haiku-5-5 (the profile's)", "a new worktree, «TST-FX001 · Fix flaky login test»"]);
    assert.equal(facts.instructions, "not seen by you yet (per git: ergo)");
    const started = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.branch, "feat/login");
    const task = s.task("TST-FX001")!;
    assert.deepEqual([task.status, task.run_host, task.run_branch], ["in_progress", "ergo-mbp", "feat/login"]);
    const again = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(again.ok, false);
    assert.match(again.error, /already started by .* on ergo-mbp/);
    const file = await s.remoteFile(/TST-FX001-/);
    assert.match(file ?? "", /status: in_progress/);
  } finally {
    s.stop();
  }
});

test("a release names the holder first, then ends the run and keeps its history", async () => {
  const s = await setup();
  try {
    assert.deepEqual(releaseCheck(s.ctx, { task: "Login page" }), { title: "Login page redesign", held_by: "anna", host: "anna-mbp", since: "08:05", error: "" });
    assert.match(releaseCheck(s.ctx, { task: "TST-FX001" }).error, /has no live run/);
    const released = await releaseTask(s.ctx, { task: "TST-RD002", to: "todo" });
    assert.equal(released.ok, true, released.error);
    const task = s.task("TST-RD002")!;
    assert.deepEqual([task.status, task.run_by, task.run_ended], ["todo", "anna", NOW.toISOString()]);
    assert.equal((await releaseTask(s.ctx, { task: "TST-RD002", to: "todo" })).ok, false);
  } finally {
    s.stop();
  }
});

test("milestones and features are created and changed by name", async () => {
  const s = await setup();
  try {
    const release = await createMilestone(s.ctx, { title: "Release 2.4", due: "2026-12-15" });
    assert.equal(release.ok, true, release.error);
    const feature = await createFeature(s.ctx, { title: "Passkeys", milestone: "2.4", branch: "feat/passkeys", projects: ["core", "site"], brief: "WebAuthn." });
    assert.equal(feature.ok, true, feature.error);
    const file = await s.remoteFile(new RegExp(`${feature.id}-passkeys`));
    assert.match(file ?? "", new RegExp(`milestone: "\\[\\[${release.id}-release-2-4\\]\\]"`));
    assert.match(file ?? "", /projects: \[core, site\]/);
    assert.match((await createFeature(s.ctx, { title: "X", branch: "--upload-pack=x" })).error, /not a usable branch name/);
    assert.equal((await updateMilestone(s.ctx, { milestone: "Release 2.4", status: "active", due: "2026-12-20" })).ok, true);
    assert.equal(readRoadmap(s.ctx, { milestone: "2.4" }).milestones[0]?.due, "2026-12-20");
    assert.equal((await updateFeature(s.ctx, { feature: "Passkeys", title: "Passkeys everywhere", status: "active" })).title, "Passkeys everywhere");
    assert.match((await updateFeature(s.ctx, { feature: "Login", milestone: "Release" })).error, /2 milestones match «Release»/);
  } finally {
    s.stop();
  }
});

test("a second installation answers every write with the owner's reason", async () => {
  const s = await setup();
  const second = new Dashboard({ dataDir: s.dashboard.dataDir });
  await second.start();
  try {
    const ctx = { dashboard: second };
    assert.match((await createTask(ctx, { title: "X", project: "core" })).error, /another copy/);
    assert.match((await addToInbox(ctx, { items: [{ title: "X" }] })).error, /another copy/);
    assert.match((await startCheck(ctx, { task: "TST-FX001" })).error, /another copy/);
    assert.match(getTask(ctx, { task: "TST-FX001" }).error, /another copy/);
  } finally {
    second.stop();
    s.stop();
  }
});

test("names match whole words only: a fragment never picks a task for a write", async () => {
  const s = await setup();
  try {
    assert.match(getTask(s.ctx, { task: "ne" }).error, /No task matches «ne»/);
    assert.match(getTask(s.ctx, { task: "laky" }).error, /No task matches/);
    const refused = await updateTask(s.ctx, { task: "ne", status: "canceled" });
    assert.equal(refused.ok, false);
    assert.equal(s.task("TST-TASK1")?.status, "todo");
  } finally {
    s.stop();
  }
});

test("an update the transition table refuses changes nothing, not even its other fields", async () => {
  const s = await setup();
  try {
    const draft = await createTask(s.ctx, { title: "Draft" });
    const done = await updateTask(s.ctx, { task: draft.id, title: "Renamed draft", status: "done" });
    assert.equal(done.ok, false);
    assert.match(done.error, /inbox → done is not allowed. Nothing was changed/);
    assert.deepEqual(done.changed, []);
    assert.equal(s.task(draft.id)?.title, "Draft");
    const noProject = await updateTask(s.ctx, { task: draft.id, priority: "high", status: "todo" });
    assert.match(noProject.error, /needs a project before it is accepted/);
    assert.equal(s.task(draft.id)?.priority, undefined);
  } finally {
    s.stop();
  }
});

test("a start re-checks on fetched state: a task that ran elsewhere meanwhile is not claimed", async () => {
  const s = await setup();
  try {
    s.f.external("anna", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      const ended = "run_id: r-old\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/login\nrun_started: 2026-10-20T08:00:00Z\nrun_ended: 2026-10-21T08:00:00Z\n";
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", `status: todo\n${ended}`));
    });
    assert.equal((await startCheck(s.ctx, { task: "TST-FX001" })).error, "", "the local index has not fetched it yet");
    const started = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(started.ok, false);
    assert.match(started.error, /was started and released elsewhere since it was checked; check it again/);
    assert.equal(s.task("TST-FX001")?.status, "todo");
  } finally {
    s.stop();
  }
});

test("headings inside a brief stay inside it and never become acceptance lines", async () => {
  const s = await setup();
  try {
    const created = await createTask(s.ctx, { title: "Headings", project: "core", brief: "Intro.\n\n## Context\n\nWhy.\n\n## Acceptance\n\n- [ ] injected line" });
    const read = getTask(s.ctx, { task: created.id });
    assert.match(read.brief, /Intro\.[\s\S]*### Context[\s\S]*Why\.[\s\S]*injected line/);
    assert.deepEqual(read.acceptance, []);
    await updateTask(s.ctx, { task: created.id, brief: "# New\n\nText." });
    assert.equal(getTask(s.ctx, { task: created.id }).brief, "### New\n\nText.");
  } finally {
    s.stop();
  }
});

test("concurrent identical drafts are created once", async () => {
  const s = await setup();
  try {
    const input = { items: [{ title: "Same draft" }], source_url: "https://laconote.com/meeting/abc/" };
    const results = await Promise.all([addToInbox(s.ctx, input), addToInbox(s.ctx, input)]);
    assert.equal(results.flatMap((r) => r.created).length, 1);
    assert.equal(results.flatMap((r) => r.skipped).length, 1);
    assert.equal((await listInbox(s.ctx, { limit: 20 })).total, 1);
  } finally {
    s.stop();
  }
});

test("with two spaces: names resolve across both, ambiguity names both, creates ask which space", async () => {
  const s = await setup();
  try {
    const remote = join(mkdtempSync(join(tmpdir(), "dashboard-other-")), "plan.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await s.dashboard.addSpace({ remote, key: "OTH", name: "Other" });
    assert.match((await createTask(s.ctx, { title: "Fix flaky login test" })).error, /Say which space: spaces: Test space \(TST\), Other \(OTH\)/);
    const other = await createTask(s.ctx, { space: "other", title: "Fix flaky login test" });
    assert.equal(other.ok, true, other.error);
    assert.match(other.id, /^OTH-/);
    assert.match(getTask(s.ctx, { task: "flaky" }).error, /2 tasks match «flaky»: .*TST-FX001.*OTH-/);
    assert.equal(getTask(s.ctx, { task: other.id }).id, other.id);
    assert.equal((await listTasks(s.ctx, { space: "OTH", status: "all", limit: 20 })).total, 1);
    assert.match((await createTask(s.ctx, { space: "TST", title: "X", depends_on: [other.id] })).error, new RegExp(`No task ${other.id}`), "references stay inside a space");
  } finally {
    s.stop();
  }
});

test("dates must be real calendar days", () => {
  assert.equal(milestonesCreateInput.safeParse({ title: "R", due: "2026-02-30" }).success, false);
  assert.equal(milestonesCreateInput.safeParse({ title: "R", due: "2026-02-28" }).success, true);
});

test("a start that loses to another machine's fresh claim names who holds it", async () => {
  const s = await setup();
  try {
    s.f.external("anna", (root) => {
      const path = join(root, "tasks", "TST-FX001-fix-flaky-login-test.md");
      const live = "run_id: r-anna2\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/login\nrun_started: 2026-10-26T07:00:00Z\n";
      writeFileSync(path, readFileSync(path, "utf8").replace("status: todo\n", `status: in_progress\n${live}`));
    });
    const started = await startTask(s.ctx, { task: "TST-FX001" });
    assert.equal(started.ok, false);
    assert.match(started.error, /already started by anna on anna-mbp/);
  } finally {
    s.stop();
  }
});
