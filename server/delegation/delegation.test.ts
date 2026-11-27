import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DelegatedAction } from "../../shared/delegation.ts";
import type { Task } from "../../shared/model.ts";
import { COORDINATOR_TOOLS, PLAN_TOOLS } from "../agent-tools/bridge-script.ts";
import { handlePlanTool } from "../agent-tools/plan.ts";
import { COORDINATOR_SERVER, openPlanTools } from "../agent-tools/plan-hook.ts";
import { setup } from "../api/testing.ts";
import { PLAN_TOOLS_FILE } from "../plan-tools-settings.ts";
import { Dashboard } from "../dashboard.ts";
import { replaceAcceptance } from "../plan/document.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { CUT, sh, UNREACHABLE } from "../sync/testing.ts";
import { revisionOf } from "./rules.ts";
import { enableDelegation, grantDelegation, listDelegationAgents, readDelegation, readDelegationLog, revokeDelegation } from "./rpc.ts";
import { DELEGATION_FILE, DelegationStore } from "./store.ts";
import { type CoordinatorOptions, handleCoordinatorTool } from "./tools.ts";

const CORE = "https://github.com/acme/core.git";
const SITE = "https://github.com/acme/site.git";
const AGENT = "agent-lead";
const ALL: DelegatedAction[] = ["drafts", "priority", "dependencies"];

const origin = async (cwd: string) => (cwd === "/work/core" ? CORE : cwd === "/work/site" ? SITE : undefined);
const caller = (agentId = AGENT, remote = CORE) => ({ agentId, cwd: "/work/core", remote });

/** The test plan with a space that marks manual work, a card so marked, a QA card and open agents. */
async function delegated(actions: DelegatedAction[] = ALL, enabled = true, dashboardOptions: Parameters<typeof setup>[1] = {}) {
  const s = await setup(undefined, dashboardOptions);
  s.f.external("ergo", (root) => {
    const space = join(root, "space.yaml");
    writeFileSync(space, `${readFileSync(space, "utf8")}defaults:\n  human_labels: [manual]\n`);
    const card = (id: string, front: string) =>
      writeFileSync(join(root, "tasks", `${id}.md`), `---\nid: ${id}\ntype: task\nproject: core\n${front}---\n\n## Brief\n\nBy hand.\n\n## Acceptance\n\n- [ ] checked\n`);
    card("TST-MAN01", "title: Manual thing\nstatus: todo\nlabels: [Manual]\n");
    card("TST-QA001", "title: Needs QA\nstatus: todo\nrequires:\n  - { kind: qa, reason: device check }\n");
    card("TST-HD001", "title: Somebody else's draft\nstatus: inbox\n");
  });
  await s.settle();
  for (const [id, cwd, provider] of [
    [AGENT, "/work/core", "claude"],
    ["agent-other", "/work/core", "claude"],
    ["agent-site", "/work/site", "claude"],
    ["agent-pi", "/work/core", "pi"],
  ] as const) {
    s.fake.agents.set(id, { id, workspaceId: "w", request: {}, labels: {}, timeline: [], history: [], status: "idle", pendingPermissions: [], lastError: null, archivedAt: null, cwd, provider, title: `${id} title` });
  }
  const store = () => s.dashboard.delegation!;
  if (enabled) assert.deepEqual(enableDelegation(s.dashboard, { enabled: true }), { ok: true, error: "" });
  const give = (own: DelegatedAction[], agent = AGENT) =>
    grantDelegation(s.dashboard, { agent, space: "TST", project: "core", actions: own, revision: store().state().revision }, { origin });
  if (actions.length) assert.deepEqual(await give(actions), { ok: true, error: "" });
  const call = (tool: string, args: unknown, options: CoordinatorOptions = {}, who = caller()) => handleCoordinatorTool(s.dashboard, who, tool, args, options);
  const rev = (id: string) => revisionOf(s.sync().plan.entities.get(id)!);
  const commits = () => Number(sh(s.f.remote, "rev-list", "--count", "main").trim());
  const add = async (title = "Prepare the release notes") => {
    const answer = await call("coordinate_draft", { title, brief: "# Why\nBecause.", acceptance: ["notes exist"] });
    assert.equal(answer.ok, true, answer.text);
    return /Added draft (TST-[A-Z0-9]+) /.exec(answer.text)![1]!;
  };
  return { ...s, store, give, call, rev, commits, add };
}

