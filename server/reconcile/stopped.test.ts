import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueKey } from "../../shared/issues.ts";
import { reconcile } from "../api/reconcile.ts";
import { getTask, getTaskWithRuns, readBoard } from "../api/reads.ts";
import { taskDelivery } from "../delivery.ts";
import { readOverview } from "../overview.ts";
import { taskChecks } from "../result.ts";
import { settled } from "../runner/testing.ts";
import { taskView } from "../views.ts";
import { sh } from "../sync/testing.ts";
import { PARENT_AGENT_LABEL } from "../wait.ts";
import { writeRule } from "./rules.ts";
import { type FakePr, PR_URL, reconcileSetup } from "./testing.ts";

/**
 * A hold whose agent is gone (JOBBY-515V2): the agent merged its work from a branch the run never
 * recorded, and every read still said "agent gone, no PR/MR". Each test is one way a card gets there,
 * with made-up numbers; no reading here closes a card, releases a run or starts an agent.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const HOST = "ergo-mbp";
const ID = "TST-AC001";
const STAGE = "5ba9e1d";
const QA = `delivery: {stage_sha: ${STAGE}, trello: "https://trello.com/c/AbCd1234", trello_state: Ready for test}\n`;
const ISSUE = "https://github.com/acme/core/issues/12";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const soon = (n = 60) => new Date(Date.now() + n * 60_000).toISOString();

/** A merged PR of the card from a branch of its own naming, as an agent opens one. */
const merged = (n: number, extra: Partial<FakePr> = {}): FakePr => ({ n, state: "MERGED", checks: ["SUCCESS"], head: `fix/${ID.toLowerCase()}-work-${n}`, body: `Task: ${ID}`, mergedAt: soon(), mergeSha: `${STAGE}${String(n).padStart(33, "0")}`, ...extra });

type Setup = Awaited<ReturnType<typeof reconcileSetup>>;

/** A card with a live run whose agent is gone; the run recorded its planned branch and no PR/MR. */
async function held(front = QA, options: { acceptance?: string[] } = {}) {
  const s = await reconcileSetup("off", { paseo: { profiles: [PROFILE] } });
  s.ctx.now = () => new Date();
  await s.card(ID, `status: todo\nissue: ${ISSUE}\n${front}`, { acceptance: options.acceptance ?? ["[x] Tests are green", "[ ] The first check by a person", "[ ] The second check by a person"] });
  const started = await startTaskOf(s);
  s.dashboard.runs!.setActivity(started, "stopped", new Date().toISOString());
  await s.settle();
  return { ...s, run: started };
}

async function startTaskOf(s: Setup) {
  const { startTask } = await import("../api/writes.ts");
  const answer = await startTask(s.ctx, { task: ID, profile: "Review" });
  assert.equal(answer.ok, true, answer.error);
  const run = s.dashboard.runs!.byTask(ID)!;
  await settled(() => run.activity !== "launching");
  return run;
}

/** Reads the card from the forge, then what every screen and God Mode read says of it. */
async function reads(s: Setup) {
  const rec = await reconcile(s.ctx, { task: ID });
  const need = readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID);
  const board = (await readBoard(s.ctx, {})).columns.flatMap((c) => c.tasks).find((t) => t.id === ID)!;
  const task = getTask(s.ctx, { task: ID });
  const delivery = await taskDelivery(s.ctx, { task: ID });
  return { rec, need, board, task, delivery };
}

/** Nothing a reading does may change the card or its run. */
function untouched(s: Setup, runId: string, status = "in_progress") {
  const card = s.taskOf(ID);
  assert.deepEqual([card.status, card.run_id, card.run_ended, card.auto_closed], [status, runId, undefined, undefined]);
}

test("#46: merged from another branch than the run's, closing the issue, with QA pending: every read says the same next step", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46, { title: "fix: limit what a reader may edit" })];
    s.dashboard.issues.seen.set(issueKey(ISSUE)!, { state: "closed", closedBy: [PR_URL(46)], at: new Date().toISOString() });
    const { rec, need, board, task, delivery } = await reads(s);

    assert.equal(rec.error, "");
    assert.deepEqual(rec.tasks.map((row) => [row.id, row.merged.map((pr) => pr.pr), row.left_count]), [[ID, ["#46"], 2]]);
    assert.match(rec.tasks[0]!.merged[0]!.by, /closes_issue/);
    assert.doesNotMatch(rec.note, /has a live run/);

    assert.deepEqual([need?.kind, board.needs, task.needs], ["merged", "merged", "merged"]);
    assert.match(need!.why, /its agent is stopped; #46 \(5ba9e1d\) merged into main/);
    const next = need!.next;
    assert.match(next, /QA tests on stage/);
    assert.match(next, /tick the 2 open acceptance line\(s\)/);
    assert.match(next, /release it to done \(release_task\)/);
    assert.match(next, /do not release it to todo or start it again/);
    assert.deepEqual([board.next, task.next, delivery.next, rec.tasks[0]!.next], [next, next, next, next]);
    assert.deepEqual([delivery.stage, delivery.next_by], ["ready_for_qa", "QA"]);
    assert.match(delivery.steps.find((step) => step.step === "MR")!.fact, /#46 merged \(5ba9e1d\)/);
    assert.equal(delivery.steps.find((step) => step.step === "QA")!.state, "pending", "a green check and a closed issue pass no QA");

    assert.equal(task.pr, "#46 merged");
    assert.match((await getTaskWithRuns(s.ctx, { task: ID })).delivery!, /ready_for_qa; next QA: QA tests on stage/);
    const view = taskView(s.dashboard, { task: ID });
    assert.deepEqual([view.pr?.url, view.delivery], [PR_URL(46), true]);
    const checks = await taskChecks(s.ctx, { task: ID }, s.github.runner());
    assert.deepEqual([checks.pr, checks.state, checks.url], ["#46", "merged", PR_URL(46)]);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("the background pass reads a held card whose agent is gone, with no closing rule on", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46)];
    await s.pass();
    await s.settle();
    assert.equal(readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID)?.kind, "merged");
    assert.deepEqual((await reconcile(s.ctx, {})).tasks.map((row) => row.id), [ID]);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("#31: a task in review, merged before its run started and reported by that run, is that run's merged work", async () => {
  const s = await held(QA);
  try {
    // The run reported it done: review. The PR/MR is older than the run, which only names it.
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: ID, to: "review", run_id: s.run.run_id, at: new Date().toISOString() }]).outcomes;
    s.github.prs = [merged(31, { mergedAt: minutesAgo(60) })];
    s.run.reportedPr = PR_URL(31);
    const { rec, need, delivery } = await reads(s);
    assert.equal(need?.kind, "merged");
    assert.match(need!.next, /QA tests on stage/);
    assert.doesNotMatch(need!.next, /before this run started/);
    assert.deepEqual([rec.tasks[0]!.merged[0]!.pr, delivery.next], ["#31", need!.next]);
    untouched(s, s.run.run_id, "review");
  } finally {
    s.stop();
  }
});

