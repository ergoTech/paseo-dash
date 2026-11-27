import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcile } from "../api/reconcile.ts";
import { getTask } from "../api/reads.ts";
import { startTask, updateTask } from "../api/writes.ts";
import { taskDelivery } from "../delivery.ts";
import { readOverview } from "../overview.ts";
import { settled } from "../runner/testing.ts";
import { sh } from "../sync/testing.ts";
import { type FakePr, MERGED_AT, PR_URL, reconcileSetup } from "./testing.ts";

/**
 * Holes an independent review of JOBBY-G2SEY found, one test each: each of these closed a card,
 * said a build was ready or lost a PR/MR when it must not.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const TICKED = { acceptance: ["[x] Code works"] };
const merged = (n: number, extra: Partial<FakePr> = {}): FakePr => ({ n, state: "MERGED", checks: ["SUCCESS"], ...extra });
const links = (...ns: number[]) => `links: [${ns.map((n) => `"${PR_URL(n)}"`).join(", ")}]\n`;

type Setup = Awaited<ReturnType<typeof reconcileSetup>>;
const hold = (s: Setup, id: string) => s.dashboard.reconciler.verdict(s.space(), s.taskOf(id))?.holds[0];

/** A live run of TST-FX001 on feat/login with every line ticked and its PR #7 merged. */
async function mergedRun(s: Setup) {
  await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => run.activity !== "launching");
  s.github.prs = [merged(7, { head: "feat/login", mergedAt: MERGED_AT, headSha: "a".repeat(40) })];
  s.github.tips["feat/login"] = "a".repeat(40);
  await s.sync().record([{ op_id: "op-tick", kind: "check", id: "TST-FX001", line: "second", done: true, run_id: run.run_id }]).outcomes;
  return run;
}

test("an earlier run's merge never ends the run that took the task while it was being checked", async () => {
  const s = await reconcileSetup("close", { paseo: { profiles: [PROFILE] } });
  try {
    const run = await mergedRun(s);
    await s.sync().record([{ op_id: "op-link", kind: "set", id: "TST-FX001", field: "links", value: [PR_URL(7)], expect: [] }]).outcomes;
    let swapped = false;
    // While the tracker reads the merged branch's tip, a person releases the run and a new one takes the task.
    s.github.before = async (command) => {
      if (command !== "git" || swapped) return;
      swapped = true;
      const at = new Date().toISOString();
      await s.sync().record([{ op_id: "op-release", kind: "release", id: "TST-FX001", run_id: run.run_id, to: "todo", at }]).outcomes;
      const claim = await s.sync().claim("TST-FX001", { run_id: "r-second", run_by: "ergo", run_host: "ergo-mbp", run_branch: "feat/login-2", run_started: at });
      assert.equal(claim.result, "won");
    };
    await s.dashboard.prs.checkAll();
    await s.settle();
    assert.equal(swapped, true);
    const task = s.task("TST-FX001")!;
    assert.deepEqual([task.status, task.run_id, task.run_ended, task.auto_closed], ["in_progress", "r-second", undefined, undefined]);
    // Asked directly for the old run, the rule refuses too.
    assert.match((await s.dashboard.reconciler.gate(s.sync(), "TST-FX001", run.run_id, PR_URL(7)))?.hold ?? "", /no longer holds the task/);
  } finally {
    s.stop();
  }
});

test("a held live run is told to release the task, never to set it done, which the plugin refuses", async () => {
  const s = await reconcileSetup("report", { paseo: { profiles: [PROFILE] } });
  try {
    await mergedRun(s);
    await s.dashboard.prs.checkAll();
    await s.settle();
    const need = readOverview(s.dashboard, {}, "ergo-mbp").needs_you.find((n) => n.task === "TST-FX001");
    const next = `${need?.next} ${s.dashboard.reconciler.heldRun(s.space(), s.taskOf("TST-FX001"), { kind: "merged" })?.next}`;
    assert.match(next, /release it to done \(release_task\)/);
    assert.doesNotMatch(next, /update_task status done/);
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", status: "done" })).ok, false, "which is why");
  } finally {
    s.stop();
  }
});