test("the pilot is off by default: no permission counts, no session gets the tools, nothing is written", async () => {
  const s = await delegated([], false);
  try {
    assert.equal(readDelegation(s.dashboard).enabled, false);
    // A permission saved while off gives nothing either.
    assert.equal((await s.give(ALL)).ok, true);
    const answer = await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" });
    assert.deepEqual(answer, { ok: false, text: "Delegation is turned off in Paseo Dash Settings on this machine." });
    assert.equal(await openPlanTools(s.dashboard, opening(), undefined, { origin }), undefined);
    assert.equal(s.task("TST-TASK1")!.priority, undefined);
  } finally {
    s.stop();
  }
});

const opening = (overrides: Record<string, unknown> = {}) =>
  ({ agentId: AGENT, workspaceId: null, provider: "claude", cwd: "/work/core", reason: "resume", purpose: "interactive", env: {}, title: null, labels: {}, tools: [], mcpServers: {}, ...overrides }) as never;

/** The bridge script as an agent runs it: a child process spoken to over MCP stdio. */
function agentSide(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: unknown = {}) => {
    const answer = await request("tools/call", { name, arguments: args });
    return { text: answer.result.content[0].text as string, isError: answer.result.isError as boolean };
  };
  return { request, call, close: () => child.kill() };
}

type Opened = { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };

test("only the appointed agent's session gets the coordinator tools, and its token reaches only them", async () => {
  const s = await delegated();
  try {
    assert.equal(await openPlanTools(s.dashboard, opening({ agentId: "agent-other" }), undefined, { origin }), undefined, "an ordinary agent gets nothing new");
    assert.equal(await openPlanTools(s.dashboard, opening({ cwd: "/work/site" }), undefined, { origin }), undefined, "not in another project's repository");
    const opened = (await openPlanTools(s.dashboard, opening(), undefined, { origin })) as unknown as Opened;
    assert.deepEqual(Object.keys(opened.mcpServers), [COORDINATOR_SERVER], "the plan tools stay off");

    // With the plan tools on, an ordinary agent gets exactly them.
    writeFileSync(join(s.dashboard.dataDir, PLAN_TOOLS_FILE), JSON.stringify({ version: 1, enabled: true }));
    const other = (await openPlanTools(s.dashboard, opening({ agentId: "agent-other" }), undefined, { origin })) as unknown as Opened;
    assert.deepEqual(Object.keys(other.mcpServers), ["dashboard_plan"]);

    const server = opened.mcpServers[COORDINATOR_SERVER]!;
    const agent = agentSide(server.args[0]!, server.env);
    try {
      const listed = await agent.request("tools/list");
      assert.deepEqual(listed.result.tools, COORDINATOR_TOOLS);
      const read = await agent.call("coordinate_task", { id: "TST-TASK1" });
      assert.equal(read.isError, false, read.text);
      assert.match(read.text, /revision [0-9a-f]{16}\n/);
      assert.match(read.text, /You may change: priority, adding dependencies\./);
      for (const tool of ["plan_add_draft", "task_report", "task_brief"]) {
        const refused = await agent.call(tool, {});
        assert.deepEqual(refused, { isError: true, text: `Unknown tool ${tool}.` });
      }
    } finally {
      agent.close();
    }
    // The plan tools' token does not reach the coordinator tools.
    const plan = agentSide(server.args[0]!, { ...other.mcpServers.dashboard_plan!.env });
    try {
      assert.deepEqual((await plan.request("tools/list")).result.tools, PLAN_TOOLS);
      const refused = await plan.call("coordinate_task", { id: "TST-TASK1" });
      assert.equal(refused.isError, true);
    } finally {
      plan.close();
    }
    const plain = await handlePlanTool(s.dashboard, caller("agent-other"), "coordinate_plan", {}, { enabled: () => true });
    assert.deepEqual(plain, { ok: false, text: "Unknown tool coordinate_plan." });
  } finally {
    s.stop();
  }
});

