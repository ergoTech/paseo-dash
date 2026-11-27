import { test } from "node:test";
import assert from "node:assert/strict";
import { qaCardsSchema } from "../shared/model.ts";
import { deliveryInput } from "../shared/api.ts";
import { getTaskWithRuns } from "./api/reads.ts";
import { setup } from "./api/testing.ts";
import { updateTask } from "./api/writes.ts";
import { taskDelivery } from "./delivery.ts";
import { readOverview } from "./overview.ts";
import { mergeReadings, pendingRuns, qaRuns, type QaReading } from "./qa-cards.ts";
import { revisionOf } from "./delegation/rules.ts";
import { planHolds } from "./reconcile/plan-gate.ts";
import { PR_URL, reconcileSetup } from "./reconcile/testing.ts";

/**
 * QA cards after archiving (JOBBY-8HV1M). Trello cards were archived as duplicates while their tasks
 * stayed open, or were done, and nothing in Paseo Dash said which card carries the QA now. The cards
 * here are made up; their shapes are the ones met: a duplicate whose replacement only a person knew,
 * and one whose comment names its replacement.
 */

const card = (n: number) => `https://trello.com/c/Card0${n}`;
const T1 = "2026-10-20T09:00:00.000Z";
const T2 = "2026-10-22T09:00:00.000Z";
const T3 = "2026-10-23T09:00:00.000Z";
const T4 = "2026-10-24T09:00:00.000Z";

const read = (n: number, checked: string, extra: Partial<QaReading> = {}): QaReading => ({ url: card(n), checked, state: "open", name: `#${n} · QA`, list: "Ready to test", ...extra });

type Setup = Awaited<ReturnType<typeof setup>>;
const record = (s: Setup, task: string, cards: QaReading[]) => updateTask(s.ctx, { task, delivery: { trello_cards: cards } });
const cardsOf = (s: Setup, task: string) => s.task(task)!.qa_cards ?? [];
const needs = (s: Setup) => readOverview(s.dashboard, { limit: 50 }).needs_you.filter((n) => n.kind === "qa");

test("a duplicate archived with no known replacement asks for one; it closes, passes and starts nothing", async () => {
  const s = await setup();
  try {
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } })).ok, true);
    const before = s.task("TST-FX001")!;
    const written = await record(s, "TST-FX001", [read(101, T1, { state: "archived" })]);
    assert.deepEqual([written.ok, written.changed], [true, ["trello_cards"]], written.error);

    const after = s.task("TST-FX001")!;
    assert.deepEqual([after.status, after.delivery?.qa, after.run_id], [before.status, undefined, undefined]);
    assert.deepEqual([s.fake.agents.size, s.fake.workspaces.size], [0, 0], "no agent or workspace is started");
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    const step = view.steps.find((x) => x.step === "Trello #101 (Card0101)")!;
    assert.equal(step.state, "archived, needs clarification");
    assert.match(step.fact, /archived when read 2026-10-20 09:00Z/);
    assert.match(step.fact, /next: the owner says what replaced it/);
    assert.doesNotMatch(view.next, /Card0101\)/, "an archived card is not offered to QA");
    const [need] = needs(s);
    assert.deepEqual([need!.task, need!.cards![0]!.links[0]!.url], ["TST-FX001", card(101)]);
    assert.match(need!.why, /#101 archived, no known replacement/);
    assert.match(need!.next, /replaced it, with evidence, or where its run is proven/);
  } finally {
    s.stop();
  }
});

