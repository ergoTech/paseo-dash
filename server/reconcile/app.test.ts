import { test } from "node:test";
import assert from "node:assert/strict";
import { updateTask } from "../api/writes.ts";
import { taskDelivery } from "../delivery.ts";
import { readOverview } from "../overview.ts";
import { sh } from "../sync/testing.ts";
import { type FakePr, PR_URL, reconcileSetup } from "./testing.ts";

/**
 * An app's way to QA and to Google Play (JOBBY-G2SEY): several PRs merged, one build covers the cards
 * whose changes it holds, QA and the publication stay their own states, and a PR that is not in the
 * build's commit leaves its card uncovered.
 */

type Setup = Awaited<ReturnType<typeof reconcileSetup>>;

const APK = "https://apk.example.com/staging-b.apk";

/** Commits of the project's checkout, pushed to its origin: the target branch as this Mac last fetched it. */
function trunkCommits(s: Setup, count: number): string[] {
  const root = s.dashboard.projectRoots.get("prj_core")!;
  const shas: string[] = [];
  for (let i = 0; i < count; i += 1) {
    sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", `merge ${i + 1}`);
    shas.push(sh(root, "rev-parse", "HEAD").trim());
  }
  sh(root, "push", "--quiet", "origin", "HEAD:main");
  return shas;
}

const merged = (n: number, mergeSha: string): FakePr => ({ n, state: "MERGED", mergeSha, checks: ["SUCCESS"] });
const phone = (sha: string, url = APK) => `{variant: phone, environment: staging, sha: ${sha}, url: "${url}", version: 1.4.0}`;
const app = (n: number, extra = "") => `status: todo\nlinks: ["${PR_URL(n)}"]\n${extra}`;
const TICKED = { acceptance: ["[x] Works on the device"] };

async function delivery(s: Setup, task: string) {
  const view = await taskDelivery(s.ctx, { task });
  assert.equal(view.error, "");
  return { ...view, step: (name: string) => view.steps.find((x) => x.step === name) };
}

