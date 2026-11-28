import { test } from "node:test";
import assert from "node:assert/strict";
import { getTask, listTasks } from "./api/reads.ts";
import { setup } from "./api/testing.ts";
import { startTask } from "./api/writes.ts";
import { changesToken } from "./changes.ts";
import { needOf, waitState } from "./needs.ts";
import { readOverview } from "./overview.ts";
import { FakeHooks, settled } from "./runner/testing.ts";
import type { RunRecord } from "./runner/runs.ts";
import { taskView } from "./views.ts";
import { PARENT_AGENT_LABEL } from "./wait.ts";
import type { Task } from "../shared/model.ts";

/**
 * A stopped run's chat (JOBBY-HCXY5). Needs you listed such cards as «its agent is gone» when their
 * chats were closed and could be continued or were archived, some had sub-agents of their own, and one
 * card's work could sit in a sub-agent's chat of another card's run. Every name here is made up.
 */

const HOST = "ergo-mbp";

type Setup = Awaited<ReturnType<typeof setup>>;

/** A started task whose agent Paseo then closed, as the hooks record it. */
async function stopped(s: Setup): Promise<{ run: RunRecord; task: () => Task }> {
  const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  assert.equal(started.ok, true, started.error);
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => Boolean(run.agentId) && run.activity !== "launching");
  // The tracker's own passes would read the chats at moments the test does not choose.
  s.dashboard.tracker.stop();
  s.fake.agents.get(run.agentId!)!.status = "closed";
  s.dashboard.runs!.setActivity(run, "stopped", new Date().toISOString());
  return { run, task: () => s.task("TST-FX001")! };
}

function child(s: Setup, parent: string, id: string, extra: Partial<NonNullable<ReturnType<Setup["fake"]["agents"]["get"]>>> = {}) {
  s.fake.agents.set(id, {
    id,
    workspaceId: "ws-child",
    request: {},
    timeline: [],
    history: [],
    status: "idle",
    pendingPermissions: [],
    lastError: null,
    archivedAt: null,
    cwd: "/Users/someone/worktrees/core-signing",
    ...extra,
    labels: { [PARENT_AGENT_LABEL]: parent, ...extra.labels },
  });
}

const needs = (s: Setup) => readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === "TST-FX001");

test("a closed chat that is not archived: continuing it comes first, releasing second", async () => {
  const s = await setup();
  try {
    const { run, task } = await stopped(s);
    await s.dashboard.chats.read();
    const row = needs(s)!;
    assert.equal(row.kind, "stopped");
    assert.deepEqual(row.chat, { id: run.agentId, state: "closed", sub_agents: [] });
    assert.equal(row.chat_id, run.agentId);
    assert.match(row.why, /^its chat is closed, not archived: it can be continued; no PR\/MR/);
    assert.doesNotMatch(row.why, /gone/);
    assert.match(row.next, /^continue its chat \(open it in Paseo, or send_message to it with God Mode\); otherwise release it: to done if it is finished, to todo/);
    const read = getTask(s.ctx, { task: "TST-FX001" });
    assert.equal(read.activity, "stopped on this Mac: its chat is closed and can be continued");
    assert.deepEqual([read.chat, read.next, read.chat_id], [row.chat, row.next, run.agentId]);
    const listed = (await listTasks(s.ctx, { status: "all", limit: 50 })).tasks.find((t) => t.id === "TST-FX001")!;
    assert.deepEqual([listed.chat, listed.next], [row.chat, row.next]);
    assert.equal(waitState(s.dashboard, task(), HOST).state, "stopped");
    assert.equal(run.activity, "stopped", "reading starts and resumes nothing");
    assert.equal(task().status, "in_progress");
    assert.equal(s.fake.sent.length, 0);
  } finally {
    s.stop();
  }
});

test("an archived chat is said to be archived, and an agent is gone only when Paseo has none", async () => {
  const s = await setup();
  try {
    const { run } = await stopped(s);
    const agent = s.fake.agents.get(run.agentId!)!;
    agent.archivedAt = "2026-11-20T08:00:00.000Z";
    await s.dashboard.chats.read();
    let row = needs(s)!;
    assert.deepEqual([row.kind, row.chat?.state, row.chat_id], ["stopped", "archived", run.agentId]);
    assert.match(row.why, /^its chat is archived; /);
    assert.match(row.next, /^check its branch and PR\/MR for the work, then release it/);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).activity, "stopped on this Mac: its chat is archived");

    agent.gone = true;
    await s.dashboard.chats.read();
    row = needs(s)!;
    assert.deepEqual([row.chat?.state, row.chat_id], ["gone", ""], "there is no chat to open");
    assert.match(row.why, /^its agent is gone while the task is still open; /);
    const read = getTask(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([read.activity, read.chat_id], ["stopped on this Mac: its agent is gone", ""]);
  } finally {
    s.stop();
  }
});