test("a stated replacement becomes the current QA card, with its time, tester and the link history", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } });
    await record(s, "TST-FX001", [read(101, T1, { state: "archived" })]);
    const written = await record(s, "TST-FX001", [
      read(101, T2, { state: "archived", replaced_by: [card(102)], evidence: "the owner: archived as a duplicate, the retest moved" }),
      read(102, T2, { tester: "Anna" }),
    ]);
    assert.equal(written.ok, true, written.error);
    assert.deepEqual(cardsOf(s, "TST-FX001").map((c) => [c.url, c.state, c.replaced_by]), [
      [card(101), "archived", [card(102)]],
      [card(102), "open", undefined],
    ]);
    assert.deepEqual(needs(s), [], "nothing to clarify, and the open task is on the board");

    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.deepEqual(view.qa_cards, [
      { url: card(101), label: "#101", status: "replaced", checked: T2 },
      { url: card(102), label: "#102", status: "open", checked: T2 },
    ]);
    const old = view.steps.find((x) => x.step.startsWith("Trello #101"))!;
    assert.match(old.fact, /replaced by #102 \(the owner: archived as a duplicate, the retest moved\)/);
    const current = view.steps.find((x) => x.step.startsWith("Trello #102"))!;
    assert.equal(current.state, "open, current QA");
    assert.match(current.fact, /open when read 2026-10-22 09:00Z, list «Ready to test»; next: Anna/);
    assert.ok(!view.steps.some((x) => x.step === "Trello"), "the linked card is told once");
    assert.match(view.trello_blocker, /no Trello access.*read-only Trello API key and token/);

    // A later reading that says nothing of the replacement keeps it.
    await record(s, "TST-FX001", [read(101, T3, { state: "archived" })]);
    assert.deepEqual([cardsOf(s, "TST-FX001")[0]!.replaced_by, cardsOf(s, "TST-FX001")[0]!.checked], [[card(102)], T3]);
    const file = await s.remoteFile(/TST-FX001/);
    assert.match(file!, /qa_cards:.*Card0101.*Card0102/);
  } finally {
    s.stop();
  }
});

test("a done task keeps its open acceptance run in view: the delivery read, the task read and Needs you", async () => {
  const s = await setup();
  try {
    assert.equal((await updateTask(s.ctx, { task: "TST-FX001", status: "done", delivery: { trello: card(104) } })).ok, true);
    assert.equal(s.task("TST-FX001")!.status, "done");
    // The replacement is named in the old card's comment and not read yet.
    await record(s, "TST-FX001", [read(104, T1, { state: "archived", replaced_by: [card(105)], evidence: "comment on #104: merged into #105" })]);
    let view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([view.stage, view.next_by], ["ready_for_qa", "owner"]);
    assert.match(view.next, /the task is done, its QA is not settled: Trello Card0105 not read yet/);
    assert.deepEqual(view.qa_cards?.map((c) => c.status), ["replaced", "unread"]);

    await record(s, "TST-FX001", [read(105, T2)]);
    view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([view.stage, view.next_by], ["ready_for_qa", "QA"]);
    assert.match(view.next, /acceptance run is open on Trello #105 \(nobody named, read 2026-10-22 09:00Z\)/);
    assert.match((await getTaskWithRuns(s.ctx, { task: "TST-FX001" })).delivery ?? "", /^ready_for_qa; next QA/);
    const [need] = needs(s);
    assert.match(need!.why, /^done, QA not settled: Trello #105 open when read/);
    assert.equal(need!.cards![0]!.links[0]!.url, card(105));
    assert.equal(s.task("TST-FX001")!.status, "done");
    assert.deepEqual([s.fake.agents.size, s.fake.workspaces.size], [0, 0]);

    // The proof of its run settles it; no QA result was set by any reading.
    await record(s, "TST-FX001", [read(105, T3, { proof: "report comment on #105, all steps passed" })]);
    view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.equal(view.stage, "accepted");
    assert.equal(s.task("TST-FX001")!.delivery?.qa, undefined);
    assert.deepEqual(needs(s), []);
    assert.match(view.steps.find((x) => x.step.startsWith("Trello #105"))!.fact, /proof: report comment on #105/);
  } finally {
    s.stop();
  }
});

test("an older reading and a read that failed never replace fresher facts", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } });
    await record(s, "TST-FX001", [read(101, T2, { tester: "Anna" })]);

    const stale = await updateTask(s.ctx, { task: "TST-FX001", delivery: { qa: "failed", trello_cards: [read(101, T1, { state: "archived" })] } });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /newer reading.*of 2026-10-22T09:00:00.000Z.*older.*Nothing was changed/);
    assert.equal(s.task("TST-FX001")!.delivery?.qa, undefined, "the whole request is refused");

    const lost = await record(s, "TST-FX001", [{ url: card(101), checked: T3, unreadable: "access revoked" }]);
    assert.equal(lost.ok, true, lost.error);
    const [kept] = cardsOf(s, "TST-FX001");
    assert.deepEqual([kept!.state, kept!.checked, kept!.tester, kept!.failed_at, kept!.failure], ["open", T2, "Anna", T3, "access revoked"]);
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.match(view.steps.find((x) => x.step.startsWith("Trello #101"))!.fact, /open when read 2026-10-22 09:00Z.*last read failed 2026-10-23 09:00Z: access revoked/);

    // The same reading journaled earlier and applied late, as another machine's replay would: dropped.
    const late = await s.sync().record([{ op_id: "op-late", kind: "qa_cards", id: "TST-FX001", readings: [read(101, T1, { state: "archived" })] }]).outcomes;
    assert.equal(late.get("op-late")?.status, "dropped");
    assert.equal(cardsOf(s, "TST-FX001")[0]!.state, "open");

    await record(s, "TST-FX001", [read(101, T4)]);
    const [fresh] = cardsOf(s, "TST-FX001");
    assert.deepEqual([fresh!.checked, fresh!.failed_at, fresh!.failure, fresh!.tester], [T4, undefined, undefined, "Anna"]);
  } finally {
    s.stop();
  }
});