test("a coordinator adds its own draft, edits it and prepares cards; each change says who, when, what and under which permission", async () => {
  const s = await delegated();
  try {
    const id = await s.add();
    const task = () => s.task(id)!;
    assert.deepEqual([task().status, task().project], ["inbox", "core"]);
    assert.equal(s.sync().plan.entities.get(id)!.brief, "### Why\nBecause.", "a heading cannot open another section");

    const edited = await s.call("coordinate_draft", { id, revision: s.rev(id), brief: "Better.", acceptance: ["notes exist", "notes reviewed"] });
    assert.equal(edited.ok, true, edited.text);
    assert.equal(s.sync().plan.entities.get(id)!.brief, "Better.");
    assert.deepEqual(s.sync().plan.entities.get(id)!.acceptance.map((a) => a.text), ["notes exist", "notes reviewed"]);

    const planned = await s.call("coordinate_plan", { id: "TST-QA001", revision: s.rev("TST-QA001"), priority: "high", depends_on: [id, "tst-task1"] });
    assert.equal(planned.ok, true, planned.text);
    const qa = s.task("TST-QA001")!;
    assert.deepEqual([qa.priority, qa.status], ["high", "todo"]);
    assert.deepEqual(qa.requires.map((r) => r.kind), ["qa"], "what the card requires stays");
    const file = await s.remoteFile(/TST-QA001/);
    assert.match(file!, /priority: high/);
    assert.match(file!, new RegExp(`depends_on: \\[.*${id}.*TST-TASK1`));

    const grant = s.store().grantOf(AGENT)!;
    const log = readDelegation(s.dashboard).changes;
    assert.deepEqual(log.map((e) => [e.task, e.status, e.pending]), [["TST-QA001", "applied", false], [id, "applied", false], [id, "applied", false]]);
    const first = log[0]!;
    assert.deepEqual([first.agent, first.title, first.grant, first.granted_at, first.actions], [AGENT, `${AGENT} title`, grant.id, grant.granted_at, ["priority", "dependencies"]]);
    assert.ok(first.at);
    assert.deepEqual(first.changes, [{ field: "priority", from: "", to: "high" }, { field: "depends_on", from: "", to: `${id}, TST-TASK1` }]);
    assert.equal(readDelegationLog(s.dashboard, { task: id.toLowerCase() }).changes.length, 2);
    const history = sh(s.f.remote, "log", "--format=%B", "main");
    assert.match(history, new RegExp(`Dashboard-Delegated: TST-QA001 agent=${AGENT} grant=${grant.id}`));

    // The coordinator's brief was not marked as seen by the user.
    assert.equal(s.dashboard.seen!.facts("TST", [{ key: `task:${id}`, name: "brief", text: "Better.", hash: "", author: undefined } as never])[0]!.state, "unseen");
  } finally {
    s.stop();
  }
});

