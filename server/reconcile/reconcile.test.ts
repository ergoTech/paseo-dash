import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reconcile } from "../api/reconcile.ts";
import { updateTask } from "../api/writes.ts";
import { Dashboard } from "../dashboard.ts";
import { taskDelivery } from "../delivery.ts";
import { readOverview } from "../overview.ts";
import { FakePaseo } from "../runner/testing.ts";
import { scriptedGit, sh, UNREACHABLE } from "../sync/testing.ts";
import { ForgeCli } from "../tracker/forge.ts";
import { closeRevision, CLOSE_FRESH_MS, applyOperation } from "../sync/ops.ts";
import { type FakePr, MERGED_AT, PR_URL, reconcileSetup } from "./testing.ts";
import { writeRule } from "./rules.ts";

/**
 * Automatic reconciliation (JOBBY-G2SEY): a card closes once, on facts read from the forge and the
 * plan, and every doubt leaves it open with one diagnosis and one next step.
 */

const ALL_TICKED = { acceptance: ["[x] Code works", "[x] Verified by hand"] };
const merged = (n = 41, extra: Partial<FakePr> = {}): FakePr => ({ n, state: "MERGED", checks: ["SUCCESS", "SUCCESS"], ...extra });
const links = (...ns: number[]) => `links: [${ns.map((n) => `"${PR_URL(n)}"`).join(", ")}]\n`;

type Setup = Awaited<ReturnType<typeof reconcileSetup>>;

/** The operations the plan was asked to record from now on, to show that a closure was tried and then refused. */
function spy(s: Setup): { kind: string; id: string }[] {
  const asked: { kind: string; id: string }[] = [];
  const sync = s.sync();
  const record = sync.record.bind(sync);
  sync.record = (ops) => {
    for (const op of ops) asked.push({ kind: op.kind, id: "id" in op ? op.id : "" });
    return record(ops);
  };
  return asked;
}

/** The first hold of a card, as the verdict says it. */
const hold = (s: Setup, id: string) => s.dashboard.reconciler.verdict(s.space(), s.taskOf(id))?.holds[0];

async function stays(s: Setup, id: string, code: string) {
  await s.pass();
  await s.settle();
  assert.equal(s.taskOf(id).status, "todo", `${id} stays open`);
  assert.equal(s.taskOf(id).auto_closed, undefined, `${id} has no closure record`);
  assert.equal(hold(s, id)?.code, code, JSON.stringify(s.dashboard.reconciler.verdict(s.space(), s.taskOf(id))?.holds.map((h) => h.code)));
}

test("a merged linked PR with every criterion verified closes the card once, with the facts written on it", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.pass();
    await s.settle();
    const task = s.taskOf("TST-AC001");
    assert.equal(task.status, "done");
    assert.deepEqual(task.auto_closed?.prs, [PR_URL(41)]);
    assert.equal(task.auto_closed?.by, "ergo-mbp");
    assert.match(task.auto_closed?.note ?? "", /#41 \(41bbbbb\) merged into main; #41 2 check\(s\) passed; 2 of 2 acceptance lines ticked/);
    // The plan's history has it once, and a later pass, a sync and the read all agree.
    await s.pass();
    await s.settle();
    const text = (await s.remoteFile(/AC001/)) ?? "";
    assert.equal(text.match(/auto_closed:/g)?.length, 1);
    const commits = sh(s.f.remote, "log", "--format=%H", "main", "--", "tasks/TST-AC001-tst-ac001.md").trim().split("\n");
    assert.equal(commits.length, 2, "the card was created, and closed once");
    assert.deepEqual(s.sync().state.conflicts, []);
  } finally {
    s.stop();
  }
});