test("only cards tied to the task are taken, with a real time and evidence for a replacement", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } });
    const refused = async (cards: QaReading[], why: RegExp) => {
      const answer = await record(s, "TST-FX001", cards);
      assert.equal(answer.ok, false);
      assert.match(answer.error, why);
      assert.deepEqual(cardsOf(s, "TST-FX001"), []);
    };
    await refused([read(999, T1)], /Card0999 is not tied to this task/);
    await refused([read(101, T1), read(999, T1)], /Card0999 is not tied/);
    await refused([read(101, "2026-11-30T09:00:00Z")], /is in the future/);
    await refused([read(101, T1, { state: "archived", replaced_by: [card(102)] })], /needs evidence/);
    await refused([read(101, T1, { replaced_by: [card(101)], evidence: "x" })], /cannot replace itself/);
    await refused([read(101, T1, { unreadable: "no access" })], /either its state/);
    await refused([{ url: card(101), checked: T1, unreadable: "no access", proof: "x" }], /go with a state that was read/);
    await refused([read(101, T1), read(101, T2)], /given twice/);
    // A card the same request links is tied; so is the replacement it states.
    const answer = await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(103), trello_cards: [read(104, T1), read(103, T1, { replaced_by: [card(104)], evidence: "owner" })] } });
    assert.equal(answer.ok, true, answer.error);

    assert.equal(deliveryInput.safeParse({ trello_cards: [{ url: "https://example.com/c/x", checked: T1, state: "open" }] }).success, false);
    assert.equal(deliveryInput.safeParse({ trello_cards: [{ url: card(101), checked: "yesterday", state: "open" }] }).success, false);
    assert.equal(deliveryInput.safeParse({ trello_cards: [{ url: card(101), checked: "2026-10-20T12:00:00+03:00", state: "open" }] }).success, true);
  } finally {
    s.stop();
  }
});

test("the closing rule holds a card whose QA card is open or archived into nothing, whatever delivery says", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101), qa: "passed" } });
    const holds = () => {
      const loaded = s.sync().plan.entities.get("TST-FX001")!;
      return planHolds(s.sync().plan, s.task("TST-FX001")!, loaded).filter((h) => h.code === "qa" || h.code === "qa_card");
    };
    assert.deepEqual(holds(), [], "as before with no card read");
    await record(s, "TST-FX001", [read(101, T1, { state: "archived" })]);
    assert.match(holds()[0]!.text, /#101 \(archived, no known replacement\)/);
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.match(view.steps.find((x) => x.step === "QA")!.state, /passed/);
    await record(s, "TST-FX001", [read(101, T2, { state: "archived", proof: "the report on the card" })]);
    assert.deepEqual(holds(), []);
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { qa: "failed", qa_note: "no sound", trello_cards: [read(101, T3)] } });
    assert.match(holds()[0]!.text, /QA failed: no sound/, "a failed QA is said as such");
  } finally {
    s.stop();
  }
});

