import { type Delivery, type Task, trelloShortLink } from "../../shared/model.ts";
import { cardLabel, pendingRuns, type QaRun, qaRuns, readAt } from "../qa-cards.ts";
import type { GitRunner } from "../sync/git.ts";
import type { ApkFact, PrFact } from "./facts.ts";

/**
 * The steps after merged code (03-model.md, Delivery): the one ladder both the delivery read and the
 * reads of a card whose agent is gone (server/reconcile/stopped.ts) climb, so every read says the same
 * next step. Merged code is not accepted work: a green check, a build being there or a closed issue
 * passes no test, and only QA's recorded result or a person's acceptance does.
 */

/** Whether the stage build holds the merge commit, as git in the project's checkout tells it. */
export type StageHolds = "yes" | "no" | "unknown";

/**
 * An app card's PR/MRs (every one it names) and the builds that cover it (03-model.md, App delivery): the code, the build
 * for each variant, QA and the publication are four states that stand apart.
 */
export interface AppFacts {
  /** `followUp`: one that only mentions the card, listed beside its own work (stopped.ts). */
  prs: (Pick<PrFact, "label" | "url" | "state" | "mergedAt"> & { sha: string; blockers: string[]; followUp?: boolean })[];
  apks: ApkFact[];
  trunk: string;
  /** Why not every PR/MR of the card could be read; "" when all were. */
  unread: string;
}