test("a chat Paseo cannot be asked about is not said to be gone", async () => {
  const s = await setup();
  try {
    const { run, task } = await stopped(s);
    const api = s.dashboard.paseo!;
    const ref = api.agents.ref.bind(api.agents);
    // Not in the listing, and the read by id fails.
    s.fake.agents.get(run.agentId!)!.gone = true;
    api.agents.ref = ((id: string) => ({ ...ref(id), refresh: async () => Promise.reject(new Error("socket closed")) })) as typeof api.agents.ref;
    await s.dashboard.chats.read();
    assert.equal(s.dashboard.chats.of(run), undefined);
    // A stop a pass could say nothing of is not waited for again by every read.
    let listed = 0;
    const list = api.agents.list.bind(api.agents);
    api.agents.list = ((options: never) => ((listed += 1), list(options))) as typeof api.agents.list;
    await s.dashboard.chats.ready(1_000);
    assert.equal(listed, 0);
    const need = needOf(s.dashboard, task(), HOST)!;
    assert.match(need.why, /^its agent is stopped; its chat is not read yet; /);
    assert.match(need.next, /^check its chat in Paseo and continue it if it is there/);
  } finally {
    s.stop();
  }
});

test("an open sub-agent of a closed run is its own state, with a link to its chat", async () => {
  const s = await setup();
  try {
    const { run, task } = await stopped(s);
    child(s, run.agentId!, "a1b2c3d4-child");
    child(s, run.agentId!, "closed-child", { status: "closed" });
    child(s, run.agentId!, "archived-child", { archivedAt: "2026-11-27T10:00:00Z" });
    await s.dashboard.chats.read();
    const row = needs(s)!;
    assert.equal(row.kind, "subagent");
    assert.equal(row.chat_id, "a1b2c3d4-child");
    assert.equal(row.why, "its sub-agent a1b2c3d4 is idle in core-signing; the run's chat is closed");
    const directory = "/Users/someone/worktrees/core-signing";
    assert.deepEqual(row.chat, { id: run.agentId, state: "closed", sub_agents: [{ id: "a1b2c3d4-child", state: "idle", directory }, { id: "closed-child", state: "closed", directory }] });
    assert.match(row.next, /^check the sub-agent's chat, then continue the run's closed chat .*; otherwise release it/);
    assert.equal(waitState(s.dashboard, task(), HOST).state, "subagent_open");
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).activity, "stopped on this Mac: its chat is closed and can be continued; a sub-agent of it still open");
    assert.deepEqual(taskView(s.dashboard, { task: "TST-FX001" }).sub_agents, row.chat!.sub_agents);

    // A sub-agent asking is the user's question, in the sub-agent's chat.
    s.fake.agents.get("a1b2c3d4-child")!.pendingPermissions = [{ kind: "question", input: { questions: [{ header: "Tag", question: "Protect it?" }] } }];
    await s.dashboard.chats.read();
    const asks = needs(s)!;
    assert.deepEqual([asks.kind, asks.chat_id, asks.why], ["question", "a1b2c3d4-child", "a sub-agent asks: Tag: Protect it?"]);

    // In review the sub-agent is still said, in the state.
    await s.sync().record([{ op_id: "op-peek", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:01:00Z" }]).outcomes;
    s.fake.agents.get("a1b2c3d4-child")!.pendingPermissions = [];
    await s.dashboard.chats.read();
    assert.equal(waitState(s.dashboard, task(), HOST).state, "subagent_open");
    // Merged work asks for its own step; the state still says the open sub-agent.
    s.dashboard.prs.seen.set("TST-FX001", { run_id: run.run_id, label: "#7", state: "merged", url: "https://github.com/acme/core/pull/7" });
    assert.deepEqual([needOf(s.dashboard, task(), HOST)?.kind, waitState(s.dashboard, task(), HOST).state], ["merged", "subagent_open"]);
    s.dashboard.prs.seen.delete("TST-FX001");
    // More closed sub-agents than are listed are not counted as exactly five.
    for (let n = 0; n < 6; n += 1) child(s, run.agentId!, `old-${n}`, { status: "closed" });
    await s.sync().record([{ op_id: "op-unpeek", kind: "transition", id: "TST-FX001", to: "in_progress", run_id: run.run_id, at: "2026-10-26T10:01:30Z" }]).outcomes;

    s.fake.agents.get("a1b2c3d4-child")!.status = "closed";
    await s.dashboard.chats.read();
    assert.match(needs(s)!.why, /; 5 or more closed sub-agents; /);
    for (let n = 0; n < 6; n += 1) s.fake.agents.delete(`old-${n}`);

    // Closed since, not archived (Paseo closes an idle agent later): the run's own chat leads, the sub-agent is still named.
    s.fake.agents.get("a1b2c3d4-child")!.status = "closed";
    s.fake.agents.get("a1b2c3d4-child")!.pendingPermissions = [];
    s.fake.agents.get("closed-child")!.archivedAt = "2026-11-28T11:00:00Z";
    await s.dashboard.chats.read();
    const later = needs(s)!;
    assert.deepEqual([later.kind, later.chat_id, later.chat?.sub_agents.map((sub) => [sub.id, sub.state])], ["stopped", run.agentId, [["a1b2c3d4-child", "closed"]]]);
    assert.match(later.why, /^its chat is closed, not archived: it can be continued; sub-agent a1b2c3d4 closed too; /);

    // Its work in review: continuing the closed chat comes before starting again.
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: "TST-FX001", to: "review", run_id: run.run_id, at: "2026-10-26T10:02:00Z" }]).outcomes;
    assert.match(needOf(s.dashboard, task(), HOST)!.next, /^accept the work, or continue its closed chat with what to change .*, or release it to todo/);
  } finally {
    s.stop();
  }
});