test("an accepted card with follow-ups: its run is proven, the follow-ups stay open", () => {
  const cards = mergeReadings([], [
    read(103, T1, { proof: "accepted: report on the card", replaced_by: [card(106), card(107)], evidence: "owner: the rest moved" }),
    read(106, T1),
  ]);
  assert.deepEqual(qaRuns(cards).map((r) => [r.card.url, r.status]), [
    [card(103), "proven"],
    [card(106), "open"],
    [card(107), "unread"],
  ]);
});

test("replacements that lead only to each other, or to an archived dead end, still need clarification", () => {
  const loop = mergeReadings([], [
    read(1, T1, { state: "archived", replaced_by: [card(2)], evidence: "a" }),
    read(2, T1, { state: "archived", replaced_by: [card(1)], evidence: "b" }),
  ]);
  assert.deepEqual(pendingRuns(loop).map((r) => r.status), ["unclear", "unclear"]);
  const end = mergeReadings([], [read(1, T1, { state: "archived", replaced_by: [card(2)], evidence: "a" }), read(2, T1, { state: "archived" })]);
  assert.deepEqual(qaRuns(end).map((r) => r.status), ["replaced", "unclear"]);
});

test("a replacement is corrected only with its own evidence, and [] takes it off", () => {
  const first = mergeReadings([], [read(1, T1, { state: "archived", replaced_by: [card(2)], evidence: "a comment" })]);
  assert.equal(mergeReadings(first, [read(1, T2, { state: "archived", replaced_by: [card(3)] })])[0]!.evidence, undefined);
  const off = mergeReadings(first, [read(1, T2, { state: "archived", replaced_by: [] })]);
  assert.deepEqual([off[0]!.replaced_by, off[0]!.evidence, pendingRuns(off)[0]!.status], [undefined, undefined, "unclear"]);
});

test("a proof does not hide the next run on the same card: moved back or reopened, it is open again", () => {
  const proven = mergeReadings([], [read(1, T1, { list: "Report in", proof: "the report" })]);
  assert.equal(qaRuns(mergeReadings(proven, [read(1, T2, { list: "Report in" })]))[0]!.status, "proven", "read again where it was");
  assert.equal(qaRuns(mergeReadings(proven, [read(1, T2, { list: "Ready to test" })]))[0]!.status, "open");
  assert.equal(qaRuns(mergeReadings(proven, [read(1, T2, { list: "Done", proof: "the report" })]))[0]!.status, "proven");
  const archived = mergeReadings(proven, [read(1, T2, { state: "archived", list: "Done" })]);
  assert.equal(qaRuns(archived)[0]!.status, "proven", "archiving a proven card keeps its proof");
  assert.equal(qaRuns(mergeReadings(archived, [read(1, T3, { list: "Done" })]))[0]!.status, "open", "reopened");
});

test("a note with line breaks is written to the plan and read back", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } });
    const answer = await record(s, "TST-FX001", [read(101, T1, { name: "#101 · two\nlines", proof: "line one\nline two: [x], {y} # z" })]);
    assert.equal(answer.ok, true, answer.error);
    await s.settle();
    assert.equal(cardsOf(s, "TST-FX001")[0]!.proof, "line one\nline two: [x], {y} # z");
  } finally {
    s.stop();
  }
});

test("merging readings in either order keeps the newest state", () => {
  const older = read(1, T1, { state: "archived" });
  const newer = read(1, T2);
  const a = mergeReadings(mergeReadings([], [older]), [newer]);
  const b = mergeReadings(mergeReadings([], [newer]), [older]);
  assert.deepEqual([a[0]!.state, a[0]!.checked], ["open", T2]);
  assert.deepEqual(b, a);
});

