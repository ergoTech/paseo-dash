import { test } from "node:test";
import assert from "node:assert/strict";
import { getTask } from "./api/reads.ts";
import { setup } from "./api/testing.ts";
import { startTask } from "./api/writes.ts";
import { needOf, waitState } from "./needs.ts";
import { readOverview } from "./overview.ts";
import { settled } from "./runner/testing.ts";
import type { RunRecord } from "./runner/runs.ts";
import type { Task } from "../shared/model.ts";
import { PARENT_AGENT_LABEL } from "./wait.ts";

/**
 * Honest waiting states (JOBBY-YV2QS, part 4). ERG-4WT1N was listed as "needs you: answer" while its
 * agent sat idle and a sub-agent it had started ran `go test` and the review; its last words were
 * about that wait, not a question. An idle agent alone is not a question to the user; a sub-agent's
 * question is, and so is the agent's own.
 */

const HOST = "ergo-mbp";

async function running(s: Awaited<ReturnType<typeof setup>>): Promise<{ run: RunRecord; task: () => Task }> {
  const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  assert.equal(started.ok, true, started.error);
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => Boolean(run.agentId) && run.activity !== "launching");
  s.dashboard.runs!.setActivity(run, "waiting", new Date().toISOString(), { lastMessage: "Waiting for go test and the independent review before the first commit." });
  return { run, task: () => s.task("TST-FX001")! };
}

function child(s: Awaited<ReturnType<typeof setup>>, parent: string, id: string, status: string, pendingPermissions: { kind?: string; title?: string; input?: Record<string, unknown> }[] = []) {
  s.fake.agents.set(id, {
    id,
    workspaceId: "ws-child",
    request: {},
    labels: { [PARENT_AGENT_LABEL]: parent },
    timeline: [],
    history: [],
    status,
    pendingPermissions,
    lastError: null,
    archivedAt: null,
  });
}

test("ERG-4WT1N: an idle agent with a sub-agent at work waits for nobody; the read says subagent_working", async () => {
  const s = await setup();
  try {
    const { run, task } = await running(s);
    assert.equal(needOf(s.dashboard, task(), HOST)?.kind, "answer", "with nothing known, an idle agent still waits for the user");
    child(s, run.agentId!, "agent-child-1", "running");
    await s.dashboard.waits.probe(run, true);
    assert.equal(needOf(s.dashboard, task(), HOST), undefined);
    assert.deepEqual(waitState(s.dashboard, task(), HOST), { state: "subagent_working", note: "a sub-agent of it at work" });
    const overview = readOverview(s.dashboard, {}, HOST);
    assert.ok(!overview.needs_you.some((n) => n.task === "TST-FX001"), "no false needs_you");
    assert.equal(overview.running.find((r) => r.task === "TST-FX001")?.state, "subagent_working");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).state ?? "", /^subagent_working/);
    // The sub-agent finished: the idle agent waits for the user again.
    s.fake.agents.get("agent-child-1")!.status = "idle";
    await s.dashboard.waits.probe(run, true);
    assert.equal(needOf(s.dashboard, task(), HOST)?.kind, "answer");
  } finally {
    s.stop();
  }
});

test("a sub-agent's question is the user's, also while another sub-agent works; the agent's own comes first", async () => {
  const s = await setup();
  try {
    const { run, task } = await running(s);
    child(s, run.agentId!, "agent-child-1", "running");
    child(s, run.agentId!, "agent-child-2", "idle", [{ kind: "question", input: { questions: [{ header: "Bucket", question: "Which bucket keeps the files?" }] } }]);
    await s.dashboard.waits.probe(run, true);
    const need = needOf(s.dashboard, task(), HOST)!;
    assert.equal(need.kind, "question");
    assert.equal(need.why, "a sub-agent asks: Bucket: Which bucket keeps the files?");
    assert.match(need.next, /sub-agent's chat/);
    const row = readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === "TST-FX001")!;
    assert.equal(row.chat_id, "agent-child-2", "the chat to answer in is the sub-agent's");
    assert.equal(waitState(s.dashboard, task(), HOST).state, "needs_user_question");
    // The agent asks for an approval itself: that is said first.
    s.dashboard.runs!.setActivity(run, "needs_input", new Date().toISOString(), { waitingFor: "asks to run: rm -rf build", waitingKind: "permission" });
    assert.deepEqual([needOf(s.dashboard, task(), HOST)?.kind, waitState(s.dashboard, task(), HOST).state], ["permission", "approval"]);
  } finally {
    s.stop();
  }
});

