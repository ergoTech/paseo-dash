import { sameLabel } from "../../shared/labels.ts";
import { hasLiveRun, type Task } from "../../shared/model.ts";
import { blockingTasks } from "../api/view.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import { openQuestion } from "../plan/questions.ts";
import { cardLabel, pendingRuns } from "../qa-cards.ts";
import { finishWith, type Hold, type Source } from "./types.ts";

/**
 * What the plan alone says against closing a card by rule: everything but the forge. Pure, and read
 * again whenever a close operation is applied (server/sync/ops.ts), so a label, a requirement, a
 * QA result or a dependency that reached the plan after the check stops the closing.
 */

/** Label names that read like a person's work in plans seen so far; the space may or may not mark them. */
export const PERSON_LIKE = ["manual", "needs-owner", "owner", "live-check", "human", "person", "decision", "needs-decision", "waiting"];

const card = (task: Task): Source => ({ label: `${task.id} (the card)`, url: "" });
const cut = (text: string, max = 160) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** QA is part of the way to accepted work: facts recorded under `delivery`, or a Trello card, say someone tests it. */
export function qaExpected(task: Task): boolean {
  return task.delivery !== undefined || task.qa_cards !== undefined || task.links.some((link) => /^https:\/\/trello\.com\/c\//i.test(link.trim()));
}

/**
 * The holds of the plan against closing `task`. `asRun`: the card's own live run is the one ending
 * (its PR/MR merged); otherwise a live run is a claim someone holds and nothing closes the card.
 */
export function planHolds(plan: Plan, task: Task, loaded: Pick<LoadedEntity, "acceptance" | "brief">, options: { asRun?: boolean } = {}): Hold[] {
  const holds: Hold[] = [];
  const hold = (h: Hold) => holds.push(h);
  const live = hasLiveRun(task);
  const finish = finishWith(live);
  if (task.auto_closed) {
    hold({
      code: "reopened",
      text: `closed automatically ${task.auto_closed.at.slice(0, 10)} on ${task.auto_closed.by || "a machine"} and reopened since`,
      next: `the rule does not close it twice: ${finish} yourself once it is finished`,
      by: "owner",
      source: card(task),
    });
  }
  if (live && !options.asRun) {
    hold({
      code: "claim",
      text: `a live run holds it (${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"})`,
      next: "follow the run (task); closing never takes a card from a run",
      by: "wait",
      source: card(task),
    });
  }
  if (!live && task.status === "inbox") {
    hold({ code: "draft", text: "it is a draft in the Inbox", next: "accept the draft (update_task status todo) or cancel it; nothing closes a draft", by: "owner", source: card(task) });
  }
  if (!live && task.status === "review") {
    hold({ code: "review", text: "it is in review with no run: accepting it is the owner's", next: "test it and accept it (accept_task), or send it back", by: "owner", source: card(task) });
  }
  if (!live && task.status === "todo" && task.run_id) {
    hold({
      code: "released",
      text: "a run of it was released back to todo: the owner chose to do it again",
      next: `${finish} if the merged work is enough, or start it again for what is left`,
      by: "owner",
      source: card(task),
    });
  }

  if (!loaded.acceptance.length) {
    hold({ code: "acceptance", text: "it lists no acceptance: nothing says what has to be verified", next: `write its acceptance lines, or ${finish} after a look`, by: "owner", source: card(task) });
  } else {
    const open = loaded.acceptance.filter((line) => !line.done);
    if (open.length) {
      hold({
        code: "acceptance",
        text: `${open.length} of ${loaded.acceptance.length} acceptance lines are not ticked: ${cut(open[0]!.text, 120)}${open.length > 1 ? ` (+${open.length - 1})` : ""}`,
        next: "do and tick what is open (QA, a manual or live check), or split it into a new card; then it closes",
        by: "owner",
        source: card(task),
      });
    }
  }

  const question = openQuestion(loaded.brief);
  const decisions = task.requires.filter((r) => r.kind === "owner" || r.kind === "decision");
  if (decisions.length || question) {
    const said = decisions.length ? `${decisions[0]!.kind}: ${decisions[0]!.reason}` : `an open question in its brief: ${question}`;
    hold({ code: "decision", text: cut(`an open decision: ${said}`), next: "settle it (the brief, a clarification or update_task requires []); then it can close", by: "owner", source: card(task) });
  }
  const marks = plan.space?.defaults.human_labels ?? [];
  const marked = task.labels.find((label) => marks.some((name) => sameLabel(name, label)));
  const like = task.labels.find((label) => PERSON_LIKE.some((name) => sameLabel(name, label)));
  const needs = task.requires.filter((r) => r.kind !== "owner" && r.kind !== "decision");
  if (marked || like || needs.length) {
    const said = marked ? `label ${marked} marks it as a person's work` : like ? `label ${like} reads like a person's work` : `it waits for ${needs[0]!.kind}: ${needs[0]!.reason}`;
    hold({
      code: "manual",
      text: cut(`manual acceptance: ${said}`),
      next: marked || like ? `the owner does the check, then: ${finish}` : "settle the requirement (update_task requires []), then it can close",
      by: "owner",
      source: marked ? { label: "space.yaml defaults.human_labels", url: "" } : card(task),
    });
  }

  // A recorded QA card still open, never read or archived with nothing replacing it: its run is not settled.
  // The cards are the hold of their own when something needs clarifying, or QA reads passed with a card
  // not settled. Otherwise QA's ordinary hold stands (an app card's says where its builds are), and a
  // failed QA is always said as such.
  const runs = pendingRuns(task.qa_cards);
  const cardsHold = runs.length > 0 && task.delivery?.qa !== "failed" && (task.delivery?.qa === "passed" || runs.some((run) => run.status === "unclear"));
  if (cardsHold) {
    const named = runs.map((run) => `${cardLabel(run.card)} (${run.status === "unclear" ? "archived, no known replacement" : run.status === "unread" ? "not read" : "open"})`);
    hold({
      // Its own code: QA's hold of an app card is rewritten to say where the builds are, this one is not.
      code: "qa_card",
      text: cut(`QA card not settled: ${named.join(", ")}`),
      next: "record the proof of the run, or the card that replaced it (update_task delivery trello_cards); an archived card passes nothing",
      by: "owner",
      source: { label: `${task.id} QA card`, url: runs[0]!.card.url },
    });
  } else if (qaExpected(task) && task.delivery?.qa !== "passed") {
    const d = task.delivery;
    const failed = d?.qa === "failed";
    hold({
      code: "qa",
      text: failed ? `QA failed${d?.qa_note ? `: ${cut(d.qa_note, 100)}` : ""}` : "QA has not passed: merged code is not accepted work",
      next: failed ? "send it back with what failed, or start it again for the fix" : "QA tests it and the result is recorded (update_task delivery qa passed); a merge or a passing check does not do that",
      by: failed ? "agent" : "owner",
      source: { label: `${task.id} delivery`, url: "" },
    });
  }

  const waits = blockingTasks(plan, task);
  if (waits.length) {
    hold({ code: "dependencies", text: cut(`it waits for ${waits.map((w) => w.text).join("; ")}`), next: "finish what it waits for first", by: "wait", source: card(task) });
  }
  return holds;
}
