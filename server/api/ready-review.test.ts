import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readyReview } from "./ready-review.ts";
import { setup } from "./testing.ts";
import { ForgeCli } from "../tracker/forge.ts";

/**
 * The review before a start (JOBBY-8DW17): cards looked ready while their work was merged already,
 * covered in part by another card, or waiting at the end of a long chain. Only a card's own facts
 * confirm anything; a title, a branch or a mention is a signal. The review changes nothing.
 */

interface Card {
  front?: string;
  /** Acceptance lines; `x ` in front ticks one. */
  lines?: string[];
  brief?: string;
  /** Text after the acceptance: a handoff, notes. */
  more?: string;
  project?: string;
  status?: string;
}

function write(root: string, id: string, title: string, card: Card = {}): void {
  const lines = (card.lines ?? ["it works"]).map((line) => (line.startsWith("x ") ? `- [x] ${line.slice(2)}` : `- [ ] ${line}`)).join("\n");
  writeFileSync(
    join(root, "tasks", `${id}-x.md`),
    `---\nid: ${id}\ntype: task\ntitle: "${title}"\nstatus: ${card.status ?? "todo"}\nproject: ${card.project ?? "core"}\ncreated: 2026-11-20T10:00:00Z\n${card.front ?? ""}---\n\n## Brief\n\n${card.brief ?? "Do it."}\n\n## Acceptance\n\n${lines}\n${card.more ?? ""}`,
  );
}

const pr = (number: number, title: string, extra: { head?: string; body?: string } = {}) => ({
  number,
  url: `https://github.com/acme/core/pull/${number}`,
  state: "MERGED",
  mergedAt: "2026-11-23T10:00:00Z",
  headRefName: extra.head ?? `work-${number}`,
  isCrossRepository: false,
  title,
  body: extra.body ?? "",
  mergeCommit: { oid: `${number}abcdef0123456` },
});

/** A plan with the given cards and merged PRs of the core repository; `answers` off: the forge fails. */
async function plan(cards: (root: string) => void, merged: ReturnType<typeof pr>[] = [], forge = { answers: true }) {
  const s = await setup(undefined, {
    forge: new ForgeCli(async (command, args) => {
      if (!forge.answers) return { code: 1, stdout: "", stderr: "no network" };
      if (command === "gh" && args[1] === "view") {
        const one = merged.find((item) => item.url === args[2]);
        return one ? { code: 0, stdout: JSON.stringify(one) } : { code: 1, stdout: "" };
      }
      if (command !== "gh" || args[1] !== "list") return { code: 0, stdout: "[]" };
      const head = args.indexOf("--head");
      const found = head >= 0 ? merged.filter((item) => item.headRefName === args[head + 1]) : args.includes("merged") ? merged : [];
      return { code: 0, stdout: JSON.stringify(found) };
    }),
  });
  s.f.external("ergo", cards);
  await s.sync().sync();
  await s.dashboard.merged.checkAll();
  const review = (input: Partial<Parameters<typeof readyReview>[1]> = {}) => readyReview(s.ctx, { limit: 50, ...input });
  const card = async (id: string) => {
    const read = await review();
    assert.equal(read.error, "");
    const found = read.tasks.find((t) => t.id === id);
    assert.ok(found, `${id} is reviewed`);
    return found;
  };
  return { ...s, review, card };
}