test("nothing closes without the owner's rule, and the report mode only says what is left", async () => {
  const off = await reconcileSetup("off");
  try {
    off.github.prs = [merged(41)];
    await off.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await off.pass();
    await off.settle();
    assert.equal(off.taskOf("TST-AC001").status, "todo");
    assert.equal(off.dashboard.reconciler.verdict(off.space(), off.taskOf("TST-AC001")), undefined, "a project that is off has no verdict");
    assert.deepEqual(off.github.calls, [], "and no forge is asked for it");
  } finally {
    off.stop();
  }
  const report = await reconcileSetup("report");
  try {
    report.github.prs = [merged(41)];
    await report.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await stays(report, "TST-AC001", "report");
    assert.match(hold(report, "TST-AC001")!.text, /#41 merged and everything the rule asks is verified; this Mac only reports/);
  } finally {
    report.stop();
  }
});

test("a merge with QA open, a manual step, a decision or an open dependency closes nothing", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), merged(42), merged(43), merged(44), merged(45)];
    await s.card("TST-AC001", `status: todo\n${links(41)}delivery: {qa: pending, stage_sha: abc1234}\n`, ALL_TICKED);
    await s.card("TST-AC002", `status: todo\n${links(42)}labels: [manual]\n`, ALL_TICKED);
    await s.card("TST-AC003", `status: todo\n${links(43)}requires: [{kind: owner, reason: pick the grace period}]\n`, ALL_TICKED);
    await s.card("TST-AC004", `status: todo\n${links(44)}depends_on: ["[[TST-TASK1-one]]"]\n`, ALL_TICKED);
    await s.card("TST-AC005", `status: todo\n${links(45)}`, { acceptance: ["[x] Code works", "[ ] Checked by QA on a device"] });
    await stays(s, "TST-AC001", "qa");
    assert.match(hold(s, "TST-AC001")!.next, /QA tests it and the result is recorded/);
    await stays(s, "TST-AC002", "manual");
    await stays(s, "TST-AC003", "decision");
    await stays(s, "TST-AC004", "dependencies");
    await stays(s, "TST-AC005", "acceptance");
    assert.match(hold(s, "TST-AC005")!.text, /1 of 2 acceptance lines are not ticked: Checked by QA on a device/);
  } finally {
    s.stop();
  }
});

test("a foreign or doubtful PR/MR is not the card's work: another card's, a mere mention, an earlier merge, another base", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [
      merged(41),
      merged(42, { title: "chore: tidy (TST-AC002 follow-up)", body: "Mentions TST-AC003 in passing." }),
      merged(43, { mergedAt: "2026-11-01T10:00:00Z" }),
      merged(44, { base: "release/2.3" }),
    ];
    // #41 is the PR of another card's run: linking it to a second card makes it nobody's alone.
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.card("TST-AC009", `status: in_progress\nrun_id: r-other\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/other\nrun_started: 2026-11-21T10:00:00Z\nrun_pr: ${PR_URL(41)}\n`, ALL_TICKED);
    // Only its description names the card: no link, no branch of the card, no id in its title or branch.
    await s.card("TST-AC003", "status: todo\n", ALL_TICKED);
    // Merged before the card was created.
    await s.card("TST-AC004", `status: todo\n${links(43)}`, ALL_TICKED);
    await s.card("TST-AC005", `status: todo\n${links(44)}`, ALL_TICKED);
    // The merged tracker finds both mentions, and neither is merged work.
    await s.dashboard.merged.checkAll();
    await stays(s, "TST-AC001", "tie");
    assert.match(hold(s, "TST-AC001")!.text, /is the PR\/MR of TST-AC009/);
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC003").status, "todo");
    assert.equal(s.dashboard.reconciler.verdict(s.space(), s.taskOf("TST-AC003")), undefined, "a mention is no work to reconcile");
    const mentioned = await reconcile(s.ctx, { task: "TST-AC003" });
    assert.deepEqual(mentioned.tasks, []);
    assert.match(mentioned.note, /^Mentioned in #42 \(https:\/\/github\.com\/acme\/core\/pull\/42\)/);
    const asked = readOverview(s.dashboard, {}, "ergo-mbp").needs_you.flatMap((item) => item.cards ?? []);
    assert.ok(!asked.some((card) => card.task === "TST-AC003"), "Needs you asks nothing about it");
    await stays(s, "TST-AC004", "tie");
    assert.match(hold(s, "TST-AC004")!.text, /merged before the card was created/);
    await stays(s, "TST-AC005", "base");
    assert.match(hold(s, "TST-AC005")!.text, /merged into release\/2\.3, not main/);
    assert.equal(s.taskOf("TST-AC009").status, "in_progress", "the card whose run it is stays that run's");
    assert.equal(s.taskOf("TST-AC009").run_ended, undefined);
  } finally {
    s.stop();
  }
});