test("a merge older than the run that the run did not report is earlier work: the new run is not done by it", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(10, { mergedAt: minutesAgo(60) })];
    const { need, delivery } = await reads(s);
    assert.match(need!.why, /merged into main before this run started/);
    assert.match(need!.next, /check what the run left/);
    assert.match(need!.next, /only once nothing is left, QA and acceptance included/);
    assert.equal(delivery.stage, "in_work");
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("#48 with the follow-up #52: open, it holds the card though only its description names it; merged, QA is next", async () => {
  const s = await held();
  try {
    const followUp: FakePr = { n: 52, head: "fix/second-label", title: "fix: a label of its own", body: `Follow-up to ${ID} (PR #48).`, checks: ["SUCCESS"] };
    s.github.prs = [merged(48), followUp];
    let { rec, need, delivery } = await reads(s);
    assert.match(need!.why, /#52 is open and names the card in its description/);
    assert.match(need!.next, /check whether #52 is newer work of this card/);
    assert.doesNotMatch(need!.next, /release it to done/);
    assert.deepEqual([delivery.stage, delivery.next, rec.tasks[0]!.next], ["waiting_for_merge", need!.next, need!.next]);

    // Merged after what the stage is known to hold: the stage is asked about the follow-up too.
    s.github.prs = [merged(48), { ...followUp, state: "MERGED", mergedAt: soon(90) }];
    ({ need } = await reads(s));
    assert.match(need!.next, /whether stage build 5ba9e1d holds the merge/);

    s.github.prs = [merged(48), { ...followUp, state: "MERGED", mergedAt: soon(90), mergeSha: `${STAGE}${"1".repeat(33)}` }];
    ({ rec, need, delivery } = await reads(s));
    assert.match(need!.next, /QA tests on stage/);
    assert.deepEqual(rec.tasks[0]!.merged.map((pr) => pr.pr), ["#48"], "the follow-up is no merged work of the card");
    assert.match(rec.note, /^Mentioned in #52 \(https:\/\/github\.com\/acme\/core\/pull\/52\)/);
    assert.ok(rec.tasks[0]!.sources!.some((source) => source.label === "#52 mentions the card"));
    assert.match(delivery.steps.find((step) => step.step === "MR")!.fact, /Mentioned in #52 /);
    assert.doesNotMatch(delivery.steps.find((step) => step.step === "MR")!.fact, /#52 merged/);
    assert.equal(delivery.next, need!.next);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("an open draft with passing checks is no merge and passes no QA", async () => {
  const s = await held();
  try {
    s.github.prs = [{ n: 96, state: "OPEN", draft: true, checks: ["SUCCESS"], head: `docs/${ID.toLowerCase()}-acceptance`, title: `Draft: acceptance protocol (${ID})` }];
    const { rec, need, board, task, delivery } = await reads(s);
    assert.deepEqual([need?.kind, board.needs, task.needs], ["stopped", "stopped", "stopped"]);
    assert.deepEqual(rec.tasks, []);
    assert.match(rec.note, /no merge of its own into the target branch is confirmed; #96 is still a draft/);
    const next = need!.next;
    assert.match(next, /#96 is a draft: finish it and mark it ready \(its passing checks pass no QA\)/);
    assert.match(next, /do not start the same work again/);
    assert.doesNotMatch(next, /to todo to start it again|merged code/);
    assert.deepEqual([board.next, task.next, delivery.next], [next, next, next]);
    assert.ok(rec.note.includes(next));
    assert.equal(delivery.stage, "waiting_for_merge");
    assert.equal(delivery.steps.find((step) => step.step === "QA")!.state, "pending");
    assert.equal((await taskChecks(s.ctx, { task: ID }, s.github.runner())).state, "draft");
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("a closed issue alone, a mention in a description and a merge into another branch confirm nothing", async () => {
  const s = await held();
  try {
    s.dashboard.issues.seen.set(issueKey(ISSUE)!, { state: "closed", closedBy: [], at: new Date().toISOString() });
    let answer = await reads(s);
    assert.deepEqual([answer.need?.kind, answer.rec.tasks], ["stopped", []]);

    s.github.prs = [merged(70, { head: "chore/other", body: `Unblocks ${ID}.` })];
    answer = await reads(s);
    assert.deepEqual([answer.need?.kind, answer.rec.tasks], ["stopped", []]);

    s.github.prs = [merged(71, { base: "develop" })];
    answer = await reads(s);
    assert.equal(answer.need?.kind, "stopped");
    assert.match(answer.rec.note, /#71 was merged into develop, not main/);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("commits on the run's own branch that no PR/MR holds keep an older merge from ending the hold", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46)];
    s.github.tips[s.taskOf(ID).run_branch!] = "c".repeat(40);
    const { need, delivery } = await reads(s);
    assert.match(need!.next, /check task\/.*: open a PR\/MR for what it holds/);
    assert.equal(delivery.stage, "waiting_for_merge");
  } finally {
    s.stop();
  }
});

test("a forge that does not answer holds the card instead of calling it finished", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46)];
    await reads(s);
    s.github.down = true;
    const { need } = await reads(s);
    // The last reading is replaced by one that could not read: no merge is claimed, and the step is the forge.
    assert.equal(need?.kind, "stopped");
    assert.match(need!.next, /check this Mac's gh or glab login/);
    assert.doesNotMatch(need!.next, /release it to done/);
  } finally {
    s.stop();
  }
});

test("another host's run, whose agent may be at work, is no stopped hold: nothing is read or advised from here", async () => {
  const s = await reconcileSetup("off");
  try {
    s.github.prs = [merged(46)];
    await s.card(ID, `status: in_progress\nrun_id: r-elsewhere\nrun_by: ergo\nrun_host: other-mac\nrun_branch: task/other\nrun_started: ${minutesAgo(30)}\n${QA}`);
    await s.pass();
    await s.settle();
    const { rec, need, board } = await reads(s);
    assert.deepEqual([need, board.needs ?? "", rec.tasks], [undefined, "", []]);
    assert.match(rec.note, /has a live run on other-mac, whose agent this Mac cannot see/);
    assert.deepEqual(s.github.calls, []);
    assert.equal(readOverview(s.dashboard, {}, HOST).running.find((r) => r.task === ID)?.activity, "working");
  } finally {
    s.stop();
  }
});

test("a reading of the earlier hold says nothing after a sync brings a new run for the card", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46)];
    await reads(s);
    assert.equal(readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID)?.kind, "merged");
    const at = new Date().toISOString();
    await s.sync().record([{ op_id: "op-release", kind: "release", id: ID, run_id: s.run.run_id, to: "todo", at }]).outcomes;
    assert.equal(readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID), undefined, "released: no hold, no need");
    // The forge is not asked in between: the new run, of another Mac, must not inherit the reading.
    const claim = await s.sync().claim(ID, { run_id: "r-second", run_by: "ergo", run_host: HOST, run_branch: "task/second", run_started: at });
    assert.equal(claim.result, "won");
    const need = readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID);
    assert.notEqual(need?.kind, "merged");
  } finally {
    s.stop();
  }
});

test("a decision the card waits for is named before the step after the merge", async () => {
  const s = await held(`${QA}requires: [{kind: decision, reason: pick one of the two fixes}]\n`);
  try {
    s.github.prs = [merged(46)];
    const { need, delivery } = await reads(s);
    assert.match(need!.next, /^settle first: an open decision: decision: pick one of the two fixes; then/);
    assert.match(need!.next, /QA tests on stage/);
    assert.equal(delivery.next, need!.next);
  } finally {
    s.stop();
  }
});

test("every acceptance line ticked and no QA expected: the step is the release, still by the owner", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46)];
    const { need, delivery } = await reads(s);
    assert.match(need!.next, /#46 \(5ba9e1d\) is merged: check it, then release it to done \(release_task\)/);
    assert.deepEqual([delivery.stage, delivery.next_by], ["ready_to_accept", "owner"]);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

// Holes an independent review of this change found, one test each.

const qa = (result: string, at: string, sha = STAGE) => `delivery: {stage_sha: ${sha}, qa: ${result}, qa_note: still broken, qa_at: "${at}"}\n`;
const BEFORE = "2026-11-20T12:00:00Z";
const needOf = (s: Setup) => readOverview(s.dashboard, {}, HOST).needs_you.find((n) => n.task === ID);

test("a QA failure recorded before the fix merged does not send the card back to be started again", async () => {
  const s = await held(qa("failed", BEFORE));
  try {
    s.github.prs = [merged(46)];
    const { need, delivery } = await reads(s);
    assert.match(need!.next, /^QA's recorded "failed" does not cover the merged code \(#46 \(5ba9e1d\)\), so it is tested again: QA tests on stage/);
    assert.doesNotMatch(need!.next, /release it to todo and start it/);
    assert.equal(delivery.stage, "ready_for_qa");
  } finally {
    s.stop();
  }
});

test("a QA failure of the merged code is the one step: the fix, and nothing that contradicts it", async () => {
  const s = await held(qa("failed", soon(120)));
  try {
    s.github.prs = [merged(46)];
    const { need, delivery } = await reads(s);
    assert.equal(need!.next, "QA failed: still broken; the fix is new work: release it to todo and start it for the fix only");
    assert.equal(delivery.stage, "qa_failed");
  } finally {
    s.stop();
  }
});

test("a QA pass from before a merge, or on a build without it, releases nothing", async () => {
  for (const front of [qa("passed", BEFORE), qa("passed", soon(120), "1111111")]) {
    const s = await held(front, { acceptance: ["[x] Code works"] });
    try {
      const root = s.dashboard.projectRoots.get("prj_core")!;
      // Two unrelated commits: git says the stage build does not hold the merge.
      const commit = (name: string) => {
        sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", name);
        return sh(root, "rev-parse", "HEAD").trim();
      };
      const stage = commit("stage");
      const sha = commit("merge");
      if (front.includes("1111111")) await s.sync().record([{ op_id: "op-stage", kind: "set", id: ID, field: "delivery", value: { stage_sha: stage, qa: "passed", qa_at: soon(120) }, expect: s.taskOf(ID).delivery }]).outcomes;
      s.github.prs = [merged(46, { mergeSha: sha })];
      const { need, delivery } = await reads(s);
      assert.doesNotMatch(need!.next, /QA passed and every acceptance line is ticked/);
      assert.match(need!.next, /QA's recorded "passed" does not cover the merged code/);
      assert.notEqual(delivery.stage, "qa_passed");
    } finally {
      s.stop();
    }
  }
});

test("a QA pass recorded after every merge, on a stage that holds them, leads to the release", async () => {
  const s = await held(qa("passed", soon(120)), { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46)];
    const { need } = await reads(s);
    assert.match(need!.next, /^QA passed and every acceptance line is ticked: release it to done \(release_task\)/);
  } finally {
    s.stop();
  }
});

test("a person's check is named before the QA step, and the release stays the last action", async () => {
  const s = await held(`${QA}labels: [manual]\n`);
  try {
    s.github.prs = [merged(46)];
    const { need } = await reads(s);
    assert.match(need!.next, /^settle first: manual acceptance/);
    assert.equal(need!.next.match(/release it to done/g)?.length, 1);
    assert.ok(need!.next.indexOf("release it to done") > need!.next.indexOf("QA tests on stage"));
  } finally {
    s.stop();
  }
});

test("a reading made while the agent worked, or at an earlier stop, says nothing of this stop", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46)];
    await s.pass();
    await s.settle();
    assert.match(needOf(s)!.next, /release it to done/);
    // It works again, opens a follow-up from its branch and stops, all within the reading's freshness.
    s.dashboard.runs!.setActivity(s.run, "working", new Date(Date.now() + 1_000).toISOString());
    const branch = s.taskOf(ID).run_branch!;
    s.github.tips[branch] = "c".repeat(40);
    s.github.prs.push({ n: 52, state: "OPEN", checks: ["SUCCESS"], head: branch, title: `more (${ID})` });
    s.dashboard.runs!.setActivity(s.run, "stopped", new Date(Date.now() + 2_000).toISOString());
    assert.doesNotMatch(needOf(s)!.next, /#46 .* is merged/, "the earlier stop's reading is not shown");
    await s.pass();
    await s.settle();
    assert.match(needOf(s)!.next, /review and merge #52/);
    assert.equal((await taskDelivery(s.ctx, { task: ID })).next, needOf(s)!.next);
  } finally {
    s.stop();
  }
});

test("a ruled project's reading from the working agent is not the stopped hold's", async () => {
  const s = await reconcileSetup("report", { paseo: { profiles: [PROFILE] } });
  try {
    s.ctx.now = () => new Date();
    await s.card(ID, "status: todo\n", { acceptance: ["[x] Code works"] });
    const run = await startTaskOf(s);
    s.github.prs = [merged(46)];
    await s.dashboard.reconciler.factsFor(s.space(), s.taskOf(ID), 10_000);
    s.github.tips[s.taskOf(ID).run_branch!] = "c".repeat(40);
    s.dashboard.runs!.setActivity(run, "stopped", new Date(Date.now() + 1_000).toISOString());
    assert.doesNotMatch(needOf(s)?.next ?? "", /#46/);
    await s.pass();
    await s.settle();
    assert.match(needOf(s)!.next, /check task\/.*: open a PR\/MR for what it holds/);
  } finally {
    s.stop();
  }
});

test("the run branch's PR/MR closed without a merge holds the card, though an older part is merged", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    const branch = s.taskOf(ID).run_branch!;
    s.github.prs = [merged(46), { n: 60, state: "CLOSED", head: branch, title: `${ID} the rest` }];
    s.github.tips[branch] = "c".repeat(40);
    const { need } = await reads(s);
    assert.match(need!.next, /check whether the work of #60 is still needed/);
    assert.doesNotMatch(need!.next, /release it to done/);
  } finally {
    s.stop();
  }
});

test("another card's PR/MR that mentions this one is never its result", async () => {
  const s = await held();
  try {
    await s.card("TST-BD002", "status: todo\n");
    s.github.prs = [merged(70, { head: "feat/tst-bd002-x", title: "TST-BD002: other work", body: `Unblocks ${ID}.` })];
    const { need, rec } = await reads(s);
    assert.deepEqual([need?.kind, rec.tasks], ["stopped", []]);
    assert.equal((await taskChecks(s.ctx, { task: ID }, s.github.runner())).url, "");
    s.github.prs.push(merged(46));
    const after = await reads(s);
    assert.deepEqual(after.rec.tasks[0]!.merged.map((pr) => pr.pr), ["#46"]);
  } finally {
    s.stop();
  }
});

test("an app card a merged PR/MR only mentions has no code and no build, whatever a recorded build holds", async () => {
  const s = await held();
  try {
    const root = s.dashboard.projectRoots.get("prj_core")!;
    sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "follow-up");
    const sha = sh(root, "rev-parse", "HEAD").trim();
    sh(root, "push", "--quiet", "origin", "HEAD:main");
    const build = `{variant: phone, environment: staging, sha: ${sha}, url: "https://apk.example.com/b.apk"}`;
    s.f.external("ergo", (clone) => {
      const dir = join(clone, "tasks");
      const file = join(dir, readdirSync(dir).find((name) => name.startsWith(ID))!);
      writeFileSync(file, readFileSync(file, "utf8").replace(/^delivery: .*$/m, `delivery: {variants: [phone], qa: pending, builds: [${build}]}`));
    });
    await s.sync().sync();
    s.github.prs = [merged(70, { head: "chore/other", body: `Unblocks ${ID}.`, mergeSha: sha })];
    const { rec, delivery } = await reads(s);
    assert.deepEqual(rec.tasks, []);
    assert.match(rec.note, /^Mentioned in #70 /);
    const code = delivery.steps.find((step) => step.step === "Code")!;
    assert.equal(code.state, "none");
    assert.match(code.fact, /no PR\/MR of the card is known.*Mentioned in #70 /);
    assert.doesNotMatch(delivery.qa_handoff, /pull\/70|holds #70/);
    assert.equal(delivery.steps.find((step) => step.step === "APK phone")!.state, "awaited");

    // Beside work of its own the follow-up is checked with it, and said as what it is, once.
    s.github.prs.push(merged(46, { mergeSha: sha, mergedAt: soon(30) }));
    s.github.prs[0]!.mergedAt = soon(90);
    const both = await reads(s);
    const listed = both.delivery.steps.find((step) => step.step === "Code")!.fact;
    assert.match(listed, /#46 merged [^;]*; #70 merged [^;]*, a follow-up that mentions the card|#70 merged [^;]*, a follow-up that mentions the card; #46 merged/);
    assert.doesNotMatch(listed, /not counted/);
    assert.match(both.delivery.steps.find((step) => step.step === "APK phone")!.fact, /holds .*#70/);
    assert.match(both.delivery.qa_handoff, /Code: https:\/\/github\.com\/acme\/core\/pull\/46/);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("the exact id in the title of a merged PR/MR is the card's merge: the same work is not offered again", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(46, { head: "fix/other-name", title: `fix: other name (${ID})`, body: "" })];
    const { need, rec } = await reads(s);
    assert.equal(need?.kind, "merged");
    assert.doesNotMatch(need!.next, /to todo to start it again/);
    assert.deepEqual(rec.tasks[0]!.merged.map((pr) => pr.pr), ["#46"]);
  } finally {
    s.stop();
  }
});

test("a follow-up that only mentions the card and landed in another branch holds it", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(48), merged(52, { head: "fix/ok", base: "develop", body: `Follow-up to ${ID}.` })];
    const { need } = await reads(s);
    assert.match(need!.why, /#52 was merged into develop, not main/);
    assert.doesNotMatch(need!.next, /release it to done/);
  } finally {
    s.stop();
  }
});

test("an open PR/MR with failing checks is not called ready, and a review with its run's own open one raises nothing new", async () => {
  const s = await held();
  try {
    const failing: FakePr = { n: 90, state: "OPEN", checks: ["FAILURE"], mergeable: "CONFLICTING", head: "fix/other", title: `${ID} rest` };
    s.github.prs = [failing];
    const { need } = await reads(s);
    assert.match(need!.next, /#90 is not ready to merge \(checks fail/);
    const branch = s.taskOf(ID).run_branch!;
    s.github.prs = [{ ...failing, head: branch }];
    s.github.tips[branch] = "c".repeat(40);
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: ID, to: "review", run_id: s.run.run_id, run_pr: PR_URL(90), at: new Date().toISOString() }]).outcomes;
    await reconcile(s.ctx, { task: ID });
    assert.equal(needOf(s), undefined);
  } finally {
    s.stop();
  }
});

// What the second review found.

/** A commit of the project's checkout on origin/main, as a merge or a build is one. */
function commitOnMain(s: Setup, name: string): string {
  const root = s.dashboard.projectRoots.get("prj_core")!;
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", name);
  sh(root, "push", "--quiet", "origin", "HEAD:main");
  return sh(root, "rev-parse", "HEAD").trim();
}

test("commits pushed after a merge only its title ties to the card hold it", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46, { head: "fix/other-name", title: `fix: other name (${ID})`, body: "", headSha: "a".repeat(40) })];
    s.github.tips["fix/other-name"] = "b".repeat(40);
    const { need } = await reads(s);
    assert.match(need!.next, /open a PR\/MR for them/);
    assert.doesNotMatch(need!.next, /release it to done/);
  } finally {
    s.stop();
  }
});