test("merged code with open QA is partial with QA left; every line ticked is confirmed; nothing changes or starts", async () => {
  const s = await plan(
    (root) => {
      write(root, "TST-QA001", "Quota overage screen", { lines: ["the overage shows on stage", "x the types carry both fields"] });
      write(root, "TST-AC001", "Receipt export archive", { lines: ["x the archive downloads"] });
      write(root, "TST-FA001", "Webhook retry schedule", { lines: ["retries back off"], front: "delivery: { qa: failed, qa_note: the third retry never runs }\n" });
    },
    [pr(1, "feat: quota overage (TST-QA001)"), pr(2, "feat: archive", { head: "task/tst-ac001-archive" }), pr(3, "feat: retries TST-FA001")],
  );
  try {
    const journal = s.sync().journalEntries.length;
    const plan = JSON.stringify([...s.sync().plan.entities]);

    const qa = await s.card("TST-QA001");
    assert.deepEqual([qa.coverage, qa.basis, qa.left, qa.group], ["partial", "own", "qa", "merged"]);
    assert.deepEqual(qa.acceptance, { done: 1, total: 2 });
    assert.deepEqual(qa.open, ["the overage shows on stage"]);
    assert.deepEqual(qa.prs.map((p) => [p.pr, p.state]), [["#1", "merged"]]);
    assert.match(qa.prs[0]!.tie, /its title names the card/);
    assert.match(qa.next, /1 of 2 acceptance lines are open.*never to redo the merged work/);
    assert.deepEqual(qa.incomplete, []);
    assert.ok(qa.read_at);

    const accepted = await s.card("TST-AC001");
    assert.deepEqual([accepted.coverage, accepted.left], ["confirmed", "accept"]);
    assert.match(accepted.next, /every acceptance line is ticked: mark it done/);

    const failed = await s.card("TST-FA001");
    assert.deepEqual([failed.coverage, failed.left], ["partial", "fix"]);
    assert.match(failed.next, /QA failed: the third retry never runs/);

    const read = await s.review();
    assert.deepEqual(read.tasks.slice(0, 2).map((t) => t.coverage), ["confirmed", "partial"], "covered cards come first");
    assert.match(read.note, /Read only: nothing changed or started/);
    assert.equal(s.sync().journalEntries.length, journal, "a review writes nothing");
    assert.equal(JSON.stringify([...s.sync().plan.entities]), plan, "no status moves, no card closes");
    assert.equal(s.dashboard.runs?.runs.size ?? 0, 0, "a review starts nothing");
  } finally {
    s.stop();
  }
});

test("criteria that partly match another card's ticked ones are a possible match by text only, never coverage", async () => {
  const s = await plan(
    (root) => {
      write(root, "TST-ST0R1", "Attachment storage", {
        status: "done",
        front: "run_pr: https://github.com/acme/core/pull/61\n",
        lines: ["x deleting an attachment removes its stored file and ledger row", "x the instance limit refuses an upload"],
      });
      write(root, "TST-ST0R2", "Attachment storage and listing API", {
        lines: ["deleting an attachment removes its stored file and ledger row", "the web app gets an agreed listing endpoint"],
      });
    },
    [pr(61, "feat(attachments): keep files (TST-ST0R1)")],
  );
  try {
    const card = await s.card("TST-ST0R2");
    assert.deepEqual([card.coverage, card.basis, card.left], ["possible", "similar", "compare"]);
    assert.deepEqual(card.acceptance, { done: 0, total: 2 }, "another card's ticks are not this card's");
    assert.deepEqual(card.prs, [], "another card's PR is not this card's");
    const related = card.related[0]!;
    assert.deepEqual([related.id, related.status, related.matched], ["TST-ST0R1", "done", 1]);
    assert.ok(related.signals.includes("similar title"));
    assert.deepEqual(related.prs, [{ pr: "#61", url: "https://github.com/acme/core/pull/61", state: "merged" }]);
    assert.equal(related.matches[0]!.theirs, "deleting an attachment removes its stored file and ledger row");
    assert.ok(card.evidence.some((line) => /1 of 2 open lines.*not proof/.test(line)));
    assert.match(card.next, /compare the matching lines with TST-ST0R1/);

    // Every open line alike: the same, a possible duplicate.
    s.f.external("ergo", (root) => write(root, "TST-ST0R3", "Attachment storage rework", { lines: ["the instance limit refuses an upload"] }));
    await s.sync().sync();
    const whole = await s.card("TST-ST0R3");
    assert.deepEqual([whole.coverage, whole.basis], ["possible", "similar"]);
  } finally {
    s.stop();
  }
});