test("a call repeated after a lost answer writes nothing twice", async () => {
  const s = await delegated();
  try {
    const draft = { title: "Only once", brief: "Once.", acceptance: ["one"] };
    // The answer is lost: the plan has not applied it when the wait ends.
    const lost = await s.call("coordinate_draft", draft, { writeWaitMs: 0 });
    assert.match(lost.text, /is queued/);
    const again = await s.call("coordinate_draft", draft);
    assert.equal(again.ok, true, again.text);
    await s.settle();
    const made = await s.call("coordinate_draft", draft);
    assert.match(made.text, /was made at .*; nothing is written again/);
    assert.equal([...s.sync().plan.entities.values()].filter((l) => l.entity.title === "Only once").length, 1);

    const change = { id: "TST-TASK2", revision: s.rev("TST-TASK2"), priority: "urgent" };
    assert.equal((await s.call("coordinate_plan", change)).ok, true);
    await s.settle();
    const before = s.commits();
    assert.match((await s.call("coordinate_plan", change)).text, /nothing is written again/);
    // A person takes the change back; the old call does not make it again.
    s.f.external("ergo", (root) => {
      const path = join(root, "tasks", "TST-TASK2-two.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^priority: urgent\n/m, ""));
    });
    await s.settle();
    assert.match((await s.call("coordinate_plan", change)).text, /nothing is written again/);
    await s.settle();
    assert.equal(s.task("TST-TASK2")!.priority, undefined);
    assert.equal(s.commits(), before + 1, "only the person's commit");
    assert.equal(s.store().entries().length, 2);
  } finally {
    s.stop();
  }
});

test("changes beyond the permission or the rules are refused and recorded, and change nothing", async () => {
  const s = await delegated();
  try {
    const own = await s.add();
    await s.settle();
    const before = s.commits();
    const refused = async (tool: string, args: Record<string, unknown>, why: RegExp) => {
      const answer = await s.call(tool, args);
      assert.equal(answer.ok, false, `${JSON.stringify(args)}: ${answer.text}`);
      assert.match(answer.text, why);
    };
    const plan = (id: string, change: Record<string, unknown>, why: RegExp) => refused("coordinate_plan", { id, revision: s.rev(id), ...change }, why);

    // Another project, by id and as a dependency; nothing of it is read either.
    await plan("TST-ST001", { priority: "high" }, /No card TST-ST001 in project core/);
    assert.deepEqual(await s.call("coordinate_task", { id: "TST-ST001" }), { ok: false, text: "No card TST-ST001 in project core of TST." });
    assert.doesNotMatch((await s.call("coordinate_find", {})).text, /TST-ST001/);
    await plan("TST-TASK1", { depends_on: ["TST-ST001"] }, /TST-ST001 is not a card of project core/);
    // An active run, a card marked as manual work, a closed rule for todo cards.
    await plan("TST-RD002", { priority: "high" }, /has an active run/);
    await plan("TST-MAN01", { priority: "high" }, /marked as a person's work/);
    await plan("TST-DEP01", { depends_on: [] }, /removed from drafts only/);
    await plan("TST-TASK1", { depends_on: ["TST-DEP01"] }, /loop of dependencies/);
    await plan("TST-TASK1", { depends_on: ["TST-TASK1"] }, /cannot depend on itself/);
    // Text: only its own drafts.
    await refused("coordinate_draft", { id: "TST-HD001", revision: s.rev("TST-HD001"), brief: "Mine now." }, /not a draft you created/);
    await refused("coordinate_draft", { id: "TST-QA001", revision: s.rev("TST-QA001"), acceptance: [] }, /only a draft's brief and acceptance/);
    // A stale revision.
    await refused("coordinate_plan", { id: "TST-TASK1", revision: "0000000000000000", priority: "high" }, /changed since you read it/);
    // Fields the tools do not have: status, labels, requirements, project, policy.
    for (const extra of [{ status: "todo" }, { labels: [] }, { requires: [] }, { project: "site" }, { actions: ALL }, { delivery: {} }]) {
      await plan(own, { priority: "low", ...extra }, /Unrecognized key/);
    }
    await refused("coordinate_draft", { title: "Sneaky", status: "todo" }, /Unrecognized key/);
    await refused("coordinate_draft", { id: own, revision: s.rev(own), title: "Renamed" }, /a title is not changed/);
    for (const tool of ["delegation.grant", "coordinate_status", "plan_add_draft"]) assert.deepEqual(await s.call(tool, {}), { ok: false, text: `Unknown tool ${tool}.` });

    await s.settle();
    assert.equal(s.commits(), before);
    assert.equal(s.sync().state.conflicts.length, 0);
    const log = s.store().entries();
    assert.ok(log.filter((e) => e.status === "refused").length >= 8);
    assert.ok(log.some((e) => e.task === "TST-RD002" && e.reason === "TST-RD002 has an active run"));
  } finally {
    s.stop();
  }
});

test("a draft a person accepted or started is no longer the coordinator's to rewrite", async () => {
  const s = await delegated();
  try {
    const id = await s.add();
    await s.settle();
    const old = s.rev(id);
    s.f.external("ergo", (root) => {
      const name = sh(root, "ls-files", `tasks/${id}*`).trim();
      const path = join(root, name);
      writeFileSync(path, readFileSync(path, "utf8").replace("status: inbox", "status: todo"));
    });
    await s.settle();
    const answer = await s.call("coordinate_draft", { id, revision: old, brief: "Late." });
    assert.match(answer.text, /is todo; only a draft's brief/);
  } finally {
    s.stop();
  }
});

const cases: [string, (text: string) => string, RegExp][] = [
  ["a person's newer edit", (text) => text.replace("Do one.", "Do one, carefully."), /changed meanwhile/],
  ["a start on another machine", (text) => text.replace("status: todo", "status: in_progress\nrun_id: r-anna\nrun_by: anna\nrun_host: anna-mbp"), /has an active run/],
  ["a manual-work mark", (text) => text.replace("project: core", "project: core\nlabels: [manual]"), /marked as a person's work/],
];

for (const [name, edit, why] of cases) {
  test(`${name} that reaches the plan repository first refuses the coordinator's change when it is pushed`, async () => {
    const s = await delegated();
    try {
      const revision = s.rev("TST-TASK1");
      s.f.external("anna", (root) => {
        const path = join(root, "tasks", "TST-TASK1-one.md");
        writeFileSync(path, edit(readFileSync(path, "utf8")));
      });
      // This machine has not fetched it yet, so the change is written here first.
      const answer = await s.call("coordinate_plan", { id: "TST-TASK1", revision, priority: "high" });
      await s.settle();
      await s.settle();
      assert.doesNotMatch((await s.remoteFile(/TST-TASK1/))!, /priority: high/);
      const [entry] = s.store().entries("TST-TASK1");
      assert.equal(entry!.status, "refused", answer.text);
      assert.match(entry!.reason, why);
      assert.equal(s.task("TST-TASK1")!.priority, undefined);
    } finally {
      s.stop();
    }
  });
}

const revocations: [string, (s: Awaited<ReturnType<typeof delegated>>) => void][] = [
  ["the permission is revoked", (s) => assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id }).ok, true)],
  ["the action is revoked", (s) => assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id, action: "priority" }).ok, true)],
  ["the pilot is turned off", (s) => assert.equal(enableDelegation(s.dashboard, { enabled: false }).ok, true)],
];