test("the plan's qa_cards read leniently: what names no card is skipped", () => {
  assert.equal(qaCardsSchema.parse("nonsense"), undefined);
  assert.equal(qaCardsSchema.parse([]), undefined);
  assert.deepEqual(qaCardsSchema.parse([null, { url: "https://example.com" }, { url: card(1), state: "gone", replaced_by: card(2) }, { url: card(1) }]), [
    { url: card(1), replaced_by: [card(2)] },
  ]);
});

test("a replacement settles only the run it was stated in: reopened and archived again, the card asks anew", () => {
  const replaced = mergeReadings([], [read(1, T1, { state: "archived", replaced_by: [card(2)], evidence: "a comment" }), read(2, T1, { proof: "report" })]);
  assert.deepEqual(pendingRuns(replaced), []);
  const reopened = mergeReadings(replaced, [read(1, T2)]);
  assert.deepEqual([reopened[0]!.replaced_by, reopened[0]!.evidence, reopened[0]!.was_replaced_by], [undefined, undefined, [card(2)]]);
  const again = mergeReadings(reopened, [read(1, T3, { state: "archived" })]);
  assert.deepEqual(qaRuns(again).map((r) => r.status), ["unclear", "proven"]);
  assert.deepEqual(qaCardsSchema.parse(again)![0]!.was_replaced_by, [card(2)], "the history is kept in the plan");
  // A former replacement nobody read stays to be read.
  const unread = mergeReadings(mergeReadings([], [read(1, T1, { state: "archived", replaced_by: [card(2)], evidence: "a" })]), [read(1, T2)]);
  assert.deepEqual(pendingRuns(unread).map((r) => r.status), ["open", "unread"]);
});

test("cards that all name each other are judged quickly, and none of them settles another", () => {
  const readings = Array.from({ length: 200 }, (_, n) => read(n + 100, T1, { state: "archived", replaced_by: [1, 2, 3, 4, 5].map((step) => card(((n + step) % 200) + 100)), evidence: "x" }));
  const started = Date.now();
  const runs = qaRuns(mergeReadings([], readings));
  assert.ok(Date.now() - started < 2000);
  assert.ok(runs.length === 200 && runs.every((run) => run.status === "unclear"));
});

test("a late older reading that states a replacement is refused as a conflict, never lost without a word", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello: card(101) } });
    // Another machine's plain reading is in the plan first; the earlier one, with the replacement, arrives after it.
    await record(s, "TST-FX001", [read(101, T3, { state: "archived" })]);
    const late = await s.sync().record([{ op_id: "op-late", kind: "qa_cards", id: "TST-FX001", readings: [read(101, T2, { state: "archived", replaced_by: [card(102)], evidence: "owner" })] }]).outcomes;
    const outcome = late.get("op-late")!;
    assert.equal(outcome.status, "refused");
    assert.match(outcome.status === "refused" ? outcome.reason : "", /Card0101.*replacement read 2026-10-22.*was not applied.*read the card again/);
    assert.equal(cardsOf(s, "TST-FX001")[0]!.replaced_by, undefined);
    assert.deepEqual(s.sync().state.conflicts, [], "a caller still waiting hears it itself");

    // Journaled with nobody waiting any more, as after a restart or a long offline spell: a conflict.
    const call = s.sync().record([{ op_id: "op-later", kind: "qa_cards", id: "TST-FX001", readings: [read(101, T2, { state: "archived", proof: "report" })] }]);
    call.forget();
    await call.outcomes;
    await s.settle();
    assert.deepEqual(s.sync().state.conflicts.map((c) => [c.op_id, c.kind]), [["op-later", "qa_cards"]]);
  } finally {
    s.stop();
  }
});

test("a note by hand newer than the reading is shown, whatever the offset, also for a card tied by a link", async () => {
  const s = await setup();
  try {
    await s.sync().record([{ op_id: "op-link", kind: "set", id: "TST-FX001", field: "links", value: [card(101)], expect: [] }]).outcomes;
    await updateTask(s.ctx, { task: "TST-FX001", delivery: { trello_state: "In QA" } });
    // 10:00 on the 26th is this test's now; the card was read at 05:00Z, written with an offset.
    await record(s, "TST-FX001", [read(101, "2026-10-26T08:00:00+03:00")]);
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.match(view.steps.find((x) => x.step.startsWith("Trello #101"))!.fact, /noted by hand .*: In QA/);
    assert.ok(!view.steps.some((x) => x.step === "Trello"));
  } finally {
    s.stop();
  }
});