test("a false duplicate: an alike title, a shared branch or a mention proves nothing", async () => {
  const s = await plan(
    (root) => {
      write(root, "TST-DB001", "Invoice export button", { status: "done", lines: ["x the button downloads a spreadsheet"] });
      write(root, "TST-DB002", "Invoice export button audit", { lines: ["screen readers announce the control"] });
      // The same title in another repository relates nothing.
      write(root, "TST-DB003", "Invoice export button", { project: "site", lines: ["the button downloads a spreadsheet"] });
      // A branch two cards share: its merged PR is nobody's by that alone.
      write(root, "TST-BR001", "Payment provider webhooks", { status: "done", front: "branch: feat/billing\nrun_pr: https://github.com/acme/core/pull/7\n" });
      write(root, "TST-BR002", "Refund ledger columns", { front: "branch: feat/billing\n" });
      // A PR that only mentions a card in its description.
      write(root, "TST-MN001", "Dark theme tokens");
    },
    [pr(7, "feat: provider webhooks (TST-BR001)", { head: "feat/billing" }), pr(8, "chore: colors", { body: "Follow-up for TST-MN001" })],
  );
  try {
    const alike = await s.card("TST-DB002");
    assert.deepEqual([alike.coverage, alike.basis, alike.left], ["possible", "", "compare"]);
    assert.deepEqual(alike.related.map((r) => [r.id, r.matched]), [["TST-DB001", 0]]);
    assert.deepEqual(alike.acceptance, { done: 0, total: 1 });
    assert.match(alike.next, /compare with TST-DB001 \(similar title\)/);

    const elsewhere = await s.card("TST-DB003");
    assert.deepEqual([elsewhere.coverage, elsewhere.related], ["none", []]);
    assert.ok(elsewhere.incomplete.some((line) => /project site is not mapped on this Mac/.test(line)), "nothing found, and said why that may be wrong");

    const branch = await s.card("TST-BR002");
    assert.equal(branch.coverage, "possible");
    assert.match(branch.prs[0]!.tie, /it is the PR\/MR of TST-BR001; it names TST-BR001; its branch is shared with TST-BR001; a signal, not proof/);
    assert.match(branch.next, /check #7 \(merged\) before starting: nothing proves it is this card's work/);
    assert.ok(branch.related[0]!.signals.includes("shares branch feat/billing"));

    const mention = await s.card("TST-MN001");
    assert.equal(mention.coverage, "possible");
    assert.match(mention.prs[0]!.tie, /description mentions the card; a signal, not proof/);
  } finally {
    s.stop();
  }
});

test("a dependency chain names its root, how many cards it holds, and each card says where to begin", async () => {
  const s = await plan((root) => {
    const after = (id: string) => `depends_on: [${id}]\n`;
    write(root, "TST-CN001", "Rollout step one", { status: "in_progress", front: "run_id: r-five\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: rollout-one\n", more: "\n## Handoff\n\n*Run r-five · 2026-11-23T10:00:00Z*\n\nBackend done.\n" });
    write(root, "TST-CN002", "Rollout step two", { front: after("TST-CN001") });
    write(root, "TST-CN003", "Rollout step three", { front: after("TST-CN002") });
    write(root, "TST-CN004", "Rollout step four", { front: after("TST-CN003") });
    write(root, "TST-CN005", "Rollout step five on the site", { front: after("TST-CN002"), project: "site" });
    write(root, "TST-CY001", "Loop one", { front: after("TST-CY002") });
    write(root, "TST-CY002", "Loop two", { front: after("TST-CY001") });
    write(root, "TST-WA001", "Waits for nothing known", { front: after("TST-NNE00") });
  });
  try {
    const journal = s.sync().journalEntries.length;
    const read = await s.review();
    const root = read.roots[0]!;
    assert.deepEqual([root.id, root.status, root.blocks, root.direct], ["TST-CN001", "in_progress", 4, 1]);
    assert.equal(root.blocked[0], "TST-CN002", "the nearest first");
    assert.match(root.next, /under way.*follow it/);
    assert.match(read.note, /TST-CN001 holds 4 cards/);
    assert.match(read.note, /2 wait on a dependency cycle/);
    const missing = read.roots.find((r) => r.id === "TST-NNE00")!;
    assert.deepEqual([missing.status, missing.blocks], ["missing", 1]);

    const third = read.tasks.find((t) => t.id === "TST-CN004")!;
    assert.deepEqual([third.group, third.waits_for, third.roots], ["dependencies", ["TST-CN003"], ["TST-CN001"]]);
    assert.match(third.next, /begin with TST-CN001/);
    assert.equal(third.coverage, "none", "steps of one chain are not duplicates of each other");
    const orphan = read.tasks.find((t) => t.id === "TST-WA001")!;
    assert.ok(orphan.incomplete.includes("dependency TST-NNE00 is not found"));

    // One project: only its cards are counted; the root may lie anywhere.
    const site = await s.review({ project: "SITE" });
    assert.ok(site.tasks.every((t) => t.project === "site"));
    assert.deepEqual([site.roots[0]!.id, site.roots[0]!.blocks, site.roots[0]!.blocked], ["TST-CN001", 1, ["TST-CN005"]]);
    assert.match((await s.review({ project: "nope" })).error, /No project «nope» here; projects: core, site/);

    // The running card by itself: its own run's handoff is not earlier work.
    const running = await s.review({ task: "TST-CN001" });
    assert.deepEqual([running.tasks[0]!.coverage, running.tasks[0]!.group, running.roots[0]!.blocks], ["none", "", 4]);
    assert.equal(s.sync().journalEntries.length, journal);
  } finally {
    s.stop();
  }
});

test("incomplete data is said: a silent forge, no criteria, an earlier run's PR of unknown state; one card asks the forge now", async () => {
  const forge = { answers: false };
  const merged = [pr(11, "feat: TST-NW001 search index")];
  const s = await plan(
    (root) => {
      write(root, "TST-NW001", "Search index rebuild", { lines: [] });
      write(root, "TST-RE001", "Calendar sync cursor", {
        front: "run_id: r-old\nrun_ended: 2026-11-22T10:00:00Z\nrun_pr: https://github.com/acme/core/pull/44\n",
        more: "\n## Handoff\n\n*Run r-old · 2026-11-22T10:00:00Z*\n\nHalf done.\n",
      });
    },
    merged,
    forge,
  );
  try {
    const silent = await s.card("TST-NW001");
    assert.deepEqual([silent.coverage, silent.read_at], ["none", ""]);
    assert.ok(silent.incomplete.some((line) => /latest merged PR\/MRs of core are not read/.test(line)));
    assert.ok(silent.incomplete.some((line) => /no acceptance criteria/.test(line)));

    const released = await s.card("TST-RE001");
    assert.deepEqual([released.coverage, released.left], ["possible", "check"]);
    assert.ok(released.incomplete.includes("the state of #44 is not read here"));
    assert.ok(released.incomplete.some((line) => /it ran before/.test(line)));
    assert.ok(released.evidence.some((line) => /an earlier run left a handoff \(run r-old\)/.test(line)));

    const stillSilent = await s.review({ task: "TST-NW001" });
    assert.match(stillSilent.tasks[0]!.incomplete[0]!, /the forge did not answer now/);

    forge.answers = true;
    const now = await s.review({ task: "TST-NW001" });
    assert.deepEqual([now.tasks[0]!.coverage, now.tasks[0]!.left, now.total], ["partial", "check", 1]);
    assert.equal(now.tasks[0]!.prs[0]!.pr, "#11");
    assert.match((await s.review({ task: "TST-NOPE9" })).error, /./);
  } finally {
    s.stop();
  }
});

test("another card's PR/MR is not this card's own by a link, a branch or a title it shares", async () => {
  const s = await plan(
    (root) => {
      write(root, "TST-AA001", "Alpha groundwork", { status: "done", front: "run_pr: https://github.com/acme/core/pull/6\n" });
      write(root, "TST-AA002", "Cites the earlier change", { front: "links: [https://github.com/acme/core/pull/5]\n", lines: ["x ticked"] });
      write(root, "TST-AA003", "Reuses an old branch", { front: "branch: feat/billing\n", lines: ["x ticked"] });
      write(root, "TST-AA004", "Follows the groundwork", { lines: ["x ticked"] });
      // A canceled duplicate keeps the branch in dispute.
      write(root, "TST-AA005", "Abandoned twin", { status: "canceled", front: "branch: feat/ledger\n" });
      write(root, "TST-AA006", "Ledger columns", { front: "branch: feat/ledger\n", lines: ["x ticked"] });
      // Two cards that link one PR nobody names: neither owns it by that.
      write(root, "TST-AA007", "First citing card", { front: "links: [https://github.com/acme/core/pull/9]\n", lines: ["x ticked"] });
      write(root, "TST-AA008", "Second citing card", { front: "links: [https://github.com/acme/core/pull/9]\n", lines: ["x ticked"] });
      // One PR that names two cards, none of them run: both own it.
      write(root, "TST-AA009", "Paired change one", { lines: ["x ticked"] });
      write(root, "TST-AA010", "Paired change two", { lines: ["x ticked"] });
    },
    [
      pr(5, "feat: alpha (TST-AA001)", { head: "feat/billing" }),
      pr(6, "feat: groundwork TST-AA001, for TST-AA004"),
      pr(8, "feat: ledger", { head: "feat/ledger" }),
      pr(9, "chore: cleanup"),
      pr(10, "feat: pair (TST-AA009, TST-AA010)"),
    ],
  );
  try {
    // The links are read one by one (gh pr view), which this forge stub answers from the same list.
    for (const id of ["TST-AA002", "TST-AA007", "TST-AA008"]) await s.review({ task: id });
    for (const id of ["TST-AA002", "TST-AA003", "TST-AA004", "TST-AA006", "TST-AA007", "TST-AA008"]) {
      const card = await s.card(id);
      assert.notEqual(card.coverage, "confirmed", `${id} is not confirmed by another card's work`);
      assert.ok(card.prs.length, `${id} still shows the PR/MR as a signal`);
      for (const found of card.prs) assert.match(found.tie, /a signal, not proof/, `${id} ${found.pr}`);
      assert.doesNotMatch(card.next, /Do not start it again|never to redo/, id);
    }
    assert.match((await s.card("TST-AA002")).prs[0]!.tie, /it names TST-AA001/);
    assert.match((await s.card("TST-AA004")).prs[0]!.tie, /it is the PR\/MR of TST-AA001/);
    assert.match((await s.card("TST-AA006")).prs[0]!.tie, /its branch is shared with TST-AA005/);
    assert.match((await s.card("TST-AA007")).prs[0]!.tie, /TST-AA008 links it too/);
    for (const id of ["TST-AA009", "TST-AA010"]) assert.equal((await s.card(id)).coverage, "confirmed", id);
  } finally {
    s.stop();
  }
});

test("a failed QA is never confirmed or accepted; work in review or under a run keeps its own next step", async () => {
  const s = await plan(
    (root) => {
      const failed = "delivery: { qa: failed, qa_note: the export is empty }\n";
      write(root, "TST-QF001", "Merged export", { lines: ["x it exports"], front: failed });
      write(root, "TST-QF002", "Unmerged import", { lines: ["x it imports"], front: failed });
      write(root, "TST-RV001", "Reviewed report", { status: "review", lines: ["x it prints"], front: "run_id: r-rv\nrun_host: anna-mbp\nrun_pr: https://github.com/acme/core/pull/22\n" });
      write(root, "TST-RN001", "Running digest", { status: "in_progress", lines: ["it sends"], front: "run_id: r-rn\nrun_host: anna-mbp\nrun_pr: https://github.com/acme/core/pull/23\n" });
    },
    [pr(21, "feat: TST-QF001 export"), pr(22, "feat: report"), pr(23, "feat: digest")],
  );
  try {
    for (const id of ["TST-QF001", "TST-QF002"]) {
      const card = await s.card(id);
      assert.deepEqual([card.coverage, card.left], ["partial", "fix"], id);
      assert.match(card.next, /QA failed: the export is empty/);
      assert.doesNotMatch(card.next, /mark it done/);
    }
    assert.equal((await s.review()).counts.confirmed, 0);
    const reviewed = (await s.review({ task: "TST-RV001" })).tasks[0]!;
    assert.match(reviewed.next, /accept_task.*send_back/);
    const running = (await s.review({ task: "TST-RN001" })).tasks[0]!;
    assert.match(running.next, /a run holds it: follow it/);
    assert.match(running.prs[0]!.tie, /its run reported it/);
  } finally {
    s.stop();
  }
});

test("a cycle behind a root is freed by no root, and one card's note speaks of that card only", async () => {
  const s = await plan((root) => {
    const after = (...ids: string[]) => `depends_on: [${ids.join(", ")}]\n`;
    write(root, "TST-RT001", "Real prerequisite");
    write(root, "TST-RT002", "Real follower", { front: after("TST-RT001") });
    write(root, "TST-CY001", "Loop one", { front: after("TST-CY002", "TST-RT001") });
    write(root, "TST-CY002", "Loop two", { front: after("TST-CY001") });
    write(root, "TST-AM001", "Standalone chore");
  });
  try {
    const read = await s.review();
    const root = read.roots.find((r) => r.id === "TST-RT001")!;
    assert.deepEqual([root.blocks, root.blocked], [1, ["TST-RT002"]]);
    assert.match(read.note, /2 wait on a dependency cycle/);
    const looped = read.tasks.find((t) => t.id === "TST-CY001")!;
    assert.deepEqual(looped.roots, []);
    assert.match(looped.next, /dependency cycle.*fix depends_on/);
    const alone = await s.review({ task: "TST-AM001" });
    assert.match(alone.note, /This card waits for no other and holds none/);
    assert.deepEqual(alone.roots, []);
    assert.match((await s.review({ task: "TST-RT001" })).note, /This card holds 1 card back/);
    assert.match((await s.review({ task: "TST-RT002" })).note, /begin with TST-RT001/);
    assert.match((await s.review({ task: "TST-CY002" })).note, /waits on a dependency cycle/);
  } finally {
    s.stop();
  }
});

test("a list cut short of a card's age and an old reading are said; boilerplate lines relate nothing", async () => {
  const recent = Array.from({ length: 50 }, (_, i) => pr(100 + i, `chore: change ${i}`));
  const dod = ["x typecheck and unit tests pass on the branch", "x documentation and changelog describe the change"];
  const s = await plan((root) => {
    for (const [i, title] of ["Avatar cropping", "Billing address", "Cookie banner", "Digest schedule"].entries()) {
      write(root, `TST-DD00${i + 1}`, title, { status: "done", lines: dod });
    }
    write(root, "TST-NW002", "Fresh locale switcher", { lines: dod.map((line) => line.slice(2)) });
  }, recent);
  try {
    const card = await s.card("TST-NW002");
    assert.deepEqual([card.coverage, card.related], ["none", []]);
    assert.ok(card.incomplete.some((line) => /only the latest merges of core are compared, back to 2026-11-23/.test(line)), card.incomplete.join("; "));
    // Asking the forge for this card reaches past the latest merges.
    const one = (await s.review({ task: "TST-NW002" })).tasks[0]!;
    assert.ok(!one.incomplete.some((line) => /only the latest merges/.test(line)), one.incomplete.join("; "));
    const later = await readyReview({ ...s.ctx, now: () => new Date(Date.now() + 3 * 3_600_000) }, { limit: 50 });
    assert.ok(later.tasks.find((t) => t.id === "TST-NW002")!.incomplete.some((line) => /old reading/.test(line)));
    assert.match(later.summary.find((line) => line.startsWith("TST-NW002"))!, /none, left implementation, data incomplete/);
  } finally {
    s.stop();
  }
});

test("a branch naming another card outweighs a title mention; one PR written two ways is one", async () => {
  const s = await plan(
    (root) => {
      write(root, "TST-EE001", "Storage layer", { status: "done" });
      write(root, "TST-EE002", "Search facets", { lines: ["x ticked"] });
      write(root, "TST-EE003", "Owner of the linked change", { status: "done", front: "links: ['https://github.com/acme/core/pull/32/files']\n" });
      write(root, "TST-EE004", "Only cites that change", { front: "links: [https://github.com/acme/core/pull/32]\n", lines: ["x ticked"] });
      write(root, "TST-EE005", "Hand-made branch owner", { status: "done", front: "branch: feat/ledger\n" });
      write(root, "TST-EE006", "Cites the ledger change", { front: "links: [https://github.com/acme/core/pull/33]\n", lines: ["x ticked"] });
      write(root, "TST-EE007", "Reviewed but failed", { status: "review", front: "delivery: { qa: failed }\n" });
    },
    [
      pr(31, "feat: storage layer, unblocks TST-EE002", { head: "task/tst-ee001-storage-layer" }),
      pr(32, "chore: tidy"),
      pr(33, "feat: ledger", { head: "feat/ledger" }),
    ],
  );
  try {
    for (const id of ["TST-EE004", "TST-EE006"]) await s.review({ task: id });
    for (const id of ["TST-EE002", "TST-EE004", "TST-EE006"]) {
      const card = await s.card(id);
      assert.equal(card.coverage, "partial", `${id}: only its own tick covers it`);
      assert.match(card.prs[0]!.tie, /a signal, not proof/, id);
    }
    assert.match((await s.card("TST-EE004")).prs[0]!.tie, /TST-EE003 links it too/);
    assert.match((await s.card("TST-EE006")).prs[0]!.tie, /its branch is shared with TST-EE005/);
    const failed = (await s.review({ task: "TST-EE007" })).tasks[0]!;
    assert.match(failed.next, /^QA failed: the user sends the work back.*do not accept it$/);
  } finally {
    s.stop();
  }
});