test("three PRs merged and one staging build: it covers the cards whose merge it holds; QA and Google Play stay apart", async () => {
  const s = await reconcileSetup();
  try {
    const [a, b, c] = trunkCommits(s, 3) as [string, string, string];
    // The build was made from the second merge: it holds the first two and not the third.
    s.github.prs = [merged(1, a), merged(2, b), merged(3, c), merged(4, a)];
    await s.card("TST-AP001", app(1, `delivery: {variants: [phone], qa: pending, builds: [${phone(b)}]}\n`), TICKED);
    await s.card("TST-AP002", app(2, "delivery: {variants: [phone], qa: pending}\n"), TICKED);
    await s.card("TST-AP003", app(3, "delivery: {variants: [phone], qa: pending}\n"), TICKED);
    // Needs the watch too: its phone build is there, its wear build is not.
    await s.card("TST-AP004", app(4, "delivery: {variants: [phone, wear], qa: pending}\n"), TICKED);
    await s.pass();
    await s.settle();
    assert.deepEqual(["TST-AP001", "TST-AP002", "TST-AP003", "TST-AP004"].map((id) => s.taskOf(id).status), ["todo", "todo", "todo", "todo"], "a merge and an available build close nothing");

    const one = await delivery(s, "TST-AP001");
    const two = await delivery(s, "TST-AP002");
    assert.equal(one.step("Code")?.state, "merged");
    assert.deepEqual([one.step("APK phone")?.state, two.step("APK phone")?.state], ["available", "available"], "one build, two cards");
    assert.match(one.step("APK phone")!.fact, new RegExp(APK.replace(/\./g, "\\.")));
    assert.match(two.step("APK phone")!.fact, new RegExp(APK.replace(/\./g, "\\.")), "the second card never recorded it: the project's build covers it");
    assert.match(two.step("APK phone")!.fact, /holds #2/);
    assert.deepEqual([one.stage, two.stage, one.next_by], ["ready_for_qa", "ready_for_qa", "QA"]);
    assert.equal(one.step("QA")?.state, "pending", "the build being there marks no test passed");
    assert.equal(one.step("Google Play")?.state, "unpublished", "a merge and a build publish nothing");

    // The third merge is not in the build: its card stays uncovered, and says which merge is missing.
    const three = await delivery(s, "TST-AP003");
    assert.equal(three.step("APK phone")?.state, "awaited");
    assert.match(three.step("APK phone")!.fact, /does not hold #3/);
    assert.equal(three.stage, "waiting_for_stage");
    assert.equal(three.next_by, "deploy");
    assert.match(three.next, /build it from main and record it/);

    // The watch's build is its own state: the card is ready for neither.
    const watch = await delivery(s, "TST-AP004");
    assert.deepEqual([watch.step("APK phone")?.state, watch.step("APK wear")?.state], ["available", "awaited"]);
    assert.match(watch.step("APK wear")!.fact, /no wear build for staging is recorded/);
    assert.equal(watch.stage, "waiting_for_stage");

    // Needs you: the two cards one build covers wait for QA together, with the build and their PRs linked;
    // the uncovered ones wait for a build, each for its own.
    const groups = readOverview(s.dashboard, {}).needs_you.filter((n) => n.kind === "reconcile");
    const covered = groups.find((g) => g.cards?.some((c) => c.task === "TST-AP001"))!;
    assert.deepEqual(covered.cards?.map((c) => c.task), ["TST-AP001", "TST-AP002"]);
    assert.ok(covered.cards?.every((c) => c.links.some((l) => l.url === APK) && c.links.some((l) => l.url.includes("/pull/"))), "the build and each PR stay linked");
    assert.match(covered.next, /QA installs the build, tests the card and the result is recorded/);
    assert.deepEqual(groups.filter((g) => g !== covered).flatMap((g) => g.cards?.map((c) => c.task) ?? []).sort(), ["TST-AP003", "TST-AP004"]);

    // QA passes one card: it closes though nothing is published. Publishing another settles no QA.
    assert.equal((await updateTask(s.ctx, { task: "TST-AP001", delivery: { qa: "passed" } })).ok, true);
    assert.equal((await updateTask(s.ctx, { task: "TST-AP002", delivery: { play: "published" } })).ok, true);
    await s.pass();
    await s.settle();
    assert.equal(s.taskOf("TST-AP001").status, "done");
    assert.equal((await delivery(s, "TST-AP001")).step("Google Play")?.state, "unpublished");
    assert.equal(s.taskOf("TST-AP002").status, "todo", "published does not accept it");
    const published = await delivery(s, "TST-AP002");
    assert.deepEqual([published.step("QA")?.state, published.step("Google Play")?.state], ["pending", "published"]);
  } finally {
    s.stop();
  }
});

/** A project with one card whose merge is `a`, one build recorded on it, and trunk commits a and b. */
async function oneBuild(front: (shas: { a: string; b: string; local: string }) => string) {
  const s = await reconcileSetup();
  const [a, b] = trunkCommits(s, 2) as [string, string];
  const root = s.dashboard.projectRoots.get("prj_core")!;
  // A commit that holds the merge but was never pushed to the target branch.
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "local only");
  const local = sh(root, "rev-parse", "HEAD").trim();
  s.github.prs = [merged(1, a)];
  await s.card("TST-AP001", app(1, front({ a, b, local })), TICKED);
  await s.pass();
  return { s, view: await delivery(s, "TST-AP001") };
}

test("a build never pushed to the target branch covers nothing, however much it holds", async () => {
  const { s, view } = await oneBuild(({ local }) => `delivery: {variants: [phone], qa: pending, builds: [${phone(local, "https://apk.example.com/local.apk")}]}\n`);
  try {
    assert.equal(view.step("APK phone")?.state, "awaited");
    assert.match(view.step("APK phone")!.fact, /is not on origin\/main as this checkout last fetched it/);
  } finally {
    s.stop();
  }
});

test("a staging build is not a prod build, and a build nobody can install is not available", async () => {
  const prod = await oneBuild(({ b }) => `delivery: {variants: [phone], environment: prod, qa: pending, builds: [${phone(b)}]}\n`);
  try {
    assert.equal(prod.view.step("APK phone")?.state, "awaited", "the staging build is not a prod build");
    assert.match(prod.view.step("APK phone")!.fact, /no phone build for prod is recorded/);
  } finally {
    prod.s.stop();
  }
  const noLink = await oneBuild(({ b }) => `delivery: {variants: [phone], qa: pending, builds: [{variant: phone, environment: staging, sha: ${b}}]}\n`);
  try {
    assert.equal(noLink.view.step("APK phone")?.state, "awaited");
    assert.match(noLink.view.step("APK phone")!.fact, /holds the changes but no link to install it is recorded/);
  } finally {
    noLink.s.stop();
  }
  // Another variant's build covers nothing for this one.
  const wear = await oneBuild(({ b }) => `delivery: {variants: [phone], qa: pending, builds: [{variant: wear, environment: staging, sha: ${b}, url: "https://apk.example.com/wear.apk"}]}\n`);
  try {
    assert.match(wear.view.step("APK phone")!.fact, /no phone build for staging is recorded/);
  } finally {
    wear.s.stop();
  }
});

test("a card with its PR still open is covered by no build, whatever the build holds", async () => {
  const s = await reconcileSetup();
  try {
    const [a, b] = trunkCommits(s, 2) as [string, string];
    s.github.prs = [merged(1, a), { n: 2, state: "OPEN", checks: ["SUCCESS"] }];
    await s.card("TST-AP001", `status: todo\nlinks: ["${PR_URL(1)}", "${PR_URL(2)}"]\ndelivery: {variants: [phone], qa: pending, builds: [${phone(b)}]}\n`, TICKED);
    const view = await delivery(s, "TST-AP001");
    assert.equal(view.step("APK phone")?.state, "awaited");
    assert.match(view.step("APK phone")!.fact, /#2 is not merged yet/);
    assert.equal(view.step("Code")?.state, "partly merged");
    assert.equal(view.stage, "waiting_for_merge");
  } finally {
    s.stop();
  }
});

test("Needs you lists every open PR/MR once, in the order to merge them, each with its own blockers", async () => {
  const s = await reconcileSetup();
  try {
    const [a] = trunkCommits(s, 1) as [string];
    s.github.prs = [
      { n: 11, state: "OPEN", checks: ["SUCCESS"], review: "APPROVED" },
      { n: 12, state: "OPEN", checks: ["SUCCESS", "FAILURE"], mergeable: "CONFLICTING", mergeState: "DIRTY" },
      { n: 13, state: "OPEN", checks: ["SUCCESS"] },
      { n: 14, state: "OPEN", draft: true, checks: ["SUCCESS"] },
      { n: 15, state: "OPEN", checks: ["SUCCESS"] },
      merged(16, a),
    ];
    // MQ001 waits for MQ003's code; MQ005 waits for MQ006, whose code is merged and whose QA is still to come.
    await s.card("TST-MQ001", `status: todo\nlinks: ["${PR_URL(11)}"]\ndepends_on: ["[[TST-MQ003-tst-mq003]]"]\n`);
    await s.card("TST-MQ002", `status: todo\nlinks: ["${PR_URL(12)}"]\n`);
    await s.card("TST-MQ003", `status: todo\nlinks: ["${PR_URL(13)}"]\n`);
    await s.card("TST-MQ004", `status: todo\nlinks: ["${PR_URL(14)}"]\n`);
    await s.card("TST-MQ005", `status: todo\nlinks: ["${PR_URL(15)}"]\ndepends_on: ["[[TST-MQ006-tst-mq006]]"]\n`);
    await s.card("TST-MQ006", `status: todo\nlinks: ["${PR_URL(16)}"]\ndelivery: {qa: pending}\n`, TICKED);
    await s.pass();
    const needs = readOverview(s.dashboard, {}).needs_you;
    const lists = needs.filter((n) => n.kind === "merge");
    assert.equal(lists.length, 1, "one list");
    const list = lists[0]!;
    assert.deepEqual(list.cards?.map((c) => [c.order, c.task, c.ready]), [
      [1, "TST-MQ003", true],
      [2, "TST-MQ001", false],
      [3, "TST-MQ005", true],
      [4, "TST-MQ002", false],
    ]);
    assert.deepEqual(list.cards?.map((c) => c.links.map((l) => l.url)), [[PR_URL(13)], [PR_URL(11)], [PR_URL(15)], [PR_URL(12)]]);
    const blockers = Object.fromEntries((list.cards ?? []).map((c) => [c.task, c.blockers]));
    assert.deepEqual(blockers["TST-MQ001"], ["merge #13 (TST-MQ003) first"], "its own PR is fine; it waits for the other one");
    assert.deepEqual(blockers["TST-MQ002"], ["checks fail: check 2", "mergeability: it conflicts with its base branch"], "each blocker apart");
    assert.deepEqual(blockers["TST-MQ005"], [], "merged code is all a merge waits for: MQ006's QA holds nothing back");
    assert.match(list.title, /4 PR\/MRs to merge/);
    assert.match(list.next, /^merge #13, #15 first, in this order/);
    // The draft is its author's, not the owner's; the merged card with QA open is a reconcile item, not in the list.
    assert.equal(list.cards?.some((c) => c.task === "TST-MQ004"), false);
    assert.equal(needs.some((n) => n.kind === "reconcile" && n.cards?.some((c) => c.task === "TST-MQ006")), true);
  } finally {
    s.stop();
  }
});