for (const [name, revoke] of revocations) {
  test(`a change still waiting to be pushed when ${name} never reaches the plan repository`, async () => {
    const s = await delegated();
    try {
      renameSync(s.f.remote, `${s.f.remote}.away`);
      const answer = await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" });
      assert.equal(answer.ok, true, answer.text);
      await s.settle();
      assert.equal(readDelegation(s.dashboard).changes[0]!.pending, true);
      revoke(s);
      renameSync(`${s.f.remote}.away`, s.f.remote);
      await s.settle();
      assert.doesNotMatch((await s.remoteFile(/TST-TASK1/))!, /priority: high/);
      assert.equal(s.task("TST-TASK1")!.priority, undefined);
      assert.equal(s.store().entries()[0]!.status, "refused");
      assert.equal(s.sync().journalEntries.length, 0);
    } finally {
      s.stop();
    }
  });
}

test("the owner sees each permission and takes back one action or all of it, at once", async () => {
  const s = await delegated(["priority", "dependencies"]);
  try {
    const [grant] = readDelegation(s.dashboard).grants;
    assert.deepEqual([grant!.agent, grant!.space, grant!.project, grant!.actions], [AGENT, "TST", "core", ["priority", "dependencies"]]);
    assert.match((await s.call("coordinate_draft", { title: "No drafts" })).text, /does not include drafts/);
    assert.equal(revokeDelegation(s.dashboard, { grant: grant!.id, action: "priority" }).ok, true);
    assert.match((await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" })).text, /does not include priority/);
    assert.equal(revokeDelegation(s.dashboard, { grant: grant!.id }).ok, true);
    assert.deepEqual(await s.call("coordinate_task", { id: "TST-TASK1" }), { ok: false, text: "This agent has no delegated permission: none was given, or it was revoked." });
    assert.deepEqual(readDelegation(s.dashboard).grants, []);
    assert.deepEqual(revokeDelegation(s.dashboard, { grant: grant!.id }), { ok: false, error: "no such permission" });
  } finally {
    s.stop();
  }
});

test("a permission goes only to an open agent in the project's repository, and holds only there", async () => {
  const s = await delegated([]);
  try {
    const listed = await listDelegationAgents(s.dashboard, { space: "TST", project: "core" }, { origin });
    assert.deepEqual(listed.agents.map((a) => a.id), [AGENT, "agent-other"], "not another repository's, nor a provider without the tools");
    for (const agent of ["agent-site", "agent-pi", "agent-nobody"]) assert.equal((await s.give(ALL, agent)).ok, false);
    const bad = { agent: AGENT, space: "TST", project: "toString", actions: ALL, revision: s.store().state().revision };
    assert.equal((await grantDelegation(s.dashboard, bad, { origin })).ok, false);
    assert.equal((await s.give(ALL)).ok, true);
    const elsewhere = await s.call("coordinate_find", {}, {}, caller(AGENT, SITE));
    assert.match(elsewhere.text, /this session's repository is not that project/);
    assert.match((await s.call("coordinate_find", {}, {}, caller("agent-other"))).text, /no delegated permission/);
  } finally {
    s.stop();
  }
});

test("a rules file changed behind the plugin's back pauses every permission until the owner saves, and saved rules survive a restart", async () => {
  const s = await delegated(["priority"]);
  try {
    const path = join(s.dashboard.dataDir, DELEGATION_FILE);
    const forged = JSON.parse(readFileSync(path, "utf8"));
    forged.grants[0].actions = ALL;
    forged.grants.push({ ...forged.grants[0], id: "grant-forged", agent: "agent-other" });
    writeFileSync(path, JSON.stringify(forged));
    assert.match(readDelegation(s.dashboard).paused, /changed outside Paseo Dash/);
    assert.match((await s.call("coordinate_draft", { title: "Forged" })).text, /Delegation is paused/);
    assert.match((await s.call("coordinate_find", {}, {}, caller("agent-other"))).text, /Delegation is paused/);
    assert.equal(await openPlanTools(s.dashboard, opening({ agentId: "agent-other" }), undefined, { origin }), undefined);
    // The owner's save writes the rules the plugin holds over the file.
    assert.equal(enableDelegation(s.dashboard, { enabled: true }).ok, true);
    assert.deepEqual(readDelegation(s.dashboard).grants.map((g) => [g.agent, g.actions]), [[AGENT, ["priority"]]]);
    const restarted = new DelegationStore(s.dashboard.dataDir);
    assert.deepEqual(restarted.grantOf(AGENT)?.actions, ["priority"]);
    assert.equal(restarted.grantOf("agent-other"), undefined);
  } finally {
    s.stop();
  }
});

test("disconnecting a space takes its permissions with it", async () => {
  const s = await delegated();
  try {
    await s.dashboard.removeSpace("TST", "ergo-mbp");
    assert.deepEqual(readDelegation(s.dashboard).grants, []);
  } finally {
    s.stop();
  }
});

/** A git whose push lands without an answer, and whose fetches can be cut. */
function unclearGit() {
  const state = { unclear: false, offline: false };
  const runner: GitRunner = {
    async run(cwd, args, timeoutMs) {
      const real = () => systemGit.run(cwd, args, timeoutMs);
      if ((args[0] === "fetch" || args[0] === "push") && state.offline) return UNREACHABLE;
      if (args[0] !== "push" || !state.unclear) return real();
      // A push cut off after the server took it: this clone never learns, so its tracking ref stays.
      const before = sh(cwd, "rev-parse", "refs/remotes/origin/main").trim();
      await real();
      sh(cwd, "update-ref", "refs/remotes/origin/main", before);
      state.offline = true;
      return CUT;
    },
  };
  return { state, runner };
}

test("a push that landed without an answer is never recorded as refused by a later revocation", async () => {
  const git = unclearGit();
  const s = await delegated(ALL, true, { runner: git.runner });
  try {
    git.state.unclear = true;
    const id = await s.add("Landed without an answer");
    await s.settle();
    assert.equal(git.state.offline, true, "the push ran and its answer was lost");
    assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id }).ok, true);
    // Another write passes over the journal without reading origin, then a sync that cannot read it.
    const other = await s.call("coordinate_find", {});
    assert.equal(other.ok, false);
    await s.sync().record([{ op_id: "op-person", kind: "label", id: "TST-TASK2", label: "later", add: true }]).outcomes;
    await s.settle();
    assert.equal(s.store().entry(s.store().entries(id)[0]!.op_id)!.status, "applied");
    assert.equal(s.store().owns("TST", id, AGENT), true);
    git.state.unclear = false;
    git.state.offline = false;
    await s.settle();
    await s.settle();
    assert.equal(s.store().entries(id)[0]!.status, "applied");
    assert.equal(s.sync().journalEntries.length, 0);
    assert.ok(await s.remoteFile(new RegExp(id)), "the draft is on the plan repository");
  } finally {
    s.stop();
  }
});