test("a closed PR/MR replaced by a later merge of the run's branch holds nothing; a linked one is still asked about", async () => {
  for (const linked of [false, true]) {
    const s = await held(linked ? `links: ["${PR_URL(45)}"]\n` : "", { acceptance: ["[x] Code works"] });
    try {
      const branch = s.taskOf(ID).run_branch!;
      s.github.prs = [{ n: 45, state: "CLOSED", head: branch, title: `${ID} first try`, createdAt: soon(1) }, merged(46, { head: branch, headSha: "a".repeat(40) })];
      s.github.tips[branch] = "a".repeat(40);
      const { need } = await reads(s);
      if (linked) assert.match(need!.next, /check whether the work of #45 is still needed: reopen it, or take its link off/);
      else assert.match(need!.next, /#46 \(5ba9e1d\) is merged: check it, then release it to done/);
    } finally {
      s.stop();
    }
  }
});

test("a promotion of the target branch that lists the card holds nothing", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46), merged(80, { head: "main", base: "production", title: "release", body: `Includes ${ID}, and others.` })];
    const { need } = await reads(s);
    assert.match(need!.next, /#46 \(5ba9e1d\) is merged: check it/);
  } finally {
    s.stop();
  }
});

test("a QA result counts only on a stage build git knows to hold the merge, a failure too", async () => {
  for (const result of ["passed", "failed"]) {
    // The merge commit is one the checkout lacks: whether the build holds it cannot be told.
    const s = await held(qa(result, soon(120), "1111111"), { acceptance: ["[x] Code works"] });
    try {
      s.github.prs = [merged(46, { mergeSha: "b".repeat(40) })];
      const { need, delivery } = await reads(s);
      assert.match(need!.next, new RegExp(`^QA's recorded "${result}" does not cover the merged code`));
      assert.match(need!.next, /whether stage build 1111111 holds the merge bbbbbbb/);
      assert.doesNotMatch(need!.next, /start it for the fix only/);
      assert.equal(delivery.stage, "waiting_for_stage");
    } finally {
      s.stop();
    }
  }
});