test("the rule holds a run's merge even when the plan's space key changed on origin", async () => {
  const s = await reconcileSetup("report", { paseo: { profiles: [PROFILE] } });
  try {
    await mergedRun(s);
    s.f.external("owner", (root) => {
      const path = join(root, "space.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("key: TST", "key: TSX"));
    });
    await s.sync().sync();
    await s.dashboard.prs.checkAll();
    await s.settle();
    assert.equal(s.task("TST-FX001")!.status, "in_progress");
    assert.match(getTask(s.ctx, { task: "TST-FX001" }).pr, /not closed/);
  } finally {
    s.stop();
  }
});

test("a linked fork's PR, a link into another repository and a skipped-only check keep the card open with their own step", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), { n: 42, state: "OPEN", checks: ["FAILURE"], fork: true }, merged(43), merged(44, { checks: ["SKIPPED", "SKIPPED"] })];
    await s.card("TST-AC001", `status: todo\n${links(41, 42)}`, TICKED);
    await s.card("TST-AC002", `status: todo\nlinks: ["${PR_URL(43)}", "https://github.com/acme/other/pull/9"]\n`, TICKED);
    await s.card("TST-AC003", `status: todo\n${links(44)}`, TICKED);
    await s.pass();
    await s.settle();
    assert.deepEqual(["TST-AC001", "TST-AC002", "TST-AC003"].map((id) => s.taskOf(id).status), ["todo", "todo", "todo"]);
    assert.match(hold(s, "TST-AC001")!.text, /#42 is from a fork/);
    assert.match(hold(s, "TST-AC002")!.text, /another repository/);
    assert.match(hold(s, "TST-AC002")!.next, /check it yourself; else take it off the card/);
    assert.doesNotMatch(hold(s, "TST-AC002")!.next, /gh or glab login/, "waiting or logging in would not help");
    assert.deepEqual(s.dashboard.reconciler.current(s.space(), s.taskOf("TST-AC002"))?.unknown, [], "nothing to retry every minute");
    assert.match(hold(s, "TST-AC003")!.text, /no check ran on #44/);
  } finally {
    s.stop();
  }
});

test("an open follow-up nobody linked, naming the card in its title or branch, is partial coverage", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [merged(41), { n: 42, state: "OPEN", head: "feat/tst-ac001-part2", checks: ["SUCCESS"] }, merged(43), { n: 44, state: "OPEN", title: "Rest of TST-AC002", checks: ["SUCCESS"] }];
    await s.card("TST-AC001", `status: todo\n${links(41)}`, TICKED);
    await s.card("TST-AC002", `status: todo\n${links(43)}`, TICKED);
    await s.pass();
    await s.settle();
    for (const id of ["TST-AC001", "TST-AC002"]) {
      assert.equal(s.taskOf(id).status, "todo");
      assert.equal(hold(s, id)?.code, "open_pr", id);
    }
  } finally {
    s.stop();
  }
});

test("one PR/MR two cards name is one row of the merge list, with both cards; nothing drops out of Needs you", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [{ n: 50, state: "OPEN", checks: ["SUCCESS"] }, { n: 51, state: "OPEN", draft: true }, { n: 52, state: "OPEN", base: "release/1", checks: ["SUCCESS"] }];
    await s.card("TST-AC001", `status: todo\n${links(50)}`, TICKED);
    await s.card("TST-AC002", `status: todo\n${links(50)}`, TICKED);
    await s.card("TST-AC003", `status: todo\n${links(51)}`, TICKED);
    await s.card("TST-AC004", `status: todo\n${links(52)}`, TICKED);
    await s.pass();
    const needs = readOverview(s.dashboard, {}).needs_you;
    const list = needs.find((n) => n.kind === "merge")!;
    const shared = list.cards!.find((c) => c.links[0]!.url === PR_URL(50))!;
    assert.deepEqual([shared.task, shared.also, list.cards!.length], ["TST-AC001", ["TST-AC002"], 2]);
    assert.deepEqual(list.cards!.find((c) => c.task === "TST-AC004")!.blockers, ["it targets release/1, not main"]);
    // The draft is in no list to merge: its card is still said, as a group.
    assert.ok(needs.some((n) => n.kind === "reconcile" && n.cards?.some((c) => c.task === "TST-AC003")));
    // A short excerpt keeps the one list.
    assert.equal(readOverview(s.dashboard, { limit: 1 }).needs_you[0]?.kind, "merge");
  } finally {
    s.stop();
  }
});

