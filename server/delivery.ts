import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { tasksDeliveryRpc } from "../shared/api.ts";
import type { Delivery, Task } from "../shared/model.ts";
import { hasLiveRun } from "../shared/model.ts";
import type { Dashboard } from "./dashboard.ts";
import type { LoadedEntity, Plan } from "./plan/load.ts";
import type { GitRunner } from "./sync/git.ts";
import { localRun } from "./api/view.ts";
import { resolveTaskForRead } from "./api/resolve.ts";

/**
 * The way from merged code to accepted work (03-model.md, Delivery; JOBBY-YV2QS part 5): the PR/MR
 * and its merge commit, its checks, the build on stage, the flags, access and device QA needs, the
 * Trello card and QA's result, and who acts next. Merged code is not accepted work: passing checks
 * never tick a manual check, and only QA's recorded result or a person's acceptance closes it.
 *
 * Facts come from the forge (the PR/MR, its merge commit and checks), git (whether the stage build
 * holds the merge) and what a person or an agent recorded on the task (`delivery`, through
 * update_task). Paseo Dash has no Trello access of its own: the card is linked and its state is the
 * one last recorded, with the day; a QA handoff text is ready to post on the card.
 */

export const DELIVERY_STAGES = [
  "in_work",
  "waiting_for_merge",
  "waiting_for_ci",
  "waiting_for_stage",
  "waiting_for_setup",
  "ready_for_qa",
  "qa_failed",
  "qa_passed",
  "accepted",
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

/** Whether the stage build holds the merge commit, as git in the project's checkout tells it. */
export type StageHolds = "yes" | "no" | "unknown";

export interface DeliveryView {
  stage: DeliveryStage;
  /** Who acts next: agent, CI, deploy, owner, QA. */
  next_by: string;
  next: string;
  /** One line per step: "MR: !412 merged (5e1f0c4)", "Stage: build abc1234, does not hold the merge yet". */
  steps: { step: string; state: string; fact: string }[];
  /** Why Trello cannot be read or written from here, when a card is linked; "" otherwise. */
  trello_blocker: string;
  /** A text for QA (the Trello card): what to test, where, with what. */
  qa_handoff: string;
}

/** The Trello card of the task: delivery's, else a trello.com card among its links. */
export function trelloCard(task: Task): string {
  return task.delivery?.trello ?? task.links.find((link) => /^https:\/\/trello\.com\/c\//i.test(link.trim()))?.trim() ?? "";
}

interface MergeFact {
  label: string;
  url: string;
  state: string;
  sha: string;
}

/** How a person names a PR/MR by its URL: `#7`, `!12`; the URL itself when it names no number. */
export function prLabel(url: string): string {
  return url.replace(/^.*\/(?:pull\/|merge_requests\/)(\d+)\/?$/, (_, n: string) => (url.includes("/pull/") ? `#${n}` : `!${n}`));
}

/** The task's PR/MR as this Mac knows it: its run's, else merged work found for it (reconcile). */
function mergeOf(dashboard: Dashboard, plan: Plan, task: Task): MergeFact | undefined {
  const merged = dashboard.merged.shown(plan, task)[0];
  if (merged) return { label: merged.label, url: merged.url, state: "merged", sha: merged.sha ?? "" };
  const seen = dashboard.prs.seen.get(task.id);
  if (seen && seen.run_id === task.run_id) return { label: seen.label, url: seen.url, state: seen.state, sha: "" };
  if (task.run_pr) return { label: prLabel(task.run_pr), url: task.run_pr, state: task.status === "done" ? "merged" : "recorded", sha: "" };
  return undefined;
}

/** Whether `stage` holds `merge` (both commits known to the checkout): git merge-base --is-ancestor. */
export async function stageHolds(git: GitRunner, root: string | undefined, merge: string, stage: string): Promise<StageHolds> {
  if (!root || !/^[0-9a-f]{7,64}$/i.test(merge) || !/^[0-9a-f]{7,64}$/i.test(stage)) return "unknown";
  if (stage.toLowerCase().startsWith(merge.toLowerCase()) || merge.toLowerCase().startsWith(stage.toLowerCase())) return "yes";
  const result = await git.run(root, ["merge-base", "--is-ancestor", merge, stage], 10_000).catch(() => undefined);
  if (!result || result.timedOut) return "unknown";
  // 0: an ancestor; 1: not; anything else (a commit the checkout does not have): unknown.
  return result.code === 0 ? "yes" : result.code === 1 ? "no" : "unknown";
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * The delivery view of a task; pure but for `holds`, which the caller reads from git first.
 * `checks`: the run's PR/MR checks when this Mac read them (server/wait.ts).
 */
export function deliveryView(input: {
  task: Task;
  loaded: Pick<LoadedEntity, "acceptance">;
  merge: MergeFact | undefined;
  checks: string | undefined;
  holds: StageHolds;
}): DeliveryView {
  const { task, loaded, merge, checks, holds } = input;
  const d: Partial<Delivery> = task.delivery ?? {};
  const open = loaded.acceptance.filter((a) => !a.done);
  const steps: DeliveryView["steps"] = [];
  const card = trelloCard(task);

  steps.push({ step: "MR", state: merge?.state ?? "none", fact: merge ? `${merge.label} ${merge.state}${merge.sha ? ` (${short(merge.sha)})` : ""}` : "no PR/MR known" });
  steps.push({ step: "CI", state: checks ?? "unknown", fact: checks ? `checks ${checks}` : "not read here (task_result reads it)" });
  const stageFact = d.stage_sha || d.stage_version || d.stage_url;
  steps.push({
    step: "Stage",
    state: !stageFact ? "unknown" : holds === "yes" ? "holds the merge" : holds === "no" ? "older than the merge" : "not compared",
    fact: stageFact
      ? `${[d.stage_version && `version ${d.stage_version}`, d.stage_sha && `build ${short(d.stage_sha)}`, d.stage_url].filter(Boolean).join(", ")}${d.stage_checked ? ` (recorded ${d.stage_checked.slice(0, 10)})` : ""}`
      : "no stage build recorded",
  });
  if (d.flags?.length || d.flags_ready !== undefined) steps.push({ step: "Flags", state: d.flags_ready ? "on" : d.flags_ready === false ? "not on" : "not checked", fact: d.flags?.join(", ") || "flags" });
  if (d.access_ready !== undefined) steps.push({ step: "Access", state: d.access_ready ? "ready" : "missing", fact: d.access_ready ? "QA has access" : "QA has no access yet" });
  if (d.device) steps.push({ step: "Device", state: d.device_ready ? "ready" : "missing", fact: d.device_ready ? d.device : `missing: ${d.device}` });
  if (card) steps.push({ step: "Trello", state: d.trello_state ?? "not checked", fact: `${card}${d.trello_checked ? ` (checked ${d.trello_checked.slice(0, 10)})` : ""}` });
  steps.push({ step: "QA", state: d.qa ?? "pending", fact: `${d.qa === "passed" ? "passed" : d.qa === "failed" ? `failed${d.qa_note ? `: ${d.qa_note}` : ""}` : "not run"}; ${open.length} of ${loaded.acceptance.length} acceptance lines open` });

  const setupMissing = [
    d.flags_ready === false || (d.flags?.length && d.flags_ready === undefined) ? `flags ${d.flags?.join(", ") || ""}`.trim() : "",
    d.access_ready === false ? "access" : "",
    d.device && !d.device_ready ? `device ${d.device}` : "",
  ].filter(Boolean);

  const decide = (): Pick<DeliveryView, "stage" | "next_by" | "next"> => {
    if (task.status === "done") return { stage: "accepted", next_by: "", next: "nothing: the task is done" };
    if (!merge || (merge.state !== "merged" && merge.state !== "open" && merge.state !== "draft")) {
      return { stage: "in_work", next_by: "agent", next: "the work goes on: no merged PR/MR yet" };
    }
    if (merge.state !== "merged") {
      if (checks === "pending" || checks === "waiting") return { stage: "waiting_for_ci", next_by: "CI", next: `${merge.label}'s checks run; then review and merge` };
      return { stage: "waiting_for_merge", next_by: "owner", next: `${merge.label} waits for review and merge` };
    }
    if (d.qa === "failed") return { stage: "qa_failed", next_by: "agent", next: `QA failed${d.qa_note ? `: ${d.qa_note}` : ""}; send it back with what failed, or start it again for the fix` };
    if (d.qa === "passed") {
      return open.length
        ? { stage: "qa_passed", next_by: "owner", next: `QA passed; ${open.length} acceptance line(s) still open: tick what QA covered, then accept it (mark done)` }
        : { stage: "qa_passed", next_by: "owner", next: "QA passed and every acceptance line is ticked: accept it (mark done)" };
    }
    if (!stageFact) return { stage: "waiting_for_stage", next_by: "deploy", next: `${merge.label} is merged; no stage build is recorded: deploy to stage and record its build (update_task delivery stage_sha)` };
    if (holds === "no") return { stage: "waiting_for_stage", next_by: "deploy", next: `stage runs build ${short(d.stage_sha ?? "")}, older than the merge ${short(merge.sha)}: deploy the merge to stage` };
    if (holds === "unknown" && d.stage_sha && merge.sha) {
      return { stage: "waiting_for_stage", next_by: "owner", next: `whether stage build ${short(d.stage_sha)} holds the merge ${short(merge.sha)} is not known here (fetch the project's checkout, or check the deploy)` };
    }
    if (setupMissing.length) return { stage: "waiting_for_setup", next_by: "owner", next: `before QA: ${setupMissing.join("; ")}` };
    return { stage: "ready_for_qa", next_by: "QA", next: card ? `QA tests on stage; hand the card over with the QA handoff (Trello: ${card})` : "QA tests on stage with the QA handoff" };
  };
  const { stage, next_by, next } = decide();

  const handoff = [
    `${task.id} «${task.title}»`,
    merge ? `Code: ${merge.url}${merge.sha ? ` (merge ${short(merge.sha)})` : ""}, ${merge.state}.` : "",
    stageFact ? `Stage: ${[d.stage_url, d.stage_version && `version ${d.stage_version}`, d.stage_sha && `build ${short(d.stage_sha)}`].filter(Boolean).join(", ")}.` : "Stage: not deployed yet.",
    d.flags?.length ? `Flags: ${d.flags.join(", ")}${d.flags_ready ? " (on)" : " (to turn on)"}.` : "",
    d.device ? `Device: ${d.device}${d.device_ready ? "" : " (missing)"}.` : "",
    open.length ? `To check:\n${open.map((a) => `- [ ] ${a.text}`).join("\n")}` : "Every acceptance line is ticked.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    stage,
    next_by,
    next,
    steps,
    trello_blocker: card
      ? "Paseo Dash has no Trello access (no Trello connector or API key on this Mac): it cannot read or move the card. Its state is the one last recorded; post the QA handoff on the card yourself or through an assistant with Trello access, then record its state (update_task delivery trello_state)."
      : "",
    qa_handoff: handoff,
  };
}

/** Whether a task has delivery to show: recorded facts, a Trello card, or merged work. */
export function hasDelivery(dashboard: Dashboard, plan: Plan, task: Task): boolean {
  return Boolean(task.delivery) || Boolean(trelloCard(task)) || dashboard.merged.shown(plan, task).length > 0 || (Boolean(task.run_pr) && (task.status === "review" || task.status === "done"));
}

/** The view of one task, reading git for the stage comparison. */
export async function readDelivery(dashboard: Dashboard, plan: Plan, mapping: Record<string, string | null>, task: Task, loaded: LoadedEntity): Promise<DeliveryView> {
  const merge = mergeOf(dashboard, plan, task);
  const run = hasLiveRun(task) ? localRun(dashboard.runs, task) : undefined;
  const checks = run ? dashboard.waits.facts.get(run.run_id)?.checks : undefined;
  const projectId = task.project ? mapping[task.project] : undefined;
  const root = projectId ? dashboard.projectRoots.get(projectId) : undefined;
  const holds = merge?.sha && task.delivery?.stage_sha ? await stageHolds(dashboard.git, root, merge.sha, task.delivery.stage_sha) : "unknown";
  return deliveryView({ task, loaded, merge, checks, holds });
}

/** God Mode's `delivery` read: one task's way to accepted work. */
export async function taskDelivery(ctx: { dashboard: Dashboard }, input: RpcInput<typeof tasksDeliveryRpc>): Promise<RpcOutput<typeof tasksDeliveryRpc>> {
  const empty = { id: "", title: "", stage: "", next_by: "", next: "", steps: [], trello_blocker: "", qa_handoff: "" };
  const dashboard = ctx.dashboard;
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const { found } = resolveTaskForRead([...dashboard.spaces.values()], input.task);
  if (!found.ok) return { ...empty, error: found.error };
  const { entity: task, loaded, space } = found.value;
  const view = await readDelivery(dashboard, space.sync.plan, space.record.mapping, task, loaded);
  return { id: task.id, title: task.title, ...view, error: "" };
}