export const DELIVERY_STAGES = [
  "in_work",
  "waiting_for_merge",
  "waiting_for_ci",
  "waiting_for_stage",
  "waiting_for_setup",
  "ready_for_qa",
  "qa_unclear",
  "qa_failed",
  "qa_passed",
  "ready_to_accept",
  "accepted",
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export interface MergeFact {
  label: string;
  url: string;
  state: string;
  sha: string;
}

export interface Step {
  stage: DeliveryStage;
  /** Who acts next: agent, CI, deploy, owner, QA. */
  next_by: string;
  next: string;
}

/** The Trello card of the task: delivery's, else a trello.com card among its links. */
export function trelloCard(task: Task): string {
  return task.delivery?.trello ?? task.links.find((link) => /^https:\/\/trello\.com\/c\//i.test(link.trim()))?.trim() ?? "";
}

export const short = (sha: string) => sha.slice(0, 7);

/** Whether `stage` holds `merge` (both commits known to the checkout): git merge-base --is-ancestor. */
export async function stageHolds(git: GitRunner, root: string | undefined, merge: string, stage: string): Promise<StageHolds> {
  if (!root || !/^[0-9a-f]{7,64}$/i.test(merge) || !/^[0-9a-f]{7,64}$/i.test(stage)) return "unknown";
  if (stage.toLowerCase().startsWith(merge.toLowerCase()) || merge.toLowerCase().startsWith(stage.toLowerCase())) return "yes";
  const result = await git.run(root, ["merge-base", "--is-ancestor", merge, stage], 10_000).catch(() => undefined);
  if (!result || result.timedOut) return "unknown";
  // 0: an ancestor; 1: not; anything else (a commit the checkout does not have): unknown.
  return result.code === 0 ? "yes" : result.code === 1 ? "no" : "unknown";
}

/** The task's QA cards as last recorded, and the one to work on. */
export function qaState(task: Task) {
  const runs = qaRuns(task.qa_cards ?? []);
  const pending = pendingRuns(task.qa_cards);
  const unclear = pending.some((run) => run.status === "unclear");
  const linked = trelloCard(task);
  const linkedRun = runs.find((run) => trelloShortLink(run.card.url) === trelloShortLink(linked));
  const openRun = pending.find((run) => run.status === "open");
  // The card to work on: the linked one, unless it is finished or replaced; then the one still pending.
  const current = !linked || (linkedRun && linkedRun.status !== "open") ? (openRun ?? pending.find((run) => run.status === "unread")) : linkedRun;
  const card = current?.card.url ?? (linkedRun ? "" : linked);
  const tester = current?.card.tester ? `, tester ${current.card.tester}` : "";
  return { runs, pending, unclear, linked, linkedRun, openRun, card, tester };
}

/** Who a pending run waits for and what they do, in one line. */
export function runStep(pending: QaRun[]): Pick<Step, "next_by" | "next"> {
  const unclear = pending.filter((run) => run.status === "unclear");
  if (unclear.length) {
    return {
      next_by: "owner",
      next: `Trello ${unclear.map((run) => cardLabel(run.card)).join(", ")} archived with no known replacement: record where its QA went (replaced_by with evidence) or the proof it ran (update_task delivery trello_cards)`,
    };
  }
  const open = pending.filter((run) => run.status === "open");
  if (open.length) {
    return {
      next_by: "QA",
      next: `the acceptance run is open on Trello ${open.map((run) => `${cardLabel(run.card)} (${run.card.tester ?? "nobody named"}, read ${readAt(run.card.checked!)})`).join(", ")}: record its result, and its proof on the card's reading`,
    };
  }
  return {
    next_by: "owner",
    next: `Trello ${pending.map((run) => cardLabel(run.card)).join(", ")} not read yet: someone with Trello access reads it and records it (update_task delivery trello_cards)`,
  };
}

/** What has to be set up before QA can test: flags, access, a device. */
export function setupMissing(d: Partial<Delivery>): string[] {
  return [
    d.flags_ready === false || (d.flags?.length && d.flags_ready === undefined) ? `flags ${d.flags?.join(", ") || ""}`.trim() : "",
    d.access_ready === false ? "access" : "",
    d.device && !d.device_ready ? `device ${d.device}` : "",
  ].filter(Boolean);
}

export interface AfterMergeInput {
  task: Task;
  /** Acceptance lines not ticked. */
  open: number;
  /** The merged PR/MR the card stands on. */
  merge: Pick<MergeFact, "label" | "sha">;
  holds: StageHolds;
  app?: AppFacts;
  /** How the card is finished from here: "accept it (mark done)", or for a card a live run holds "release it to done (release_task)". */
  finish: string;
  /** What a failed QA leads to from here. */
  failed: string;
}

/**
 * The step of a card whose code is merged: QA's result, then the build QA tests, then the setup it
 * needs, then QA itself. Nothing here reads the forge: facts are passed in.
 */
export function afterMerge(input: AfterMergeInput): Step {
  const { task, open, merge, holds, app, finish, failed } = input;
  const d: Partial<Delivery> = task.delivery ?? {};
  const { pending, unclear, openRun, card, tester } = qaState(task);
  const stageFact = d.stage_sha || d.stage_version || d.stage_url;
  const unmerged = app?.prs.find((pr) => pr.state === "open" || pr.state === "draft");
  if (unmerged) return { stage: "waiting_for_merge", next_by: "owner", next: `${unmerged.label} of the card is not merged yet${unmerged.blockers.length ? `: ${unmerged.blockers[0]}` : ""}` };
  if (d.qa === "failed") return { stage: "qa_failed", next_by: "agent", next: `QA failed${d.qa_note ? `: ${d.qa_note}` : ""}; ${failed}` };
  // An archived card nothing replaces holds acceptance back until someone says where its QA went.
  if (unclear) return { stage: "qa_unclear", ...runStep(pending) };
  if (d.qa === "passed") {
    if (pending.length) return { stage: "qa_passed", next_by: "owner", next: `QA passed is recorded, but ${runStep(pending).next}` };
    return open
      ? { stage: "qa_passed", next_by: "owner", next: `QA passed; ${open} acceptance line(s) still open: tick what QA covered, then ${finish}` }
      : { stage: "qa_passed", next_by: "owner", next: `QA passed and every acceptance line is ticked: ${finish}` };
  }
  if (app) {
    const missing = app.apks.find((apk) => apk.state !== "available");
    if (missing) {
      return {
        stage: "waiting_for_stage",
        next_by: missing.state === "unknown" ? "owner" : "deploy",
        next: `${missing.variant} APK for ${missing.environment}: ${missing.why}${missing.state === "awaited" ? `; build it from ${app.trunk || "the target branch"} and record it (update_task delivery builds)` : ""}`,
      };
    }
  } else if (!stageFact) return { stage: "waiting_for_stage", next_by: "deploy", next: `${merge.label} is merged; no stage build is recorded: deploy to stage and record its build (update_task delivery stage_sha)` };
  if (!app && holds === "no") return { stage: "waiting_for_stage", next_by: "deploy", next: `stage runs build ${short(d.stage_sha ?? "")}, older than the merge ${short(merge.sha)}: deploy the merge to stage` };
  if (!app && holds === "unknown" && d.stage_sha && merge.sha) {
    return { stage: "waiting_for_stage", next_by: "owner", next: `whether stage build ${short(d.stage_sha)} holds the merge ${short(merge.sha)} is not known here (fetch the project's checkout, or check the deploy)` };
  }
  const setup = setupMissing(d);
  if (setup.length) return { stage: "waiting_for_setup", next_by: "owner", next: `before QA: ${setup.join("; ")}` };
  // A card named but never read: its state, and who tests it, are not known yet.
  if (pending.length && !openRun) return { stage: "ready_for_qa", ...runStep(pending) };
  if (app) {
    const links = app.apks.map((apk) => `${apk.variant} ${apk.build?.url ?? ""}`.trim()).join(", ");
    return { stage: "ready_for_qa", next_by: "QA", next: `QA installs ${links} and tests it${card ? ` (Trello: ${card}${tester})` : ""}; the build being there marks no test passed` };
  }
  return { stage: "ready_for_qa", next_by: "QA", next: card ? `QA tests on stage; hand the card over with the QA handoff (Trello: ${card}${tester})` : "QA tests on stage with the QA handoff" };
}