test("a revoked draft that never landed is refused at the next read of origin, and its ownership goes with it", async () => {
  const git = unclearGit();
  const s = await delegated(ALL, true, { runner: git.runner });
  try {
    git.state.offline = true;
    const id = await s.add("Never landed");
    const edited = await s.call("coordinate_draft", { id, revision: s.rev(id), brief: "Edited offline." });
    assert.equal(edited.ok, true, edited.text);
    await s.settle();
    assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id }).ok, true);
    git.state.offline = false;
    await s.settle();
    assert.equal(s.task(id), undefined);
    assert.deepEqual(s.store().entries(id).map((e) => e.status), ["refused", "refused"]);
    assert.equal(s.store().owns("TST", id, AGENT), false);
    assert.equal(s.sync().journalEntries.length, 0);
  } finally {
    s.stop();
  }
});

test("a change waiting through a restart is pushed while its permission stands", async () => {
  const git = unclearGit();
  const s = await delegated(ALL, true, { runner: git.runner });
  let restarted: Dashboard | undefined;
  try {
    git.state.offline = true;
    assert.equal((await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" })).ok, true);
    await s.settle();
    const dataDir = s.dashboard.dataDir;
    s.stop();
    git.state.offline = false;
    restarted = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000 });
    await restarted.start();
    await restarted.spaces.get("TST")!.sync.sync();
    assert.equal(restarted.spaces.get("TST")!.sync.journalEntries.length, 0);
    assert.match(sh(s.f.remote, "show", "main:tasks/TST-TASK1-one.md"), /priority: high/);
    assert.equal(restarted.delegation!.entries()[0]!.status, "applied");
  } finally {
    restarted?.stop();
    s.stop();
  }
});

