import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { NOW, setup } from "../api/testing.ts";
import { addToInbox, updateTask, type WriteContext } from "../api/writes.ts";
import { Dashboard } from "../dashboard.ts";
import { FakePaseo } from "../runner/testing.ts";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { putPerson } from "../api/team.ts";
import { readMirror, setMirror } from "./mirror-rpc.ts";
import { issueContent, mirrorMarker } from "./mirror.ts";
import { importIssues } from "./import.ts";
import { IssueWriter } from "./forge-write.ts";

/**
 * The issue mirror against a faked GitHub: `gh api` answered from memory. The TST space's projects
 * are acme/core and acme/site on github.com (api/testing.ts).
 */

interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  state: "open" | "closed";
  state_reason?: string;
}

interface Call {
  method: string;
  endpoint: string;
  body?: Record<string, unknown>;
}

function fakeGithub() {
  const issues: FakeIssue[] = [];
  const calls: Call[] = [];
  const forge = {
    issues,
    calls,
    /** `offline`: every call fails; `lost`: a create is made but its answer never arrives. */
    mode: "ok" as "ok" | "offline" | "lost" | "rate",
    /** Repositories the login may only read: the forge still lets it open issues in a public one. */
    readOnly: new Set<string>(),
    writes: () => calls.filter((c) => c.method !== "GET"),
    reset: () => calls.splice(0),
  };
  const runner: CommandRunner = async (command, args) => {
    if (command === "gh" && args[0] === "issue" && args[1] === "list") {
      const listed = issues.filter((i) => i.repo === "acme/core" && i.state === "open");
      return { code: 0, stdout: JSON.stringify(listed.map((i) => ({ number: i.number, title: i.title, url: `https://github.com/${i.repo}/issues/${i.number}`, labels: [], milestone: null, body: i.body }))) };
    }
    if (command !== "gh" || args[0] !== "api") return { code: 1, stdout: "", stderr: "not faked" };
    const method = args[1] === "-X" ? args[2]! : "GET";
    const endpoint = args[1] === "-X" ? args[3]! : args[1]!;
    const at = args.indexOf("--input");
    const body = at > 0 ? (JSON.parse(readFileSync(args[at + 1]!, "utf8")) as Record<string, unknown>) : undefined;
    calls.push({ method, endpoint, ...(body ? { body } : {}) });
    if (forge.mode === "offline") return { code: 1, stdout: "", stderr: "error connecting to api.github.com" };
    if (forge.mode === "rate" && method !== "GET") return { code: 1, stdout: "", stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)" };
    const create = /^repos\/([^/]+\/[^/]+)\/issues$/.exec(endpoint);
    if (create && method === "POST") {
      const repo = create[1]!;
      const issue: FakeIssue = {
        repo,
        number: Math.max(0, ...issues.filter((i) => i.repo === repo).map((i) => i.number)) + 1,
        title: String(body!.title),
        body: String(body!.body),
        labels: body!.labels as string[],
        assignees: body!.assignees as string[],
        state: "open",
      };
      issues.push(issue);
      if (forge.mode === "lost") return { code: 1, stdout: "", stderr: "context deadline exceeded" };
      return { code: 0, stdout: JSON.stringify({ number: issue.number, html_url: `https://github.com/${repo}/issues/${issue.number}` }) };
    }
    const edit = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(endpoint);
    if (edit && method === "PATCH") {
      const issue = issues.find((i) => i.repo === edit[1] && i.number === Number(edit[2]));
      if (!issue) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      Object.assign(issue, body);
      return { code: 0, stdout: JSON.stringify({ number: issue.number }) };
    }
    const list = /^repos\/([^/]+\/[^/]+)\/issues\?/.exec(endpoint);
    if (list && method === "GET") {
      const answer = issues.filter((i) => i.repo === list[1]).map((i) => ({ number: i.number, body: i.body, html_url: `https://github.com/${i.repo}/issues/${i.number}` }));
      return { code: 0, stdout: JSON.stringify(answer) };
    }
    const repo = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (repo && method === "GET") {
      const push = !forge.readOnly.has(repo[1]!);
      return { code: 0, stdout: JSON.stringify({ visibility: repo[1] === "acme/site" ? "public" : "private", private: repo[1] !== "acme/site", permissions: { admin: false, maintain: false, push, triage: false, pull: true } }) };
    }
    return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  };
  return { forge, cli: new ForgeCli(runner) };
}

const MIRROR = { everyMs: 3_600_000, spacingMs: 0 };