test("a card in review that a merged PR only mentions has no merged PR known, and its row links no mention", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(42, { body: "Not in this PR: the rest is tracked in TST-AC001." })];
    await s.card("TST-AC001", "status: review\n", ALL_TICKED);
    // Twice: the second pass has the first reading, with the mention among its PR/MRs.
    for (let i = 0; i < 2; i += 1) {
      await s.pass();
      await s.settle();
    }
    assert.equal(s.taskOf("TST-AC001").status, "review");
    const codes = s.dashboard.reconciler.verdict(s.space(), s.taskOf("TST-AC001"))!.holds.map((h) => h.code);
    assert.ok(codes.includes("no_pr") && !codes.includes("tie"), codes.join(", "));
    const item = readOverview(s.dashboard, {}, "ergo-mbp").needs_you.find((n) => n.cards?.some((c) => c.task === "TST-AC001"));
    assert.deepEqual(item?.cards?.[0]?.links, []);
    const read = await reconcile(s.ctx, { task: "TST-AC001" });
    assert.deepEqual([read.tasks[0]?.merged, read.tasks[0]?.sources], [[], []]);
    assert.match(read.note, /Mentioned in #42/);
    const delivery = await taskDelivery(s.ctx, { task: "TST-AC001" });
    assert.match(delivery.steps.find((step) => step.step === "MR")!.fact, /^no PR\/MR known\. Mentioned in #42 /);
    assert.equal(delivery.stage, "in_work");
  } finally {
    s.stop();
  }
});

test("a card that ran before keeps its mention in a named read, and a mention is never a hold's evidence", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(42, { body: "Tracked in TST-AC001 and TST-AC002." })];
    await s.card("TST-AC001", "status: todo\nrun_id: r-old\nrun_by: anna\nrun_host: anna-mbp\nrun_ended: 2026-11-21T12:00:00Z\n", ALL_TICKED);
    const first = await reconcile(s.ctx, { task: "TST-AC001" });
    assert.deepEqual(first.tasks, []);
    assert.match(first.note, /^Mentioned in #42 .*TST-AC001 ran before/);
    // The pass keeps reading it, so the mention stays shown; it still gets no verdict.
    await s.pass();
    await s.settle();
    assert.match((await reconcile(s.ctx, { task: "TST-AC001" })).note, /^Mentioned in #42 /);
    assert.equal(s.dashboard.reconciler.verdict(s.space(), s.taskOf("TST-AC001")), undefined);

    // In review with a link into another repository: the hold rests on the card's link, not on the mention.
    await s.card("TST-AC002", `status: review\nlinks: ["https://github.com/acme/other/pull/7"]\n`, ALL_TICKED);
    await s.pass();
    await s.settle();
    s.github.down = true;
    await s.dashboard.reconciler.read(s.space(), s.taskOf("TST-AC002"));
    s.github.down = false;
    const holds = s.dashboard.reconciler.verdict(s.space(), s.taskOf("TST-AC002"))!.holds;
    assert.ok(holds.some((h) => h.code === "forge"));
    assert.ok(!holds.some((h) => h.source.url === PR_URL(42)));
  } finally {
    s.stop();
  }
});

test("partial coverage: another PR/MR of the card still open or dropped, and commits pushed after the merge", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), { n: 42, state: "OPEN", checks: ["SUCCESS"] }, merged(43), { n: 44, state: "CLOSED" }, merged(45, { head: "feat/shared-branch", headSha: "a".repeat(40) })];
    await s.card("TST-AC001", `status: todo\n${links(41, 42)}`, ALL_TICKED);
    await s.card("TST-AC002", `status: todo\n${links(43, 44)}`, ALL_TICKED);
    await s.card("TST-AC003", `status: todo\nbranch: feat/shared-branch\n${links(45)}`, ALL_TICKED);
    s.github.tips["feat/shared-branch"] = "b".repeat(40);
    await stays(s, "TST-AC001", "open_pr");
    assert.match(hold(s, "TST-AC001")!.text, /#42 is still open: only part of the work is merged \(#41\)/);
    await stays(s, "TST-AC002", "closed_pr");
    await stays(s, "TST-AC003", "pushed_after");
  } finally {
    s.stop();
  }
});