test("the stage step names the merge the build lacks, a follow-up's too", async () => {
  const s = await held();
  try {
    s.github.prs = [merged(48), merged(52, { head: "fix/ok", body: `Follow-up to ${ID}.`, mergeSha: "d".repeat(40), mergedAt: soon(90) })];
    const { need, delivery } = await reads(s);
    assert.match(need!.next, /holds the merge ddddddd is not known/);
    assert.equal(delivery.steps.find((step) => step.step === "Stage")!.state, "not compared");
  } finally {
    s.stop();
  }
});

test("an app card's builds cover a title-tied merge and a follow-up too", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    const first = commitOnMain(s, "first");
    const later = commitOnMain(s, "follow-up");
    const build = (sha: string) => ({ variants: ["phone"], builds: [{ variant: "phone", environment: "staging", sha, url: "https://apk.example.com/a.apk" }], qa: "passed" as const, qa_at: soon(120) });
    const record = async (op: string, sha: string) => {
      await s.sync().record([{ op_id: op, kind: "set", id: ID, field: "delivery", value: build(sha), expect: s.taskOf(ID).delivery }]).outcomes;
    };
    await record("op-first", first);
    s.github.prs = [
      merged(46, { head: "fix/other-name", title: `fix: other name (${ID})`, body: "", mergeSha: first }),
      merged(52, { head: "fix/ok", body: `Follow-up to ${ID}.`, mergeSha: later, mergedAt: soon(90) }),
    ];
    const without = await reads(s);
    assert.match(without.need!.next, /does not hold #52/);
    assert.doesNotMatch(without.need!.next, /release it to done \(release_task\)$|no merged PR\/MR of the card is known/);
    await record("op-later", later);
    const covered = await reads(s);
    assert.match(covered.need!.next, /^QA passed and every acceptance line is ticked: release it to done/);
    assert.equal(covered.delivery.next, covered.need!.next);
  } finally {
    s.stop();
  }
});