/** Another machine on the same plan repository, with its own clone, data and forge CLI. */
async function machine(remote: string, cli: ForgeCli): Promise<{ dashboard: Dashboard; ctx: WriteContext }> {
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-mirror-")), fetchIntervalMs: 3_600_000, forge: cli, mirror: MIRROR });
  dashboard.attach(new FakePaseo({ profiles: [] }).api());
  await dashboard.addSpace({ remote });
  return { dashboard, ctx: { dashboard, now: () => NOW, host: "anna-mbp" } };
}

/** Pushes what is pending, mirrors once, and pushes the links the mirror wrote. */
async function round(dashboard: Dashboard): Promise<void> {
  const sync = dashboard.spaces.get("TST")!.sync;
  await sync.sync();
  await dashboard.mirror.pass();
  await sync.sync();
}

const created = (forge: ReturnType<typeof fakeGithub>["forge"]) => forge.calls.filter((c) => c.method === "POST");

test("turning the mirror on needs a confirmation and names the public repositories", async () => {
  const { cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    const refused = setMirror(a.ctx, { space: "TST", on: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /public in a public repository/);
    assert.equal((await readMirror(a.ctx, { space: "TST" })).on, false, "off by default");
    const read = await readMirror(a.ctx, { space: "TST", visibility: true });
    assert.deepEqual(
      read.repositories.map((r) => [r.repository, r.visibility, r.write]),
      [
        ["github.com/acme/core", "private", true],
        ["github.com/acme/site", "public", true],
      ],
    );
    assert.equal(setMirror(a.ctx, { space: "TST", on: true, confirmed: true }).ok, true);
    assert.equal((await readMirror(a.ctx, { space: "TST" })).on, true);
  } finally {
    a.stop();
  }
});

test("a task moved to todo gets one issue, with its link written back; a machine without the switch writes none", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  const other = fakeGithub();
  const b = await machine(a.f.remote, other.cli);
  try {
    const draft = (await addToInbox(a.ctx, { items: [{ title: "Dark mode", project: "core" }] })).created[0]!.id;
    await putPerson(a.ctx, { space: "TST", key: "anna", name: "Anna", github: "anna-gh", emails: [], gitlab: [] });
    await updateTask(a.ctx, { task: draft, assignee: "anna", add_labels: ["ui"] });
    assert.equal(setMirror(a.ctx, { space: "TST", on: true, confirmed: true }).ok, true);
    await round(a.dashboard);
    const first = created(forge).length;
    assert.ok(first > 0, "the open tasks got issues");
    assert.ok(!forge.issues.some((i) => i.title === "Dark mode"), "an inbox draft gets none");
    assert.equal(a.task(draft)!.issue, undefined);

    forge.reset();
    await updateTask(a.ctx, { task: draft, status: "todo" });
    await round(a.dashboard);
    assert.equal(created(forge).length, 1, "one issue for the accepted task");
    const issue = forge.issues.find((i) => i.title === "Dark mode")!;
    assert.equal(issue.repo, "acme/core", "in its project's repository");
    assert.deepEqual(issue.labels, ["ui"]);
    assert.deepEqual(issue.assignees, ["anna-gh"], "the person's GitHub login from people");
    assert.match(issue.body, new RegExp(`Task ${draft} of Test space \\(TST\\)\\. The plan is the source`));
    assert.ok(issue.body.includes(mirrorMarker("TST", draft)));
    const url = `https://github.com/acme/core/issues/${issue.number}`;
    assert.equal(a.task(draft)!.issue, url, "the link is on the task");
    assert.equal(a.sync().state.pending, 0, "and on origin");

    forge.reset();
    await round(a.dashboard);
    await round(a.dashboard);
    assert.deepEqual(forge.calls, [], "nothing changed, nothing written");

    // The second machine sees the same plan and has no switch on: it writes nothing.
    await round(b.dashboard);
    assert.equal(b.dashboard.spaces.get("TST")!.sync.plan.entities.get(draft)!.entity.type, "task");
    assert.equal((b.dashboard.spaces.get("TST")!.sync.plan.entities.get(draft)!.entity as Task).issue, url);
    await updateTask(b.ctx, { task: draft, title: "Dark mode everywhere" });
    await round(b.dashboard);
    assert.deepEqual(other.forge.calls, [], "no forge call from the machine without the switch");
    assert.equal((await readMirror(b.ctx, { space: "TST" })).on, false);

    // Its edit reaches the issue through the machine with the switch.
    await round(a.dashboard);
    assert.equal(issue.title, "Dark mode everywhere");
    assert.equal(created(forge).length, 0);
  } finally {
    a.stop();
    b.dashboard.stop();
  }
});