test("checks: failing, pending, none and unreadable verify nothing; none is allowed only where the owner says so", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41, { checks: ["SUCCESS", "FAILURE"] }), merged(42, { checks: ["SUCCESS", "PENDING"] }), merged(43, { checks: [] })];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.card("TST-AC002", `status: todo\n${links(42)}`, ALL_TICKED);
    await s.card("TST-AC003", `status: todo\n${links(43)}`, ALL_TICKED);
    await stays(s, "TST-AC001", "checks");
    assert.match(hold(s, "TST-AC001")!.text, /checks of #41 fail: check 2/);
    await stays(s, "TST-AC002", "checks");
    assert.equal(hold(s, "TST-AC002")!.by, "wait", "a check running is nobody's turn");
    await stays(s, "TST-AC003", "checks");
    assert.match(hold(s, "TST-AC003")!.text, /no check ran on #43/);
    // The owner lets this project close without checks: the card with none closes, the others stay.
    writeRule(s.dashboard.dataDir, { space: "TST", project: "core", mode: "close", no_checks_ok: true });
    await s.pass();
    await s.settle();
    assert.deepEqual([s.taskOf("TST-AC001").status, s.taskOf("TST-AC002").status, s.taskOf("TST-AC003").status], ["todo", "todo", "done"]);
    assert.match(s.taskOf("TST-AC003").auto_closed?.note ?? "", /no checks \(allowed\)/);
  } finally {
    s.stop();
  }
});

test("a scope change after the merge, or someone's decision about the card since, keeps it open", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), merged(42), merged(43)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.card("TST-AC002", `status: todo\n${links(42)}`, ALL_TICKED);
    await s.card("TST-AC003", `status: todo\n${links(43)}`, ALL_TICKED);
    const later = new Date(Date.parse(MERGED_AT) + 3_600_000).toISOString();
    const edited = (edit: (root: string) => void) => {
      process.env.GIT_COMMITTER_DATE = later;
      process.env.GIT_AUTHOR_DATE = later;
      try {
        s.f.external("ergo", edit);
      } finally {
        delete process.env.GIT_COMMITTER_DATE;
        delete process.env.GIT_AUTHOR_DATE;
      }
    };
    // AC001: a line added after the merge, ticked at once. AC002: marked done and reopened.
    edited((root) => {
      const path = join(root, "tasks", "TST-AC001-tst-ac001.md");
      const text = require_text(path);
      writeFileSync(path, text.replace("- [x] Verified by hand", "- [x] Verified by hand\n- [x] Works offline too"));
    });
    edited((root) => {
      const path = join(root, "tasks", "TST-AC002-tst-ac002.md");
      writeFileSync(path, require_text(path).replace("status: todo", "status: done"));
    });
    edited((root) => {
      const path = join(root, "tasks", "TST-AC002-tst-ac002.md");
      writeFileSync(path, require_text(path).replace("status: done", "status: todo"));
    });
    await s.sync().sync();
    await stays(s, "TST-AC001", "scope");
    assert.match(hold(s, "TST-AC001")!.text, /brief, acceptance or clarifications changed after the merge/);
    await stays(s, "TST-AC002", "scope");
    assert.match(hold(s, "TST-AC002")!.text, /it was done on \d{4}-\d\d-\d\d, after the merge/);
    // The card nobody touched closes.
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC003").status, "done");
  } finally {
    s.stop();
  }
});

function require_text(path: string): string {
  return readFileSync(path, "utf8");
}

