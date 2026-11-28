import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../shared/model.ts";
import { getTask, listTasks } from "./api/reads.ts";
import { startTask } from "./api/writes.ts";
import { setup } from "./api/testing.ts";
import { listEvents } from "./events.ts";
import { readOverview } from "./overview.ts";
import { readAutopilot } from "./queue.ts";
import type { RunRecord } from "./runner/runs.ts";

/**
 * One state in every read (06-god-mode.md, One state in every read): the same runs read through
 * dashboard.overview, tasks.list, tasks.get, events.list and autopilot.read never contradict one
 * another. Each case is a task with a live run in a state seen live; the assertions are the
 * invariant, checked for every task of the plan.
 */

const HOST = "ergo-mbp";
const STARTED = "2026-10-26T08:00:00.000Z";
const AT = "2026-10-26T09:00:00.000Z";

interface Case {
  id: string;
  title: string;
  task?: Partial<Task>;
  /** This Mac's run record; absent: the plan's run has none here. */
  run?: Partial<RunRecord>;
  /** The activity the run gets by a change, as hooks make it (which may make a task event). */
  becomes?: RunRecord["activity"];
  /** overview.running's activity; absent: not listed there. */
  running?: string;
  /** The needs_you kind; "": not listed. */
  needs: string;
  /** What tasks.get's activity says. */
  activity: RegExp;
  /** What next names, with needs. */
  next?: RegExp;
}

const LANDED = { head: "a".repeat(40), clean: true, landed: true, at: AT, archived: true };