test("done and canceled close a mirrored issue and a reopened task reopens it; forge edits are overwritten on the next change", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    const url = a.task("TST-TASK1")!.issue!;
    const issue = forge.issues.find((i) => url.endsWith(`/issues/${i.number}`) && i.repo === "acme/core")!;
    assert.equal(issue.title, "one");

    // Someone edits the issue on the forge; nothing changed in the plan, so it stays.
    issue.title = "edited on GitHub";
    forge.reset();
    await round(a.dashboard);
    assert.deepEqual(forge.writes(), []);
    assert.equal(issue.title, "edited on GitHub");

    await updateTask(a.ctx, { task: "TST-TASK1", status: "done" });
    await round(a.dashboard);
    assert.equal(issue.state, "closed");
    assert.equal(issue.state_reason, "completed");
    assert.equal(issue.title, "one", "the task's change overwrote the forge's edit");

    await updateTask(a.ctx, { task: "TST-TASK1", status: "todo" });
    await round(a.dashboard);
    assert.equal(issue.state, "open", "reopening the task reopens the issue");

    await updateTask(a.ctx, { task: "TST-TASK1", status: "canceled" });
    await round(a.dashboard);
    assert.equal(issue.state, "closed");
    assert.equal(issue.state_reason, "not_planned");
    assert.equal(forge.calls.filter((c) => c.method === "POST").length, 0, "never a second issue");
  } finally {
    a.stop();
  }
});

test("a linked or imported issue is never written by the mirror", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    // Someone else's issue, linked by hand before the mirror is on.
    forge.issues.push({ repo: "acme/core", number: 1, title: "theirs", body: "their words", labels: [], assignees: [], state: "open" });
    const linked = "https://github.com/acme/core/issues/1";
    await updateTask(a.ctx, { task: "TST-TASK2", issue: linked });
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    assert.equal(a.task("TST-TASK2")!.issue, linked, "keeps its own link");
    // Another one, imported into the inbox through Inbox → Import and then accepted.
    forge.issues.push({ repo: "acme/core", number: 100, title: "imported", body: "more words", labels: [], assignees: [], state: "open" });
    const answer = await importIssues(a.ctx, { space: "TST", project: "core", numbers: [100] });
    assert.deepEqual([answer.error, answer.skipped], ["", []]);
    const imported = answer.created[0]!.id;
    assert.equal(a.task(imported)!.issue, "https://github.com/acme/core/issues/100");
    await updateTask(a.ctx, { task: imported, status: "todo" });
    await round(a.dashboard);
    const theirs = ["repos/acme/core/issues/1", "repos/acme/core/issues/100"];
    const marks = [mirrorMarker("TST", "TST-TASK2"), mirrorMarker("TST", imported)];
    const touches = () => forge.calls.filter((c) => theirs.includes(c.endpoint) || (c.body && marks.some((m) => String(c.body!.body ?? "").includes(m))));
    assert.deepEqual(touches(), [], "no issue made for them, and their issues not written");

    for (const status of ["done", "todo", "canceled"] as const) {
      for (const id of ["TST-TASK2", imported]) await updateTask(a.ctx, { task: id, status, title: `${id} ${status}`, add_labels: [status] });
      await round(a.dashboard);
    }
    assert.deepEqual(touches(), [], "not edited, closed or reopened");
    assert.deepEqual(forge.issues[0], { repo: "acme/core", number: 1, title: "theirs", body: "their words", labels: [], assignees: [], state: "open" });
    assert.deepEqual(forge.issues.find((i) => i.number === 100), { repo: "acme/core", number: 100, title: "imported", body: "more words", labels: [], assignees: [], state: "open" });

    // Taking a mirrored issue's link off hands it over too: the mirror does not write it again.
    const own = a.task("TST-TASK1")!.issue!;
    await updateTask(a.ctx, { task: "TST-TASK1", issue: "" });
    await round(a.dashboard);
    forge.reset();
    await updateTask(a.ctx, { task: "TST-TASK1", issue: own, title: "one again" });
    await round(a.dashboard);
    assert.deepEqual(forge.calls, [], "released: neither written nor replaced");
  } finally {
    a.stop();
  }
});