test("no build covers a card with a PR/MR that could not be read, or a shared one still open", async () => {
  const s = await reconcileSetup();
  try {
    const root = s.dashboard.projectRoots.get("prj_core")!;
    sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "merge");
    const a = sh(root, "rev-parse", "HEAD").trim();
    sh(root, "push", "--quiet", "origin", "HEAD:main");
    const build = `delivery: {variants: [phone], qa: pending, builds: [{variant: phone, sha: ${a}, url: "https://apk.example.com/a.apk"}]}\n`;
    s.github.prs = [merged(1, { mergeSha: a }), merged(2, { mergeSha: a }), { n: 3, state: "OPEN" }, merged(4, { mergeSha: a })];
    s.github.unreadable = [2];
    await s.card("TST-AP001", `status: todo\n${links(1, 2)}${build}`, TICKED);
    await s.card("TST-AP002", `status: todo\n${links(4, 3)}${build}`, TICKED);
    await s.card("TST-AP003", `status: todo\n${links(3)}`, TICKED);
    const read = async (task: string) => {
      const view = await taskDelivery(s.ctx, { task });
      return { ...view, step: (name: string) => view.steps.find((x) => x.step === name)! };
    };
    const unread = await read("TST-AP001");
    assert.deepEqual([unread.step("Code").state, unread.step("APK phone").state], ["not all read", "not known"]);
    assert.notEqual(unread.stage, "ready_for_qa");
    assert.doesNotMatch(unread.next, /QA installs/);
    const shared = await read("TST-AP002");
    assert.equal(shared.step("APK phone").state, "awaited");
    assert.match(shared.step("APK phone").fact, /#3 is not merged yet/);
    // Not known is never answered with "build it".
    await s.pass();
    const group = readOverview(s.dashboard, {}).needs_you.find((n) => n.cards?.some((c) => c.task === "TST-AP001"))!;
    assert.doesNotMatch(group.next, /build the phone APK/);
  } finally {
    s.stop();
  }
});

test("both variants' builds stay linked on a card that waits for QA", async () => {
  const s = await reconcileSetup();
  try {
    const root = s.dashboard.projectRoots.get("prj_core")!;
    sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "merge");
    const a = sh(root, "rev-parse", "HEAD").trim();
    sh(root, "push", "--quiet", "origin", "HEAD:main");
    const apk = (variant: string) => `{variant: ${variant}, sha: ${a}, url: "https://apk.example.com/${variant}.apk"}`;
    s.github.prs = [merged(1, { mergeSha: a })];
    await s.card("TST-AP001", `status: todo\n${links(1)}delivery: {variants: [phone, wear], qa: pending, builds: [${apk("phone")}, ${apk("wear")}]}\n`, TICKED);
    await s.pass();
    const card = readOverview(s.dashboard, {}).needs_you.flatMap((n) => n.cards ?? []).find((c) => c.task === "TST-AP001")!;
    assert.deepEqual(card.links.map((l) => l.url).sort(), ["https://apk.example.com/phone.apk", "https://apk.example.com/wear.apk", PR_URL(1)]);
    const space = await reconcile(s.ctx, {});
    assert.match(space.note, /1 more open card without merged work|1 open task with merged work/);
  } finally {
    s.stop();
  }
});

test("a screen over many cards asks the forge about two of them at a time", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = Array.from({ length: 8 }, (_, i) => merged(i + 1));
    for (let i = 1; i <= 8; i += 1) await s.card(`TST-AC00${i}`, `status: todo\n${links(i)}labels: [manual]\n`, TICKED);
    await Promise.all(Array.from({ length: 8 }, (_, i) => s.dashboard.reconciler.read(s.space(), s.taskOf(`TST-AC00${i + 1}`))));
    // Each read lists open PR/MRs twice at once; everything else of it is one call at a time.
    assert.ok(s.github.peak <= 4, `at most 4 calls at once, were ${s.github.peak}`);
  } finally {
    s.stop();
  }
});