// What the third review found.

const A = "a".repeat(40);
const B = "b".repeat(40);

test("what only a gone hold reads never loosens the closing rule: another PR/MR vouches for no pushed commits", async () => {
  const cases: [string, Partial<FakePr>][] = [
    ["a title-only merge of the same branch", { title: `more (${ID})`, body: "", headSha: B }],
    ["a mention-only merge into another branch with the tip as its head", { body: `Follow-up to ${ID}.`, base: "develop", headSha: B }],
    ["a title-only merge with failing checks and the tip as its head", { title: `more (${ID})`, body: "", checks: ["FAILURE"], headSha: B }],
  ];
  for (const [name, extra] of cases) {
    const s = await reconcileSetup("close", { paseo: { profiles: [PROFILE] } });
    try {
      s.ctx.now = () => new Date();
      await s.card(ID, `status: todo\nlinks: ["${PR_URL(46)}"]\n`, { acceptance: ["[x] Code works"] });
      const run = await startTaskOf(s);
      s.dashboard.runs!.setActivity(run, "stopped", new Date().toISOString());
      await s.settle();
      const tip = name.startsWith("a title-only merge of") ? "c".repeat(40) : B;
      s.github.prs = [merged(46, { head: "fix/other-name", headSha: A }), merged(47, { head: "fix/other-name", mergedAt: soon(90), ...extra })];
      s.github.tips["fix/other-name"] = tip;
      const gate = await s.dashboard.reconciler.gate(s.sync(), ID, run.run_id, PR_URL(46));
      assert.equal(gate?.op, undefined, `${name}: the card must not close`);
      assert.match(gate?.hold ?? "", /commits pushed after #46 merged/, name);
    } finally {
      s.stop();
    }
  }
});

test("an open or merged release from a long-lived branch that lists the card holds nothing", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [
      merged(46),
      { n: 79, state: "OPEN", head: "main", base: "production", title: "release", body: `Includes ${ID}.` },
      merged(80, { head: "develop", title: "release", body: `Includes ${ID}.`, headSha: A }),
    ];
    s.github.tips.develop = B;
    const { need } = await reads(s);
    assert.match(need!.next, /(is|are) merged: check (it|them), then release it to done/);
  } finally {
    s.stop();
  }
});