test("a reading of an earlier stop is not shown for a later one, and a reopened chat leaves stopped", async () => {
  const s = await setup();
  try {
    const { run } = await stopped(s);
    await s.dashboard.chats.read();
    assert.equal(s.dashboard.chats.of(run)?.state, "closed");
    s.dashboard.runs!.setActivity(run, "stopped", "2026-11-28T12:00:00.000Z");
    assert.equal(s.dashboard.chats.of(run), undefined);
    await s.dashboard.chats.ready(1_000);
    // Opened in Paseo while no hook said so: the run follows the agent again.
    s.fake.agents.get(run.agentId!)!.status = "idle";
    await s.dashboard.chats.read();
    assert.equal(run.activity, "waiting");
    assert.equal(needs(s)?.kind, "answer");
    assert.equal(run.lastMessage, undefined, "the timeline, which loads an agent, is not read here");
  } finally {
    s.stop();
  }
});

test("an archive hook reads the chat again, and the changes token follows", async () => {
  const s = await setup();
  const hooks = new FakeHooks(s.fake.api());
  const unhook = s.dashboard.tracker.register(hooks as never);
  try {
    const { run } = await stopped(s);
    await s.dashboard.chats.read();
    const before = changesToken(s.dashboard);
    await s.dashboard.chats.read();
    assert.equal(changesToken(s.dashboard), before, "a pass that changes nothing");
    const agent = s.fake.agents.get(run.agentId!)!;
    agent.archivedAt = "2026-11-28T12:00:00.000Z";
    await hooks.fire("agent.archived", { agent: { id: agent.id }, archivedAt: agent.archivedAt });
    await settled(() => s.dashboard.chats.of(run)?.state === "archived", 1_000);
    assert.equal(s.dashboard.chats.of(run)?.state, "archived");
    assert.notEqual(changesToken(s.dashboard), before);
  } finally {
    unhook.forEach((off) => off());
    s.stop();
  }
});

test("a sub-agent of another run that names a task shows on it as work in that run's chat", async () => {
  const s = await setup();
  try {
    const { run } = await stopped(s);
    // Closed and archived, the id in its title; its parent is the other card's run.
    child(s, run.agentId!, "e5f6a7b8-child", { status: "closed", archivedAt: "2026-11-20T09:00:00Z", title: "TST-TASK1 mail timeouts", cwd: "/w/fix-mail-timeout" });
    // A sub-agent of that sub-agent, naming it in a label, in lower case.
    child(s, "e5f6a7b8-child", "grandchild", { status: "running", labels: { task: "qa-tst-task1-2" } });
    // Not listed: its own run's task, an agent no run of this Mac started.
    child(s, run.agentId!, "own-child", { title: "TST-FX001 review" });
    child(s, "somebody-else", "stranger", { title: "TST-TASK1 elsewhere" });
    await s.dashboard.chats.read();
    const read = getTask(s.ctx, { task: "TST-TASK1" });
    assert.deepEqual(read.other_chats, [
      { chat_id: "grandchild", state: "working", directory: "/Users/someone/worktrees/core-signing", via_task: "TST-FX001" },
      { chat_id: "e5f6a7b8-child", state: "archived", directory: "/w/fix-mail-timeout", via_task: "TST-FX001" },
    ]);
    const rows = (await listTasks(s.ctx, { status: "all", limit: 50 })).tasks;
    assert.deepEqual(rows.find((t) => t.id === "TST-TASK1")?.other_chats, read.other_chats);
    assert.equal(rows.find((t) => t.id === "TST-FX001")?.other_chats, undefined);
    assert.deepEqual(taskView(s.dashboard, { task: "TST-TASK1" }).other_chats, read.other_chats);
    assert.equal(s.task("TST-TASK1")?.status, "todo", "nothing changes the task");
  } finally {
    s.stop();
  }
});