test("an action taken back and given again does not bring back the change that waited", async () => {
  const git = unclearGit();
  const s = await delegated(ALL, true, { runner: git.runner });
  try {
    const change = { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" };
    git.state.offline = true;
    assert.equal((await s.call("coordinate_plan", change)).ok, true);
    assert.match((await s.call("coordinate_plan", change)).text, /already waiting to be pushed/);
    await s.settle();
    const id = s.store().grantOf(AGENT)!.id;
    assert.equal(revokeDelegation(s.dashboard, { grant: id, action: "priority" }).ok, true);
    assert.equal((await s.give(ALL)).ok, true);
    assert.equal(s.store().grantOf(AGENT)!.id, id);
    assert.match((await s.call("coordinate_plan", change)).text, /still waits for a sync, which will refuse it: priority was taken out/);
    assert.equal(s.sync().journalEntries.length, 1);
    git.state.offline = false;
    await s.settle();
    assert.doesNotMatch((await s.remoteFile(/TST-TASK1/))!, /priority: high/);
    assert.equal(s.store().entries()[0]!.status, "refused");
    // Asked again under the permission as it stands now, it is a new request.
    assert.equal((await s.call("coordinate_plan", { ...change, revision: s.rev("TST-TASK1") })).ok, true);
    await s.settle();
    assert.match((await s.remoteFile(/TST-TASK1/))!, /priority: high/);
  } finally {
    s.stop();
  }
});

test("a permission is saved only from the rules the owner saw, and taking one back counts even when it cannot be saved", async () => {
  const s = await delegated(["priority"]);
  try {
    const seen = readDelegation(s.dashboard).revision;
    const grant = s.store().grantOf(AGENT)!.id;
    const input = { agent: AGENT, space: "TST", project: "core", actions: ALL, revision: seen };
    // A revocation lands while Paseo and git are being asked about the agent.
    const slow = grantDelegation(s.dashboard, input, {
      origin: async (cwd) => {
        revokeDelegation(s.dashboard, { grant });
        return origin(cwd);
      },
    });
    assert.deepEqual(await slow, { ok: false, error: "the permissions changed meanwhile; look at them and save again" });
    assert.equal((await grantDelegation(s.dashboard, input, { origin })).ok, false, "a stale screen");
    assert.equal(s.store().grantOf(AGENT), undefined);

    assert.equal((await s.give(ALL)).ok, true);
    chmodSync(s.dashboard.dataDir, 0o500);
    try {
      const answer = revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id });
      assert.equal(answer.ok, false);
      assert.match(answer.error, /^taken back until the plugin restarts, but not saved/);
      assert.equal(s.store().grantOf(AGENT), undefined);
      assert.equal((await s.give(ALL)).ok, false);
      assert.equal(s.store().grantOf(AGENT), undefined, "what gives counts only once saved");
    } finally {
      chmodSync(s.dashboard.dataDir, 0o700);
    }
  } finally {
    s.stop();
  }
});

test("a loop through another project does not name its cards, and an acceptance line cannot hide a line break", async () => {
  const s = await delegated();
  try {
    s.f.external("ergo", (root) => {
      const site = join(root, "tasks", "TST-ST001-site-thing.md");
      writeFileSync(site, readFileSync(site, "utf8").replace("project: site", 'project: site\ndepends_on: ["[[TST-TASK1-one]]"]'));
      const dep = join(root, "tasks", "TST-DEP01-blocked-thing.md");
      writeFileSync(dep, readFileSync(dep, "utf8").replace(/depends_on: .*/, 'depends_on: ["[[TST-ST001-site-thing]]"]'));
    });
    await s.settle();
    const answer = await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), depends_on: ["TST-DEP01"] });
    assert.match(answer.text, /loop of dependencies/);
    assert.match(answer.text, /\(a card of another project\)/);
    assert.doesNotMatch(answer.text, /ST001/);
    for (const line of ["one\u2028two", "one\u2029two", "one\ntwo"]) {
      const refused = await s.call("coordinate_draft", { title: "Broken line", acceptance: [line] });
      assert.match(refused.text, /one line/);
    }
  } finally {
    s.stop();
  }
});