test("without the forge nothing is written and the issue is made once it answers; a lost answer is found, not made twice", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    forge.mode = "offline";
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    assert.equal(forge.issues.length, 0);
    assert.equal(a.task("TST-TASK1")!.issue, undefined);
    const status = await readMirror(a.ctx, { space: "TST" });
    assert.ok(status.problems.length > 0 && status.problems.every((p) => /error connecting/.test(p.error)), "the failure is shown");
    assert.ok(status.waiting > 0);

    // One failing call per pass at most: offline, the others would fail the same way. A task
    // that failed waits before it is tried again, so the next pass tries another one.
    const tried = new Set(status.problems.map((p) => p.task));
    forge.reset();
    await a.dashboard.mirror.pass();
    assert.equal(forge.calls.length, 1);
    const now_tried = (await readMirror(a.ctx, { space: "TST" })).problems.map((p) => p.task).filter((task) => !tried.has(task));
    assert.equal(now_tried.length, 1, "waits before trying again: the pass tried a task not tried before");

    // Back online; one create's answer is lost although GitHub made the issue.
    forge.mode = "lost";
    now.t += 2 * 60_000;
    await round(a.dashboard);
    assert.equal(forge.issues.length, 1);
    const lost = forge.issues[0]!;
    forge.mode = "ok";
    now.t += 2 * 60 * 60_000;
    await round(a.dashboard);
    await round(a.dashboard);
    assert.equal(forge.issues.filter((i) => i.title === lost.title).length, 1, "the lost create was found, not repeated");
    const titles = forge.issues.map((i) => i.title).sort();
    assert.deepEqual(titles, [...new Set(titles)], "one issue per task");
    const open = [...a.sync().plan.entities.values()].map((l) => l.entity).filter((e): e is Task => e.type === "task" && e.status !== "inbox");
    for (const task of open) {
      const issue = forge.issues.find((i) => i.title === task.title)!;
      assert.equal(task.issue, `https://github.com/${issue.repo}/issues/${issue.number}`, `${task.id} carries its issue`);
    }
    assert.deepEqual((await readMirror(a.ctx, { space: "TST" })).problems, []);
  } finally {
    a.stop();
  }
});

test("the forge's rate limit pauses writes to that host", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    forge.mode = "rate";
    await round(a.dashboard);
    assert.equal(forge.writes().length, 1, "the first refusal stops the pass for github.com");
    forge.mode = "ok";
    forge.reset();
    await round(a.dashboard);
    assert.deepEqual(forge.writes(), [], "paused");
    assert.equal((await readMirror(a.ctx, { space: "TST" })).paused.length, 1);
  } finally {
    a.stop();
  }
});

test("two machines with the switch on: the issue the task did not take is closed", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  const b = await machine(a.f.remote, cli);
  try {
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    setMirror(b.ctx, { space: "TST", on: true, confirmed: true });
    // Both mirror before either saw the other's links.
    await a.dashboard.mirror.pass();
    await b.dashboard.mirror.pass();
    for (let i = 0; i < 2; i++) {
      await round(a.dashboard);
      await round(b.dashboard);
    }
    const url = a.task("TST-TASK1")!.issue!;
    assert.equal((b.dashboard.spaces.get("TST")!.sync.plan.entities.get("TST-TASK1")!.entity as Task).issue, url, "one link on both");
    const ones = forge.issues.filter((i) => i.title === "one");
    assert.equal(ones.length, 2);
    const left = ones.find((i) => !url.endsWith(`/issues/${i.number}`))!;
    assert.equal(left.state, "closed");
    assert.equal(left.state_reason, "not_planned");
    assert.match(left.body, new RegExp(`stands for ${url.replace(/[/.]/g, "\\$&")}`));
  } finally {
    a.stop();
    b.dashboard.stop();
  }
});

test("a task file that briefly does not read keeps its mirrored issue", async () => {
  const { forge, cli } = fakeGithub();
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    await round(a.dashboard);
    const url = a.task("TST-TASK1")!.issue!;
    const issue = forge.issues.find((i) => url === `https://github.com/${i.repo}/issues/${i.number}`)!;
    const path = "tasks/TST-TASK1-one.md";
    let text = "";
    a.f.external("anna", (root) => {
      text = readFileSync(join(root, path), "utf8");
      writeFileSync(join(root, path), "---\nid: [broken\n---\n");
    });
    forge.reset();
    await round(a.dashboard);
    assert.equal(a.task("TST-TASK1"), undefined, "missing from the plan while it does not read");
    assert.deepEqual(forge.writes(), [], "neither released nor closed as left over");

    a.f.external("anna", (root) => writeFileSync(join(root, path), text.replace("status: todo", "status: done")));
    await round(a.dashboard);
    assert.equal(issue.state, "closed", "still mirrored once it reads again");
    assert.equal(forge.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    a.stop();
  }
});