test("running checks and a reported wait leave nothing to answer; a contradicted or stale report, a block and a wait for the user do", async () => {
  const s = await setup();
  try {
    const { run, task } = await running(s);
    const now = Date.now();
    s.dashboard.waits.facts.set(run.run_id, { at: now, working: 0, checks: "pending" });
    assert.deepEqual(waitState(s.dashboard, task(), HOST, now), { state: "waiting_for_ci", note: "its PR/MR's checks are pending" });
    assert.equal(needOf(s.dashboard, task(), HOST, now), undefined);

    // The agent said CI, but the checks failed: that is the user's (or the agent's) to act on.
    run.waitingOn = { kind: "ci", at: new Date(now).toISOString() };
    s.dashboard.waits.facts.set(run.run_id, { at: now, working: 0, checks: "failing" });
    assert.equal(needOf(s.dashboard, task(), HOST, now)?.kind, "answer");

    run.waitingOn = { kind: "review", note: "independent review", at: new Date(now).toISOString() };
    s.dashboard.waits.facts.set(run.run_id, { at: now, working: 0 });
    assert.equal(waitState(s.dashboard, task(), HOST, now).state, "waiting_for_review");
    assert.equal(needOf(s.dashboard, task(), HOST, now), undefined);
    assert.equal(needOf(s.dashboard, task(), HOST, now + 31 * 60_000)?.kind, "answer", "a report no fact backs counts only for a while");

    run.waitingOn = { kind: "user", note: "pick the grace period", at: new Date(now).toISOString() };
    assert.equal(needOf(s.dashboard, task(), HOST, now)?.why, "it asks for your answer: pick the grace period");

    // task_report's state blocked: the agent cannot go on without the user.
    run.waitingOn = undefined;
    await s.settle();
    task().progress_note = "blocked: no access to the stage database";
    assert.deepEqual([needOf(s.dashboard, task(), HOST, now)?.why, waitState(s.dashboard, task(), HOST, now).state], ["the agent is blocked: no access to the stage database", "blocked"]);

    // A new turn clears the reported wait.
    run.waitingOn = { kind: "ci", at: new Date(now).toISOString() };
    s.dashboard.runs!.setActivity(run, "working", new Date().toISOString());
    assert.equal(run.waitingOn, undefined);
  } finally {
    s.stop();
  }
});

test("a turn that ends while a sub-agent works makes no unread event", async () => {
  const s = await setup();
  try {
    const { run } = await running(s);
    const finished = () => s.dashboard.events!.events.filter((e) => e.run_id === run.run_id && e.kind === "finished");
    assert.equal(finished().at(-1)?.read_at, undefined, "the finish is news while nothing else is known");
    s.dashboard.runs!.setActivity(run, "working", new Date(Date.now() + 1_000).toISOString());
    child(s, run.agentId!, "agent-child-1", "running");
    s.dashboard.runs!.setActivity(run, "waiting", new Date(Date.now() + 2_000).toISOString());
    await s.dashboard.turnEnded(run);
    assert.ok(finished().at(-1)?.read_at, "a sub-agent works: the finish is kept read");
  } finally {
    s.stop();
  }
});

test("a stopped run says its PR/MR, handoff and open acceptance; a lost record is said apart from an ended run", async () => {
  const s = await setup();
  try {
    const { run, task } = await running(s);
    s.dashboard.runs!.setActivity(run, "stopped", new Date().toISOString());
    const stopped = needOf(s.dashboard, task(), HOST)!;
    assert.equal(stopped.kind, "stopped");
    assert.match(stopped.why, /its agent is gone while the task is still open; no PR\/MR; no handoff; 1 of 2 acceptance lines open/);
    assert.match(stopped.next, /release it: to done if it is finished, to todo to start it again/);
    assert.equal(waitState(s.dashboard, task(), HOST).state, "stopped");
    assert.equal(task().status, "in_progress", "nothing closes or restarts it by itself");
    // runs.json lost the record: the plan still holds the run for this Mac.
    s.dashboard.runs!.remove(run.run_id);
    const lost = needOf(s.dashboard, task(), HOST)!;
    assert.match(lost.why, /no record of its agent \(not an ended run\)/);
    assert.equal(waitState(s.dashboard, task(), HOST).state, "record_lost");
  } finally {
    s.stop();
  }
});