test("replacing acceptance lines keeps ticks, the notes under a line and the section's other text", () => {
  const body = "## Acceptance\n\nIntro.\n- [x] a\n  detail under a\n- [ ] b\n  detail under b\n\nAfter.\n\n## Notes\n";
  assert.equal(
    replaceAcceptance(body, ["new", "a"]),
    "## Acceptance\n\nIntro.\n- [ ] new\n- [x] a\n  detail under a\n  detail under b\n\nAfter.\n\n## Notes\n",
  );
  assert.equal(replaceAcceptance("## Brief\n\nText.\n", ["one"]), "## Brief\n\nText.\n\n## Acceptance\n\n- [ ] one\n");
});

const briefOf = (s: Awaited<ReturnType<typeof delegated>>, id: string) => s.sync().plan.entities.get(id)!.brief;

/** A person's edit of a brief, through the plan's journal as any of this machine's writes. */
async function personBrief(s: Awaited<ReturnType<typeof delegated>>, id: string, text: string) {
  const expect = s.sync().plan.entities.get(id)!.briefHash;
  const outcomes = await s.sync().record([{ op_id: `op-person-${text.length}`, kind: "brief", id, text, expect_hash: expect }]).outcomes;
  assert.equal([...outcomes.values()][0]!.status, "applied");
}

test("a revoked change no push carried leaves the local plan at once, so a person's edit made offline survives", async () => {
  const git = unclearGit();
  const s = await delegated(ALL, true, { runner: git.runner });
  try {
    const id = await s.add("Mine for now");
    await s.settle();
    git.state.offline = true;
    assert.equal((await s.call("coordinate_draft", { id, revision: s.rev(id), brief: "The coordinator's words." })).ok, true);
    await s.settle();
    assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id }).ok, true);
    await s.settle();
    assert.equal(briefOf(s, id), "### Why\nBecause.", "dropped without reaching the plan repository");
    assert.equal(s.store().entries(id)[0]!.status, "refused");
    await personBrief(s, id, "The person's words.");
    git.state.offline = false;
    await s.settle();
    assert.equal(briefOf(s, id), "The person's words.");
    assert.match((await s.remoteFile(new RegExp(id)))!, /The person's words\./);
    assert.equal(s.sync().state.conflicts.filter((c) => c.kind === "brief").length, 0);
  } finally {
    s.stop();
  }
});

test("a push that says nothing landed leaves no mark, so the revoked change goes at the next pass", async () => {
  let refuse = false;
  const runner: GitRunner = {
    run: async (cwd, args, timeoutMs) => (refuse && args[0] === "push" ? UNREACHABLE : systemGit.run(cwd, args, timeoutMs)),
  };
  const s = await delegated(ALL, true, { runner });
  try {
    refuse = true;
    assert.equal((await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" })).ok, true);
    await s.settle();
    assert.deepEqual(s.sync().journalEntries.map((entry) => entry.sent), [undefined]);
    assert.equal(revokeDelegation(s.dashboard, { grant: s.store().grantOf(AGENT)!.id }).ok, true);
    await s.settle();
    assert.equal(s.sync().journalEntries.length, 0);
    assert.equal(s.task("TST-TASK1")!.priority, undefined);
  } finally {
    s.stop();
  }
});

test("a pause ended before the plan repository is read still drops the change that waited", async () => {
  const git = unclearGit();
  const s = await delegated(["priority"], true, { runner: git.runner });
  try {
    git.state.offline = true;
    assert.equal((await s.call("coordinate_plan", { id: "TST-TASK1", revision: s.rev("TST-TASK1"), priority: "high" })).ok, true);
    await s.settle();
    const path = join(s.dashboard.dataDir, DELEGATION_FILE);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    // The owner saves again before any pass: the pause is over, what was asked before it stays dropped.
    assert.equal(enableDelegation(s.dashboard, { enabled: true }).ok, true);
    git.state.offline = false;
    await s.settle();
    assert.doesNotMatch((await s.remoteFile(/TST-TASK1/))!, /priority: high/);
    assert.match(s.store().entries()[0]!.reason, /turned off or paused/);
  } finally {
    s.stop();
  }
});

test("a narrower permission counts even when it cannot be saved", async () => {
  const s = await delegated();
  try {
    const store = s.store();
    chmodSync(s.dashboard.dataDir, 0o500);
    try {
      assert.equal((await s.give(["priority"])).ok, false);
      assert.deepEqual(store.grantOf(AGENT)!.actions, ["priority"], "everything it takes away, at once");
    } finally {
      chmodSync(s.dashboard.dataDir, 0o700);
    }
  } finally {
    s.stop();
  }
});