test("the run's own closed PR/MR is not taken as replaced by a merge of another branch", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [{ n: 60, state: "CLOSED", head: "fix/the-real-work", title: "the work", createdAt: soon(1) }, merged(61, { head: `docs/${ID.toLowerCase()}-notes` })];
    s.run.reportedPr = PR_URL(60);
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: ID, to: "review", run_id: s.run.run_id, run_pr: PR_URL(60), at: new Date().toISOString() }]).outcomes;
    const { need } = await reads(s);
    assert.match(need!.next, /check whether the work of #60 is still needed/);
  } finally {
    s.stop();
  }
});

test("a revert that names the card is looked at, not counted as its merge", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46), merged(47, { head: "revert-46", title: `Revert "fix: other name (${ID})"`, mergedAt: soon(90) })];
    const { need, rec } = await reads(s);
    assert.match(need!.next, /check whether the work #47 reverted is still in main/);
    assert.deepEqual(rec.tasks[0]!.merged.map((pr) => pr.pr), ["#46"]);
  } finally {
    s.stop();
  }
});

// QA cards as recorded from Trello (qa-cards.ts) hold a merged card of a gone agent too.

test("an unsettled QA card is the step of a merged card whose agent is gone: archived passes nothing", async () => {
  const card = "https://trello.com/c/AbCd1234";
  const read = (state: string, extra = "") => `qa_cards: [{url: "${card}", checked: "${soon(120)}", state: ${state}${extra}}]\n`;
  for (const [front, expected, stage] of [
    [`${qa("passed", soon(120))}${read("archived")}`, /archived with no known replacement/, "qa_unclear"],
    [`${qa("passed", soon(120))}${read("open")}`, /^QA passed is recorded, but the acceptance run is open on Trello/, "qa_passed"],
  ] as const) {
    const s = await held(front, { acceptance: ["[x] Code works"] });
    try {
      s.github.prs = [merged(46)];
      const { need, delivery } = await reads(s);
      assert.match(need!.next, expected);
      assert.ok(need!.next.indexOf("release it to done") > need!.next.search(/Trello/), "the release comes after the card is settled");
      assert.doesNotMatch(need!.next, /every acceptance line is ticked: release/);
      assert.deepEqual([delivery.stage, delivery.next], [stage, need!.next]);
      untouched(s, s.run.run_id);
    } finally {
      s.stop();
    }
  }
});