test("a create whose answer was lost, for a task done meanwhile: the issue found is closed as left over", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    forge.mode = "lost";
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    // One lost create per pass (turning on runs one, the round another).
    assert.ok(forge.issues.length >= 1);
    const lost = forge.issues[0]!;
    const id = [...a.sync().plan.entities.values()].map((l) => l.entity).find((e) => e.title === lost.title)!.id;
    await updateTask(a.ctx, { task: id, status: "done" });
    forge.mode = "ok";
    now.t += 2 * 60_000;
    await round(a.dashboard);
    assert.equal(lost.state, "closed");
    assert.equal(lost.state_reason, "not_planned");
    assert.equal(a.task(id)!.issue, undefined, "a done task gets no issue");
    assert.equal(forge.issues.filter((i) => i.title === lost.title).length, 1);
  } finally {
    a.stop();
  }
});

test("a marker line quoted in a brief never reaches the issue's body", () => {
  const plan = { space: { key: "TST", name: "Test space", projects: {}, people: {}, labels: {}, defaults: {} } } as never;
  const task = { id: "TST-AAAAA", title: "t", status: "todo", labels: [] } as unknown as Task;
  const content = issueContent(plan, task, `Quoted:\n> ${mirrorMarker("TST", "TST-BBBBB")}\nRest.`, { forge: "github", host: "github.com", repo: "acme/core" });
  assert.ok(!content.body.includes("TST-BBBBB"));
  assert.ok(content.body.trimEnd().endsWith(mirrorMarker("TST", "TST-AAAAA")));
});

test("a repository this login may not push to gets no issue, though the forge would take one; settings name it", async () => {
  const { forge, cli } = fakeGithub();
  forge.readOnly.add("acme/site");
  const a = await setup(undefined, { forge: cli, mirror: MIRROR });
  try {
    assert.equal(setMirror(a.ctx, { space: "TST", on: true, confirmed: true }).ok, true);
    await round(a.dashboard);
    assert.ok(created(forge).length > 0, "the core tasks got issues");
    assert.ok(!created(forge).some((c) => c.endpoint.startsWith("repos/acme/site/")), "nothing was opened in someone else's public repository");
    assert.equal(a.task("TST-ST001")!.issue, undefined);
    const status = await readMirror(a.ctx, { space: "TST" });
    assert.deepEqual(status.read_only, ["github.com/acme/site"]);
    assert.equal(status.problems.length, 0, "not a problem of each task");
    assert.equal(status.waiting, 0, "and not waiting either");

    // Once the login may push there (within the hour the answer is kept, nothing changes).
    forge.readOnly.delete("acme/site");
    forge.reset();
    await round(a.dashboard);
    assert.equal(created(forge).length, 0, "the answer is kept for an hour");
  } finally {
    a.stop();
  }
});

test("GitLab's access level decides write: Developer or above, in the project or its group", async () => {
  const answers: Record<string, unknown> = {
    "acme%2Fdev": { visibility: "public", permissions: { project_access: { access_level: 30 }, group_access: null } },
    "acme%2Fgroup": { visibility: "internal", permissions: { project_access: null, group_access: { access_level: 40 } } },
    "acme%2Freporter": { visibility: "public", permissions: { project_access: { access_level: 20 }, group_access: null } },
    "acme%2Fanon": { visibility: "public" },
  };
  const runner: CommandRunner = async (_command, args) => {
    const project = args[args.length - 1]!.replace(/^projects\//, "");
    const answer = answers[project];
    return answer ? { code: 0, stdout: JSON.stringify(answer) } : { code: 1, stdout: "", stderr: "404 Not Found" };
  };
  const writer = new IssueWriter(new ForgeCli(runner), mkdtempSync(join(tmpdir(), "dashboard-access-")));
  const access = async (repo: string) => {
    const read = await writer.access({ forge: "gitlab", host: "git.example.com", repo });
    return read.ok ? read.value : read.error;
  };
  assert.deepEqual(await access("acme/dev"), { visibility: "public", write: true });
  assert.deepEqual(await access("acme/group"), { visibility: "internal", write: true });
  assert.deepEqual(await access("acme/reporter"), { visibility: "public", write: false });
  assert.deepEqual(await access("acme/anon"), { visibility: "public", write: false });
});

test("tasks that failed before their repository was found read-only stop showing; write access, once back, is used within the hour", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    // As on the machine that showed it: tasks of acme/site failed (here, offline).
    forge.mode = "offline";
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    for (let i = 0; i < 4; i++) await round(a.dashboard);
    assert.ok((await readMirror(a.ctx, { space: "TST" })).problems.some((p) => p.task === "TST-ST001"), "the site task failed first");
    forge.mode = "ok";
    forge.readOnly.add("acme/site");
    now.t += 2 * 60 * 60_000;
    for (let i = 0; i < 3; i++) await round(a.dashboard);
    const status = await readMirror(a.ctx, { space: "TST" });
    assert.deepEqual(status.read_only, ["github.com/acme/site"]);
    assert.ok(!status.problems.some((p) => a.task(p.task)?.project === "site"), "no problem shown for a task of the read-only repository");
    assert.ok(!created(forge).some((c) => c.endpoint.startsWith("repos/acme/site/")));

    forge.readOnly.delete("acme/site");
    now.t += 61 * 60_000;
    forge.reset();
    for (let i = 0; i < 3; i++) await round(a.dashboard);
    assert.ok(created(forge).some((c) => c.endpoint.startsWith("repos/acme/site/")), "after the hour the task gets its issue");
    assert.deepEqual((await readMirror(a.ctx, { space: "TST" })).read_only, []);
  } finally {
    a.stop();
  }
});