test("a done task with a failed QA and an open card says both", async () => {
  const s = await setup();
  try {
    await updateTask(s.ctx, { task: "TST-FX001", status: "done", delivery: { trello: card(101), qa: "failed", qa_note: "no sound" } });
    await record(s, "TST-FX001", [read(101, T1)]);
    const view = await taskDelivery(s.ctx, { task: "TST-FX001" });
    assert.equal(view.stage, "qa_failed");
    assert.match(view.next, /QA failed: no sound; the acceptance run is open on Trello #101/);
  } finally {
    s.stop();
  }
});

test("a task without QA cards reads and hashes as before them", async () => {
  const s = await setup();
  try {
    const loaded = s.sync().plan.entities.get("TST-FX001")!;
    assert.equal(JSON.stringify(loaded.entity).includes("qa_cards"), false);
    const { qa_cards: _none, ...without } = loaded.entity as unknown as Record<string, unknown>;
    assert.equal(revisionOf(loaded), revisionOf({ ...loaded, entity: without as typeof loaded.entity }));
  } finally {
    s.stop();
  }
});

test("an app card's unsettled QA card is said as such, not as a QA that has not passed, and only once", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [{ n: 1, state: "MERGED", mergeSha: "a".repeat(40), checks: ["SUCCESS"] }];
    await s.card("TST-AP001", `status: todo\nlinks: ["${PR_URL(1)}"]\ndelivery: {variants: [phone], qa: passed, trello: "${card(101)}"}\n`, { acceptance: ["[x] Works"] });
    await updateTask(s.ctx, { task: "TST-AP001", delivery: { trello_cards: [read(101, T1, { state: "archived" })] } });
    await s.pass();
    await s.settle();
    const space = s.dashboard.spaces.get("TST")!;
    const held = s.dashboard.reconciler.verdict(space, s.taskOf("TST-AP001"))!.holds.filter((h) => h.code === "qa_card" || h.code === "qa");
    assert.deepEqual(held.map((h) => h.code), ["qa_card"]);
    assert.match(held[0]!.text, /QA card not settled: #101/);
    assert.equal(s.taskOf("TST-AP001").status, "todo");
    const mentions = readOverview(s.dashboard, { limit: 50 }).needs_you.filter((n) => n.cards?.some((c) => c.task === "TST-AP001"));
    assert.deepEqual(mentions.filter((n) => n.kind !== "merge").map((n) => n.kind), ["qa"]);
  } finally {
    s.stop();
  }
});

test("an app card's open QA card leaves the build step as it was: QA is still said to wait for the APK", async () => {
  const s = await reconcileSetup();
  try {
    s.github.prs = [{ n: 1, state: "MERGED", mergeSha: "a".repeat(40), checks: ["SUCCESS"] }];
    await s.card("TST-AP001", `status: todo\nlinks: ["${PR_URL(1)}"]\ndelivery: {variants: [phone], trello: "${card(101)}"}\n`, { acceptance: ["[x] Works"] });
    await updateTask(s.ctx, { task: "TST-AP001", delivery: { trello_cards: [read(101, T1)] } });
    await s.pass();
    await s.settle();
    const space = s.dashboard.spaces.get("TST")!;
    const holds = () => s.dashboard.reconciler.verdict(space, s.taskOf("TST-AP001"))!.holds.filter((h) => h.code === "qa_card" || h.code === "qa");
    assert.deepEqual(holds().map((h) => h.code), ["qa"]);
    assert.match(holds()[0]!.text, /APK/);
    // QA passed is recorded while the card is still open: then the card is what is left to settle.
    await updateTask(s.ctx, { task: "TST-AP001", delivery: { qa: "passed" } });
    await s.pass();
    await s.settle();
    assert.deepEqual(holds().map((h) => h.code), ["qa_card"]);
    assert.equal(s.taskOf("TST-AP001").status, "todo");
  } finally {
    s.stop();
  }
});