const CASES: Case[] = [
  { id: "TST-SWRK1", title: "Agent at work", run: { activity: "working" }, running: "working", needs: "", activity: /^working on this Mac$/ },
  { id: "TST-STRT1", title: "Agent launching", run: { activity: "launching" }, running: "launching", needs: "", activity: /^launching on this Mac$/ },
  { id: "TST-SPRM1", title: "Agent asks", run: { activity: "working" }, becomes: "needs_input", running: "waiting", needs: "permission", activity: /^needs your answer on this Mac/, next: /agent's chat/ },
  { id: "TST-SQST1", title: "Agent asks questions", run: { activity: "working" }, becomes: "needs_input", running: "waiting", needs: "question", activity: /^needs your answer on this Mac/, next: /read_approval, then answer_questions with only the user's own choices; never answer_approval$/ },
  { id: "TST-SANS1", title: "Agent waits", run: { activity: "working", lastMessage: "Which release?" }, becomes: "waiting", running: "waiting", needs: "answer", activity: /^waiting for a message on this Mac$/, next: /reply/ },
  { id: "TST-SERR1", title: "Agent failed", run: { activity: "working", error: "rate limited" }, becomes: "failed", running: "failed", needs: "failed", activity: /^failed on this Mac: rate limited$/, next: /release/ },
  // The agent is stopped, its chat not read yet (server/chats.test.ts reads it): no failure, yet the task is open with nobody at work on it.
  { id: "TST-SGNE1", title: "Agent gone", task: { project: "site" }, run: { activity: "working", project: "site" }, becomes: "stopped", running: "stopped", needs: "stopped", activity: /^stopped on this Mac: its chat is not read yet$/, next: /release it: to done if it is finished, to todo to start it again/ },
  // JOBBY-BVG1Z as read live on 2026-10-28: a tracked checkout on main, its agent gone, its work
  // landed, its workspace still open (so the screen offers no "Mark done" yet).
  {
    id: "TST-STRK1",
    title: "Trunk checkout landed",
    task: { run_branch: "main", base: "main" },
    run: { activity: "working", branch: "main", adopted: { kind: "checkout", directory: "/nowhere", trunk: "main", landed: { ...LANDED, archived: false } } },
    becomes: "stopped",
    running: "stopped",
    needs: "checkout",
    activity: /^stopped on this Mac: its chat is not read yet$/,
    next: /^its work is on origin\/main: release it to done if it is finished, or release it to todo to start it again; its workspace is still open in Paseo$/,
  },
  {
    id: "TST-STRK2",
    title: "Trunk checkout not pushed",
    task: { run_branch: "main", base: "main" },
    run: { activity: "stopped", agentId: undefined, branch: "main", adopted: { kind: "checkout", directory: "/nowhere", trunk: "main", landed: { ...LANDED, landed: false, archived: true } } },
    running: "stopped",
    needs: "checkout",
    activity: /^tracked on this Mac, without an agent in its workspace$/,
    next: /^commit and push its work to origin\/main, then release it to done; or release it to todo to start it again$/,
  },
  // Held by this Mac in the plan, with no record of its agent here (runs.json lost or moved aside).
  { id: "TST-SNRC1", title: "No record here", running: "stopped", needs: "stopped", activity: /^started on this Mac, without an agent known here$/, next: /release it/ },
  { id: "TST-SRVW1", title: "In review, no PR", task: { status: "review" }, run: { activity: "waiting" }, needs: "accept", activity: /^waiting for a message on this Mac$/, next: /^accept the work, or send it back with what to change$/ },
  { id: "TST-SRVW2", title: "In review, PR open", task: { status: "review" }, run: { activity: "stopped" }, needs: "", activity: /^stopped on this Mac: its chat is not read yet$/ },
  { id: "TST-SRVF1", title: "In review, agent failed", task: { status: "review" }, run: { activity: "working", error: "rate limited" }, becomes: "failed", needs: "failed", activity: /^failed on this Mac: rate limited$/, next: /release/ },
  // Its own PR/MR merged while its agent still works: the merge is the user's to decide on.
  { id: "TST-SMRG1", title: "Merged while at work", run: { activity: "working" }, running: "working", needs: "merged", activity: /^working on this Mac$/, next: /^release it to done if the work is finished; otherwise tell the agent in its chat what is left$/ },
  { id: "TST-SMRG2", title: "In review, merged, not done", task: { status: "review" }, run: { activity: "stopped" }, needs: "merged", activity: /^stopped on this Mac: its chat is not read yet$/, next: /^accept the work if it is finished; otherwise release it to todo to start it again$/ },
  { id: "TST-SRVN1", title: "In review, no record here", task: { status: "review" }, needs: "accept", activity: /^started on this Mac, without an agent known here$/, next: /^accept the work, or release it to todo to start it again$/ },
  // Sent back only where its agent is: another machine's run there.
  { id: "TST-SRVR1", title: "In review elsewhere, no PR", task: { status: "review", run_host: "anna-mbp", run_by: "anna" }, needs: "accept", activity: /^running on anna-mbp$/, next: /^accept the work, or send it back with what to change from anna-mbp$/ },
  // Another machine's run: its agent is that machine's to tell, its PR/MR is everyone's.
  { id: "TST-SRMT1", title: "Another Mac, PR closed", task: { run_host: "anna-mbp", run_by: "anna" }, running: "working", needs: "closed", activity: /^running on anna-mbp$/, next: /tell the agent on anna-mbp/ },
];

/** What task.activity says for each overview.running activity: the same fact in other words. */
const SAYS: Record<string, RegExp> = {
  launching: /^launching on this Mac$/,
  working: /^working on this Mac$|^running on /,
  waiting: /^waiting for a message on this Mac$|^needs your answer on this Mac/,
  failed: /^failed on this Mac/,
  stopped: /^stopped on this Mac|^tracked on this Mac, without an agent|^started on this Mac, without an agent known here$/,
};

test("one state in every read: overview, tasks, task, events and the autopilot agree on every run", async () => {
  const s = await setup();
  // The states are set by hand; the tracker's own pass would read them from Paseo.
  s.dashboard.tracker.stop();
  try {
    await s.settle();
    const plan = s.sync().plan;
    const store = s.dashboard.runs!;
    const base = plan.entities.get("TST-TASK1")!;
    for (const c of CASES) {
      const entity = { ...base.entity, id: c.id, title: c.title, status: "in_progress", run_id: `r-${c.id}`, run_by: "ergo", run_host: HOST, run_branch: `task/${c.id.toLowerCase()}`, run_started: STARTED, ...c.task } as Task;
      plan.entities.set(c.id, { ...base, entity });
      if (!c.run) continue;
      const run: RunRecord = { run_id: `r-${c.id}`, space: "TST", task: c.id, project: "core", projectId: "prj_core", branch: entity.run_branch!, started: STARTED, attempts: [], claim: "won", activity: "working", activityAt: STARTED, agentId: `a-${c.id}`, ...c.run };
      store.put(run);
      const asks = c.id === "TST-SQST1" ? { waitingFor: "2 questions: Release, Daemon", waitingKind: "question" as const } : { waitingFor: "asks to run: npm test" };
      if (c.becomes) store.setActivity(run, c.becomes, AT, c.becomes === "needs_input" ? asks : c.becomes === "failed" ? { error: "rate limited" } : {});
    }
    s.dashboard.prs.seen.set("TST-SRVW2", { run_id: "r-TST-SRVW2", label: "#9", state: "open", url: "https://github.com/acme/core/pull/9" });
    s.dashboard.prs.seen.set("TST-SMRG1", { run_id: "r-TST-SMRG1", label: "#10", state: "merged", url: "https://github.com/acme/core/pull/10", note: "merged with 1 acceptance line not ticked" });
    s.dashboard.prs.seen.set("TST-SMRG2", { run_id: "r-TST-SMRG2", label: "#12", state: "merged", url: "https://github.com/acme/core/pull/12", note: "merged with 1 acceptance line not ticked" });
    s.dashboard.prs.seen.set("TST-SRMT1", { run_id: "r-TST-SRMT1", label: "#11", state: "closed", url: "https://github.com/acme/core/pull/11", note: "closed without a merge" });

    const overview = readOverview(s.dashboard, { limit: 200 }, HOST);
    const list = await listTasks(s.ctx, { status: "all", limit: 50 });
    assert.equal(list.error, "");
    assert.equal(list.total, list.shown, "every task is read");
    const needs = new Map(overview.needs_you.filter((n) => n.task).map((n) => [n.task, n]));
    const running = new Map(overview.running.map((r) => [r.task, r]));

    // Each case reads as seen live.
    for (const c of CASES) {
      const read = getTask(s.ctx, { task: c.id });
      assert.equal(read.error, "", c.id);
      assert.match(read.activity, c.activity, `${c.id}: task.activity`);
      assert.equal(running.get(c.id)?.activity, c.running, `${c.id}: overview.running`);
      assert.equal(needs.get(c.id)?.kind ?? "", c.needs, `${c.id}: needs_you`);
      if (c.next) assert.match(needs.get(c.id)!.next, c.next, `${c.id}: next`);
    }

    // The invariant, for every task of the plan, the fixture's own included (another machine's run, todo tasks).
    assert.ok(list.tasks.some((t) => t.id === "TST-RD002"), "another machine's run is in the list");
    for (const row of list.tasks) {
      const read = getTask(s.ctx, { task: row.id });
      const item = needs.get(row.id);
      const run = running.get(row.id);
      // tasks and task say the same, and needs and next are needs_you's.
      // A row leaves out what is empty; the task read says "".
      assert.deepEqual([row.status, row.activity ?? "", row.needs ?? "", row.next ?? ""], [read.status, read.activity, read.needs, read.next], `${row.id}: tasks = task`);
      assert.deepEqual([read.needs, read.next], [item?.kind ?? "", item?.next ?? ""], `${row.id}: task = needs_you`);
      // overview.running is exactly the tasks in progress with a live run, said as task.activity says it.
      assert.equal(Boolean(run), row.status === "in_progress" && read.activity !== "", `${row.id}: in running`);
      if (run) {
        assert.match(read.activity, SAYS[run.activity]!, `${row.id}: running ${run.activity} vs «${read.activity}»`);
        assert.equal(row.section, "running", `${row.id}: section`);
        // No agent of this Mac at work: always in needs_you, with a step.
        if (run.activity !== "working" && run.activity !== "launching") assert.ok(item, `${row.id}: ${run.activity} without a needs-you item`);
        // An agent at work, or another machine's run, waits for the user only on what its PR/MR did.
        else assert.ok(!item || item.kind === "merged" || item.kind === "closed", `${row.id}: ${item?.kind} while its agent works`);
      }
      // Failed is said only of an agent that failed, by every read or by none.
      const failed = [item?.kind === "failed", read.activity.startsWith("failed"), ...(run ? [run.activity === "failed"] : [])];
      assert.ok(failed.every(Boolean) || !failed.some(Boolean), `${row.id}: failed in some reads only: ${JSON.stringify(failed)}`);
      if (item) assert.ok(item.next.length > 0, `${row.id}: needs_you names a next step`);
    }
    assert.equal(running.get("TST-RD002")?.activity, "working", "another machine's run is its own to tell");
    assert.equal(needs.has("TST-RD002"), false);

    // Counts are the lists' totals, per space too.
    assert.deepEqual(
      [overview.counts.needs_you, overview.counts.running, overview.counts.review],
      [overview.needs_you.length, overview.running.length, list.tasks.filter((t) => t.status === "review").length],
    );
    assert.equal(overview.counts.running, list.tasks.filter((t) => t.section === "running").length);
    assert.equal(
      overview.spaces.reduce((sum, space) => sum + space.needs_you, 0),
      overview.counts.needs_you,
    );

    // Events: a failure, a question and a finished turn are news; an agent gone, the trunk's end included, is none.
    const events = listEvents(s.dashboard, { limit: 50 });
    assert.equal(events.error, "");
    assert.deepEqual(events.events.map((e) => [e.task_id, e.kind]).sort(), [
      ["TST-SANS1", "finished"],
      ["TST-SERR1", "failed"],
      ["TST-SPRM1", "needs_input"],
      ["TST-SQST1", "question"],
      ["TST-SRVF1", "failed"],
    ]);
    assert.equal(overview.counts.events, events.unread);
    // An agent's question among them: how the user answers it comes with the answer (JOBBY-RTWBY).
    assert.match(events.next!, /^once told, mark_events_read with through \d+; a question: .*read_approval, then answer_questions with only the user's own choices; never answer_approval$/);

    // The autopilot lists every run of this Mac the plan holds, in review too, and counts only those
    // at work (JOBBY-AH5Z0): a gone, failed or tracked-ended agent and a review awaiting acceptance take no place.
    const autopilot = s.dashboard.autopilot!;
    const live = CASES.filter((c) => c.run).map((c) => c.id).sort();
    const counted = ["TST-SANS1", "TST-SMRG1", "TST-SPRM1", "TST-SQST1", "TST-STRT1", "TST-SWRK1"];
    let read = readAutopilot(s.ctx);
    assert.deepEqual(read.runs.map((r) => r.task).sort(), live, "every run of this Mac the plan holds, in review too");
    assert.deepEqual(read.runs.filter((r) => r.holds_place).map((r) => r.task).sort(), counted);
    assert.equal(read.running, counted.length);
    for (const r of read.runs) {
      const row = list.tasks.find((t) => t.id === r.task)!;
      assert.equal(r.status, row.status, `${r.task}: status`);
      if (running.has(r.task)) assert.equal(r.activity, running.get(r.task)!.activity, `${r.task}: autopilot = overview.running`);
    }
    // A full limit names the runs at work that fill it.
    autopilot.set({ space: "TST", project: "site", on: true, max_running: counted.length });
    await autopilot.pass(s.ctx);
    read = readAutopilot(s.ctx);
    assert.equal(read.flags[0]?.state, `waits: ${counted.length} runs of this Mac are at work (the autopilot's limit is ${counted.length}): ${read.runs.filter((r) => r.holds_place).map((r) => r.task).join(", ")}`);
    assert.deepEqual(read.limit, { until: "", source: "" }, "a usage-limit failure weeks old holds nothing now");
    // Below the limit, a project waits for its run however stale, and says so.
    autopilot.set({ space: "TST", project: "site", on: true, max_running: 20 });
    await autopilot.pass(s.ctx);
    read = readAutopilot(s.ctx);
    assert.equal(read.flags[0]?.state, "waits: TST-SGNE1 «Agent gone» holds this project with no agent at work: release it (to done when finished) to go on");
    assert.equal(read.started.length, 0, "nothing was started");
  } finally {
    s.stop();
  }
});

test("a start from this Mac reads launching while its claim is pushed, never as a run whose agent is gone", async () => {
  const s = await setup();
  s.dashboard.tracker.stop();
  try {
    // The plan in memory holds the claim while it is pushed; the run record is written once it is won.
    const sync = s.sync() as unknown as { push: (ms: number) => Promise<unknown> };
    const push = sync.push.bind(sync);
    let during: unknown[] = [];
    sync.push = async (ms: number) => {
      const overview = readOverview(s.dashboard, {}, HOST);
      const row = (await listTasks(s.ctx, { status: "all", limit: 50 })).tasks.find((t) => t.id === "TST-TASK1");
      const read = getTask(s.ctx, { task: "TST-TASK1" });
      during = [
        s.task("TST-TASK1")?.run_host,
        s.dashboard.runs!.byTask("TST-TASK1"),
        overview.running.find((r) => r.task === "TST-TASK1")?.activity,
        overview.needs_you.length,
        read.activity,
        read.needs,
        row?.needs ?? "",
      ];
      return push(ms);
    };
    const started = await startTask(s.ctx, { task: "TST-TASK1", profile: "Review" });
    assert.equal(started.error, "");
    assert.deepEqual(during, [HOST, undefined, "launching", 0, "launching on this Mac", "", ""]);
  } finally {
    s.stop();
  }
});