test("an issue made before its repository was found read-only is no longer written; it stays as it is", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    await round(a.dashboard);
    const site = forge.issues.find((i) => i.repo === "acme/site");
    assert.ok(site, "the site task got an issue while the login could push");
    forge.readOnly.add("acme/site");
    now.t += 61 * 60_000;
    await updateTask(a.ctx, { task: "TST-ST001", title: "Site thing, renamed" });
    forge.reset();
    await round(a.dashboard);
    assert.ok(!forge.writes().some((c) => c.endpoint.startsWith("repos/acme/site/")), "nothing written to the read-only repository");
    assert.equal(site.title, "Site thing");
    const status = await readMirror(a.ctx, { space: "TST" });
    assert.deepEqual(status.read_only, ["github.com/acme/site"]);
    assert.equal(status.problems.length, 0);
  } finally {
    a.stop();
  }
});

test("Settings learn a repository is read-only at once, though its failed records wait to be tried again", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    // As on the machine that showed it: the site task failed, and waits before it is tried again.
    forge.mode = "offline";
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    for (let i = 0; i < 6; i++) await round(a.dashboard);
    assert.ok((await readMirror(a.ctx, { space: "TST" })).problems.length > 0);
    forge.mode = "ok";
    forge.readOnly.add("acme/site");
    // The offline read above is not repeated for five minutes.
    now.t += 5 * 60_000;
    // No pass has tried the waiting records yet; reading the status asks the forge.
    const status = await readMirror(a.ctx, { space: "TST" });
    assert.deepEqual(status.read_only, ["github.com/acme/site"]);
    assert.ok(!status.problems.some((p) => a.task(p.task)?.project === "site"));
    assert.ok(!forge.writes().some((c) => c.endpoint.startsWith("repos/acme/site/")), "a read only");
    // Asked once an hour per repository, not on every read; with the visibility reads too.
    forge.reset();
    await readMirror(a.ctx, { space: "TST" });
    assert.ok(!forge.calls.some((c) => c.endpoint === "repos/acme/site"));
    assert.deepEqual((await readMirror(a.ctx, { space: "TST", visibility: true })).read_only, ["github.com/acme/site"]);
  } finally {
    a.stop();
  }
});

test("Settings do not ask again for five minutes about a repository whose access could not be read", async () => {
  const { forge, cli } = fakeGithub();
  const now = { t: NOW.getTime() };
  const a = await setup(undefined, { forge: cli, mirror: { ...MIRROR, now: () => new Date(now.t) } });
  try {
    forge.mode = "offline";
    setMirror(a.ctx, { space: "TST", on: true, confirmed: true });
    for (let i = 0; i < 3; i++) await round(a.dashboard);
    await readMirror(a.ctx, { space: "TST" });
    forge.reset();
    await readMirror(a.ctx, { space: "TST" });
    assert.equal(forge.calls.length, 0, "offline: the failed read is not repeated on the next poll");
    now.t += 5 * 60_000;
    await readMirror(a.ctx, { space: "TST" });
    assert.ok(forge.calls.length > 0, "asked again after five minutes");
  } finally {
    a.stop();
  }
});