test("an active claim is never closed, stopped, released or restarted by a merge", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: in_progress\nrun_id: r-anna\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/anna\nrun_started: 2026-11-21T10:00:00Z\n${links(41)}`, ALL_TICKED);
    await s.pass();
    await s.settle();
    const task = s.taskOf("TST-AC001");
    assert.deepEqual([task.status, task.run_id, task.run_ended, task.auto_closed], ["in_progress", "r-anna", undefined, undefined]);
    assert.equal(hold(s, "TST-AC001")?.code, "claim");
    assert.deepEqual(s.fake.archived, [], "no workspace was archived");
    assert.deepEqual(s.fake.calls.filter((c) => c.kind !== "workspace.create"), [], "and no agent was asked anything");
  } finally {
    s.stop();
  }
});

test("a forge that cannot be read closes nothing, says so with one next step, and the card closes once it answers", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    s.github.down = true;
    await stays(s, "TST-AC001", "forge");
    const first = hold(s, "TST-AC001")!;
    assert.equal(first.by, "owner");
    assert.match(first.text, /not all of its forge facts could be read/);
    assert.match(first.next, /gh or glab login/);
    // It shows in Needs you with the card and where the decision comes from.
    const need = readOverview(s.dashboard, {}).needs_you.find((n) => n.kind === "reconcile");
    assert.equal(need?.task, "TST-AC001");
    assert.deepEqual([need?.cards?.[0]?.source, need?.cards?.[0]?.links], ["#41 (not read)", [{ label: "#41 (not read)", url: PR_URL(41) }]]);
    // The forge answers again: the next pass reads the card again and closes it.
    s.github.down = false;
    await s.dashboard.reconciler.read(s.space(), s.taskOf("TST-AC001"));
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC001").status, "done");
  } finally {
    s.stop();
  }
});

test("facts that appear later change the diagnosis: a QA result and a tick close what was held", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}delivery: {qa: pending}\n`, { acceptance: ["[x] Code works", "[ ] Verified by hand"] });
    await stays(s, "TST-AC001", "acceptance");
    await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-AC001", line: "Verified by hand", done: true }]).outcomes;
    assert.equal(hold(s, "TST-AC001")?.code, "qa", "the diagnosis moved on at once, without a pass");
    assert.equal((await updateTask(s.ctx, { task: "TST-AC001", delivery: { qa: "passed" } })).ok, true);
    assert.equal(s.dashboard.reconciler.verdict(s.space(), s.taskOf("TST-AC001"))?.close, true);
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC001").status, "done");
    assert.match(s.taskOf("TST-AC001").auto_closed?.note ?? "", /QA passed/);
  } finally {
    s.stop();
  }
});

test("the card changed between the check and the write: the closure is dropped and the owner's edit stands", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    const asked = spy(s);
    // The owner adds a label of manual work on origin; this Mac has not synced yet and checks the card as it was.
    s.f.external("owner", (root) => {
      const path = join(root, "tasks", "TST-AC001-tst-ac001.md");
      writeFileSync(path, require_text(path).replace("status: todo", "status: todo\nlabels: [manual]"));
    });
    await s.pass();
    await s.settle();
    assert.deepEqual(asked, [{ kind: "close", id: "TST-AC001" }], "the closure was written on the card as this Mac saw it");
    const task = s.taskOf("TST-AC001");
    assert.equal(task.status, "todo");
    assert.deepEqual(task.labels, ["manual"], "the owner's edit is there");
    assert.equal(task.auto_closed, undefined);
    assert.deepEqual(s.sync().state.conflicts, [], "a dropped closure is no conflict for anyone to resolve");
    assert.equal(s.sync().journalEntries.length, 0, "and nothing stays queued");
    assert.equal(hold(s, "TST-AC001")?.code, "manual");
  } finally {
    s.stop();
  }
});

test("a race with the owner: a card marked done or canceled meanwhile is not written over, and a reopened one is never closed again", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), merged(42), merged(43)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.card("TST-AC002", `status: todo\n${links(42)}`, ALL_TICKED);
    await s.card("TST-AC003", `status: todo\n${links(43)}`, ALL_TICKED);
    const asked = spy(s);
    s.f.external("owner", (root) => {
      const path = join(root, "tasks", "TST-AC001-tst-ac001.md");
      writeFileSync(path, require_text(path).replace("status: todo", "status: canceled"));
    });
    await s.pass();
    await s.settle();
    assert.ok(asked.some((op) => op.kind === "close" && op.id === "TST-AC001"), "a closure of the card was tried");
    assert.equal(s.taskOf("TST-AC001").status, "canceled", "the owner's cancel stands");
    assert.equal(s.taskOf("TST-AC001").auto_closed, undefined);
    assert.equal(s.taskOf("TST-AC002").status, "done");
    // The owner reopens a card the rule closed: it stays theirs.
    s.f.external("owner", (root) => {
      const path = join(root, "tasks", "TST-AC002-tst-ac002.md");
      writeFileSync(path, require_text(path).replace("status: done", "status: todo"));
    });
    await s.sync().sync();
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC002").status, "todo");
    assert.equal(hold(s, "TST-AC002")?.code, "reopened");
  } finally {
    s.stop();
  }
});