test("merged work that waits only for an open QA card is a qa wait with that card, and merged again once something comes first", async () => {
  const card = "https://trello.com/c/AbCd1234";
  const open = `qa_cards: [{url: "${card}", checked: "2026-01-02T14:03:00Z", state: open, name: "#12 · Sign-in"}]\n`;
  const s = await held(`${QA}${open}`);
  try {
    s.github.prs = [merged(46)];
    const { need, board, task, delivery } = await reads(s);
    assert.deepEqual([need?.kind, board.needs, task.needs], ["qa", "qa", "qa"]);
    assert.match(need!.why, /^Trello #12 open when read 2026-01-02 14:03Z; its agent is stopped; #46/);
    assert.deepEqual(need!.cards![0]!.links.slice(0, 2), [
      { label: "#12", url: card },
      { label: "#46 merged", url: PR_URL(46) },
    ]);
    assert.deepEqual([need!.next, task.next], [delivery.next, delivery.next]);
    assert.equal(task.state?.startsWith("stopped"), true, task.state);
    assert.equal(readOverview(s.dashboard, {}, HOST).needs_you.filter((n) => n.task === ID).length, 1, "said once");
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
  for (const [front, why] of [
    [`${QA}${open}requires: [{kind: decision, reason: pick one of the two fixes}]\n`, "a decision comes first"],
    [`delivery: {trello: "${card}"}\n${open}`, "no stage build is recorded"],
    [QA, "no QA card is recorded"],
  ] as const) {
    const other = await held(front);
    try {
      other.github.prs = [merged(46)];
      assert.equal((await reads(other)).need?.kind, "merged", why);
    } finally {
      other.stop();
    }
  }
});

test("a revert holds a card only while its work has not come back, and the card's own revert is its work", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    const revert = merged(47, { head: "revert-46", title: `Revert "fix: other name (${ID})"`, mergedAt: soon(90) });
    s.github.prs = [merged(46), revert, merged(48, { title: `fix again (${ID})`, mergedAt: soon(120) })];
    const back = await reads(s);
    assert.match(back.need!.next, /are merged: check them, then release it to done/);
    assert.deepEqual(back.rec.tasks[0]!.merged.map((pr) => pr.pr), ["#48", "#46"], "the cleared revert is not merged work");

    s.github.prs = [merged(46), revert, merged(48, { head: "chore/notes", title: "chore: notes", body: `Follow-up to ${ID}: it was reverted.`, mergedAt: soon(120) })];
    assert.match((await reads(s)).need!.next, /check whether the work #47 reverted is still in main/, "a mention brings nothing back");

    s.github.prs = [merged(46), revert, merged(48, { title: `Revert "Revert "fix (${ID})""`, mergedAt: soon(120) })];
    assert.match((await reads(s)).need!.next, /are merged: check them/, "a revert of the revert does");

    s.github.prs = [merged(49, { head: s.taskOf(ID).run_branch!, title: `Revert the new button (${ID})` })];
    assert.match((await reads(s)).need!.next, /#49 \(5ba9e1d\) is merged: check it/);
  } finally {
    s.stop();
  }
});

test("a reconcile that joins a reading begun before the stop reads once more", async () => {
  const s = await held("", { acceptance: ["[x] Code works"] });
  try {
    s.github.prs = [merged(46)];
    s.dashboard.runs!.setActivity(s.run, "working", new Date(Date.now() + 1_000).toISOString());
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    s.github.before = async () => waiting;
    const early = s.dashboard.reconciler.read(s.space(), s.taskOf(ID));
    s.dashboard.runs!.setActivity(s.run, "stopped", new Date(Date.now() + 2_000).toISOString());
    const answer = reconcile(s.ctx, { task: ID });
    release();
    await early;
    assert.deepEqual((await answer).tasks.map((row) => row.merged.map((pr) => pr.pr)), [["#46"]]);
  } finally {
    s.stop();
  }
});

test("a closed chat comes before starting the card again in every read, and an open sub-agent before that", async () => {
  const s = await held();
  try {
    writeRule(s.dashboard.dataDir, { space: "TST", project: "core", mode: "report", no_checks_ok: false });
    s.fake.agents.get(s.run.agentId!)!.status = "closed";
    await s.dashboard.chats.read();

    // Nothing of it on the forge.
    let { need, delivery } = await reads(s);
    assert.match(need!.why, /^its chat is closed, not archived: it can be continued; /);
    assert.match(need!.next, /^continue its chat /);
    // The closing rule's hold on the claim says the same, and does not offer a second start.
    const claim = s.dashboard.reconciler["judgeCard"](s.space(), ID, false, "latest")!.holds.find((hold) => hold.code === "claim")!;
    assert.match(claim.text, /; its chat is closed$/);
    assert.equal(claim.next, "continue its closed chat if work is left, or release it: to done if the work is finished");

    // A forge that is not read in time is no reason to call the agent gone.
    assert.doesNotMatch((await reconcile(s.ctx, { task: ID })).note, /agent is gone/);

    // An open draft of its own: continuing the chat is the way on, before closing or merging it.
    s.github.prs = [{ n: 47, state: "OPEN", draft: true, checks: ["SUCCESS"], head: `fix/${ID.toLowerCase()}-work-47`, body: `Task: ${ID}` }];
    ({ need, delivery } = await reads(s));
    assert.equal(need!.kind, "stopped");
    assert.match(need!.why, /^its chat is closed and can be continued; /);
    assert.match(need!.next, /^continue its closed chat .* to go on with it, or: #47 is a draft/);
    assert.equal(delivery.next, need!.next);

    // A sub-agent of the run still open: looked at first, in every read.
    s.fake.agents.set("sub-1", { ...s.fake.agents.get(s.run.agentId!)!, id: "sub-1", status: "idle", labels: { [PARENT_AGENT_LABEL]: s.run.agentId! } });
    await s.dashboard.chats.read();
    s.github.prs = [merged(46)];
    await reconcile(s.ctx, { task: ID });
    const after = await reads(s);
    assert.equal(after.need!.kind, "subagent");
    assert.equal(after.need!.chat_id, "sub-1");
    assert.match(after.need!.why, /^its sub-agent sub-1 is idle.*; #4[67]/);
    assert.match(after.need!.next, /^check its open sub-agent's chat first; /);
    assert.deepEqual([after.board.next, after.task.next, after.delivery.next], [after.need!.next, after.need!.next, after.need!.next]);
    untouched(s, s.run.run_id);
  } finally {
    s.stop();
  }
});

test("an open sub-agent of the stopped run comes before a qa wait, which stays in the next step", async () => {
  const card = "https://trello.com/c/AbCd1234";
  const open = `qa_cards: [{url: "${card}", checked: "2026-01-02T14:03:00Z", state: open, name: "#12 · Sign-in"}]\n`;
  const s = await held(`${QA}${open}`);
  try {
    const agent = s.fake.agents.get(s.run.agentId!)!;
    agent.status = "closed";
    s.fake.agents.set("sub-1", { ...agent, id: "sub-1", status: "idle", labels: { [PARENT_AGENT_LABEL]: s.run.agentId! } });
    await s.dashboard.chats.read();
    s.github.prs = [merged(46)];
    const { need, task, delivery } = await reads(s);
    assert.deepEqual([need?.kind, need?.chat_id], ["subagent", "sub-1"]);
    assert.match(need!.next, /^check its open sub-agent's chat first; /);
    assert.deepEqual([task.next, delivery.next], [need!.next, need!.next]);
    assert.match(task.state!, /^subagent_open: /);

    // In review nothing but the QA card waits: the qa need, and the state still names the sub-agent.
    await s.sync().record([{ op_id: "op-review", kind: "transition", id: ID, to: "review", run_id: s.run.run_id, at: new Date().toISOString() }]).outcomes;
    const later = await reads(s);
    assert.equal(later.need?.kind, "qa");
    assert.match(later.need!.why, /its chat is closed and can be continued/);
    assert.match(later.task.state!, /^subagent_open: /);
    untouched(s, s.run.run_id, "review");
  } finally {
    s.stop();
  }
});