test("a closure that was journaled and not pushed is written once after a restart, never twice", async () => {
  const offline = scriptedGit({ push: async () => UNREACHABLE });
  // Only this machine's pushes are cut: the card is written by a person's own clone.
  const s = await reconcileSetup("close", { dashboard: { runner: offline } });
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AC001").status, "done", "applied here");
    assert.equal(s.sync().journalEntries.filter((e) => e.op.kind === "close").length, 1, "journaled once");
    const origin = sh(s.f.remote, "show", "main:tasks/TST-AC001-tst-ac001.md");
    assert.doesNotMatch(origin, /auto_closed/, "not on origin: the push was cut");
    const dataDir = s.dashboard.dataDir;
    s.stop();

    // A new process on the same data, with the network back.
    const again = new Dashboard({ dataDir, fetchIntervalMs: 3_600_000, forge: new ForgeCli(s.github.runner()), reconcile: { host: "ergo-mbp" } });
    again.attach(new FakePaseo().api());
    await again.start();
    await again.syncAll();
    await again.spaces.get("TST")!.sync.sync();
    const landed = sh(s.f.remote, "show", "main:tasks/TST-AC001-tst-ac001.md");
    assert.equal(landed.match(/auto_closed:/g)?.length, 1);
    assert.match(landed, /status: done/);
    // Another pass, and another restart, write nothing more.
    await again.reconciler.pass();
    await again.spaces.get("TST")!.sync.sync();
    const closings = sh(s.f.remote, "log", "--format=%H", "main", "-S", "auto_closed", "--", "tasks/TST-AC001-tst-ac001.md").trim().split("\n").filter(Boolean);
    assert.equal(closings.length, 1, "one commit wrote the closure");
    again.stop();
  } finally {
    s.stop();
  }
});

test("a closure refuses to apply on old evidence, on another revision, and when the rule no longer allows it", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41)];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, ALL_TICKED);
    const loaded = s.sync().plan.entities.get("TST-AC001")!;
    const closure = { at: new Date().toISOString(), by: "ergo-mbp", prs: [PR_URL(41)], note: "n" };
    const op = { op_id: "op-close", kind: "close" as const, id: "TST-AC001", expect_rev: closeRevision(loaded), closure };
    const apply = (o: typeof op, now = new Date()) => applyOperation(s.sync().root, s.sync().plan, o, now.toISOString());
    assert.equal(apply({ ...op, expect_rev: "stale" }).status, "dropped");
    const old = new Date(Date.parse(closure.at) + CLOSE_FRESH_MS + 1_000);
    const expired = apply(op, old);
    assert.deepEqual([expired.status, (expired as { reason?: string }).reason], ["dropped", "the facts it stands on were read too long ago"]);
    writeRule(s.dashboard.dataDir, { space: "TST", project: "core", mode: "report", no_checks_ok: false });
    assert.match(s.dashboard.reconciler.mayClose("TST", "TST-AC001") ?? "", /does not let core close cards/);
    const recorded = s.sync().record([{ ...op, op_id: "op-close-2" }]);
    const outcome = (await recorded.outcomes).get("op-close-2");
    assert.deepEqual([outcome?.status, s.taskOf("TST-AC001").status], ["dropped", "todo"], "a rule switched off after the check stops it at the apply");
  } finally {
    s.stop();
  }
});

test("Needs you groups cards that wait for the same thing and keeps each card's links and source", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), merged(42), merged(43)];
    for (const [id, n] of [["TST-AC001", 41], ["TST-AC002", 42], ["TST-AC003", 43]] as const) {
      await s.card(id, `status: todo\n${links(n)}labels: [manual]\n`, ALL_TICKED);
    }
    await s.pass();
    await s.settle();
    const needs = readOverview(s.dashboard, {}).needs_you.filter((n) => n.kind === "reconcile");
    assert.equal(needs.length, 1, "three cards that wait for the same thing are one item");
    const [group] = needs;
    assert.match(group!.title, /3 cards: manual acceptance/);
    assert.deepEqual(group!.cards?.map((c) => [c.task, c.links.map((l) => l.url)]), [
      ["TST-AC001", [PR_URL(41)]],
      ["TST-AC002", [PR_URL(42)]],
      ["TST-AC003", [PR_URL(43)]],
    ]);
    assert.ok(group!.cards?.every((c) => c.source && c.note.includes("manual acceptance")));
    assert.match(group!.next, /the owner does the check, then: mark it done/);
  } finally {
    s.stop();
  }
});
