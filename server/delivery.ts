import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { tasksDeliveryRpc } from "../shared/api.ts";
import type { Delivery, Task } from "../shared/model.ts";
import { hasLiveRun, trelloShortLink } from "../shared/model.ts";
import type { Dashboard } from "./dashboard.ts";
import type { LoadedEntity, Plan } from "./plan/load.ts";
import { localRun } from "./api/view.ts";
import { resolveTaskForRead, type SpaceEntry } from "./api/resolve.ts";
import { named } from "./reconcile/facts.ts";
import { apkText, environmentOf, isApp, variantsOf } from "./reconcile/android.ts";
import { mergeBlockers } from "./reconcile/merge.ts";
import { cardLabel, type QaRun, type QaRunStatus, readAt } from "./qa-cards.ts";
import { type AppFacts, afterMerge, type DeliveryStage, type MergeFact, qaState, runStep, type StageHolds, short, stageHolds, trelloCard } from "./reconcile/steps.ts";
import { ofCard, stoppedReading } from "./reconcile/stopped.ts";

export { DELIVERY_STAGES, stageHolds, trelloCard } from "./reconcile/steps.ts";
export type { AppFacts, DeliveryStage, StageHolds } from "./reconcile/steps.ts";

/**
 * The way from merged code to accepted work (03-model.md, Delivery; JOBBY-YV2QS part 5): the PR/MR
 * and its merge commit, its checks, the build on stage, the flags, access and device QA needs, the
 * Trello card and QA's result, and who acts next. Merged code is not accepted work: passing checks
 * never tick a manual check, and only QA's recorded result or a person's acceptance closes it.
 *
 * Facts come from the forge (the PR/MR, its merge commit and checks), git (whether the stage build
 * holds the merge) and what a person or an agent recorded on the task (`delivery`, through
 * update_task). Paseo Dash has no Trello access of its own: a card's state is the one someone with
 * that access last read and recorded, with the time (`qa_cards`, 03-model.md); a QA handoff text is
 * ready to post on the card. A QA card still open, never read or archived with no known replacement
 * stays in view, also on a task whose code is merged or that is done.
 */

/** What this Mac lacks, and what reading Trello by itself would take. */
const TRELLO_BLOCKER =
  "Paseo Dash has no Trello access (no Trello connector or API key on this Mac): it cannot read or move a card. A card's state is what someone with Trello access last read and recorded (update_task delivery trello_cards); post the QA handoff on the card the same way. Reading cards by itself would need a read-only Trello API key and token for this plugin, which is not set up.";

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
  /** The task's QA cards with what each says is left; absent with none recorded. */
  qa_cards?: { url: string; label: string; status: QaRunStatus; checked: string }[];
}

/** One QA card as a step: its state as last read, where it leads and who tests it next. */
function qaStep({ card, status }: QaRun, all: QaRun[], recorded: Partial<Delivery>, linked: string): DeliveryView["steps"][number] {
  const label = cardLabel(card);
  const named = (url: string) => {
    const other = all.find((run) => trelloShortLink(run.card.url) === trelloShortLink(url));
    return other ? cardLabel(other.card) : url;
  };
  const state = {
    proven: "run proven",
    replaced: "archived, replaced",
    unclear: "archived, needs clarification",
    open: "open, current QA",
    unread: "not read",
  }[status];
  // A state noted by hand after the card was last read is newer: said beside it, never dropped.
  const byHand =
    recorded.trello_state && recorded.trello_checked && trelloShortLink(linked) === trelloShortLink(card.url) && !(Date.parse(recorded.trello_checked) <= Date.parse(card.checked ?? ""))
      ? `noted by hand ${readAt(recorded.trello_checked)}: ${recorded.trello_state}`
      : "";
  return {
    step: `Trello ${label}${label === trelloShortLink(card.url) ? "" : ` (${trelloShortLink(card.url)})`}`,
    state,
    fact: [
      card.url,
      card.name ?? "",
      card.checked ? `${card.state} when read ${readAt(card.checked)}${card.list ? `, list «${card.list}»` : ""}` : "never read",
      card.failed_at ? `last read failed ${readAt(card.failed_at)}: ${card.failure}` : "",
      byHand,
      card.replaced_by?.length ? `replaced by ${card.replaced_by.map(named).join(", ")}${card.evidence ? ` (${card.evidence})` : ""}` : "",
      card.was_replaced_by?.length ? `before it was reopened, replaced by ${card.was_replaced_by.map(named).join(", ")}` : "",
      card.proof ? `proof: ${card.proof}` : "",
      status === "open" ? `next: ${card.tester ?? "QA, nobody named on the card"}` : "",
      status === "unread" ? "next: someone with Trello access reads it" : "",
      status === "unclear" ? "next: the owner says what replaced it, or where its run is proven" : "",
    ]
      .filter(Boolean)
      .join("; "),
  };
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
  app?: AppFacts;
}): DeliveryView {
  const { task, loaded, merge, checks, holds, app } = input;
  const d: Partial<Delivery> = task.delivery ?? {};
  const open = loaded.acceptance.filter((a) => !a.done);
  const steps: DeliveryView["steps"] = [];
  const { runs, pending, unclear, linked, linkedRun } = qaState(task);

  steps.push({ step: "MR", state: merge?.state ?? "none", fact: merge ? `${merge.label} ${merge.state}${merge.sha ? ` (${short(merge.sha)})` : ""}` : "no PR/MR known" });
  steps.push({ step: "CI", state: checks ?? "unknown", fact: checks ? `checks ${checks}` : "not read here (task_result reads it)" });
  const stageFact = d.stage_sha || d.stage_version || d.stage_url;
  if (app) {
    // The code, each variant's build, QA and the publication: four facts, none standing for another.
    steps.splice(
      0,
      1,
      {
        step: "Code",
        state: app.unread ? "not all read" : !app.prs.length ? "none" : app.prs.every((pr) => pr.state === "merged") ? "merged" : app.prs.some((pr) => pr.state === "merged") ? "partly merged" : app.prs.every((pr) => pr.blockers.length === 0) ? "ready to merge" : "waiting to merge",
        fact: [
          app.prs.map((pr) => `${pr.label} ${pr.state}${pr.sha ? ` (${short(pr.sha)})` : ""}${pr.state === "open" || pr.state === "draft" ? (pr.blockers.length ? `, blocked: ${pr.blockers.join("; ")}` : ", ready to merge") : ""}`).join("; ") || "no PR/MR of the card is known",
          app.unread ? `not read: ${app.unread}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      },
    );
    for (const apk of app.apks) {
      steps.push({
        step: `APK ${apk.variant}`,
        state: apk.state === "available" ? "available" : apk.state === "awaited" ? "awaited" : "not known",
        fact: `${environmentOf(task)}: ${apk.why}${apk.build?.url ? ` ${apk.build.url}` : ""}; availability marks no test passed`,
      });
    }
  } else {
    steps.push({
      step: "Stage",
      state: !stageFact ? "unknown" : holds === "yes" ? "holds the merge" : holds === "no" ? "older than the merge" : "not compared",
      fact: stageFact
        ? `${[d.stage_version && `version ${d.stage_version}`, d.stage_sha && `build ${short(d.stage_sha)}`, d.stage_url].filter(Boolean).join(", ")}${d.stage_checked ? ` (recorded ${d.stage_checked.slice(0, 10)})` : ""}`
        : "no stage build recorded",
    });
  }
  if (d.flags?.length || d.flags_ready !== undefined) steps.push({ step: "Flags", state: d.flags_ready ? "on" : d.flags_ready === false ? "not on" : "not checked", fact: d.flags?.join(", ") || "flags" });
  if (d.access_ready !== undefined) steps.push({ step: "Access", state: d.access_ready ? "ready" : "missing", fact: d.access_ready ? "QA has access" : "QA has no access yet" });
  if (d.device) steps.push({ step: "Device", state: d.device_ready ? "ready" : "missing", fact: d.device_ready ? d.device : `missing: ${d.device}` });
  if (linked && !linkedRun) steps.push({ step: "Trello", state: d.trello_state ?? "not checked", fact: `${linked}${d.trello_checked ? ` (checked ${d.trello_checked.slice(0, 10)})` : ""}` });
  for (const run of runs) steps.push(qaStep(run, runs, d, linked));
  steps.push({ step: "QA", state: d.qa ?? "pending", fact: `${d.qa === "passed" ? "passed" : d.qa === "failed" ? `failed${d.qa_note ? `: ${d.qa_note}` : ""}` : "not run"}; ${open.length} of ${loaded.acceptance.length} acceptance lines open` });
  if (app) {
    steps.push({
      step: "Google Play",
      state: d.play ?? "unpublished",
      fact: `${d.play ? `recorded${d.play_at ? ` ${d.play_at.slice(0, 10)}` : ""}` : "nothing recorded"}; a merge, a build or a QA pass publishes nothing`,
    });
  }
  if (task.auto_closed) steps.push({ step: "Closed", state: "by rule", fact: `${task.auto_closed.at.slice(0, 10)} on ${task.auto_closed.by}: ${task.auto_closed.note}` });

  const decide = (): Pick<DeliveryView, "stage" | "next_by" | "next"> => {
    if (task.status === "done") {
      if (!pending.length) return { stage: "accepted", next_by: "", next: "nothing: the task is done" };
      const left = runStep(pending);
      // A failed QA stays said: an unsettled card does not take its place.
      if (d.qa === "failed") return { stage: "qa_failed", next_by: "owner", next: `the task is done and QA failed${d.qa_note ? `: ${d.qa_note}` : ""}; ${left.next}` };
      return { stage: unclear ? "qa_unclear" : "ready_for_qa", next_by: left.next_by, next: `the task is done, its QA is not settled: ${left.next}` };
    }
    // What could not be read may be an open PR/MR: no stage past the code is said before it is.
    if (app?.unread) return { stage: merge?.state === "merged" ? "waiting_for_stage" : "in_work", next_by: "owner", next: `not every PR/MR of the card could be read (${app.unread}): fix that, then the builds are compared` };
    if (!merge || (merge.state !== "merged" && merge.state !== "open" && merge.state !== "draft")) {
      return { stage: "in_work", next_by: "agent", next: "the work goes on: no merged PR/MR yet" };
    }
    if (merge.state !== "merged") {
      if (checks === "pending" || checks === "waiting") return { stage: "waiting_for_ci", next_by: "CI", next: `${merge.label}'s checks run; then review and merge` };
      return { stage: "waiting_for_merge", next_by: "owner", next: `${merge.label} waits for review and merge` };
    }
    return afterMerge({ task, open: open.length, merge, holds, ...(app ? { app } : {}), finish: "accept it (mark done)", failed: "send it back with what failed, or start it again for the fix" });
  };
  const { stage, next_by, next } = decide();

  const handoff = [
    `${task.id} «${task.title}»`,
    merge ? `Code: ${merge.url}${merge.sha ? ` (merge ${short(merge.sha)})` : ""}, ${merge.state}.` : "",
    app ? `Builds: ${apkText(app.apks)}.` : stageFact ? `Stage: ${[d.stage_url, d.stage_version && `version ${d.stage_version}`, d.stage_sha && `build ${short(d.stage_sha)}`].filter(Boolean).join(", ")}.` : "Stage: not deployed yet.",
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
    trello_blocker: linked || runs.length ? TRELLO_BLOCKER : "",
    qa_handoff: handoff,
    ...(runs.length ? { qa_cards: runs.map((run) => ({ url: run.card.url, label: cardLabel(run.card), status: run.status, checked: run.card.checked ?? "" })) } : {}),
  };
}

/** Whether a task has delivery to show: recorded facts, a Trello card, or merged work. */
export function hasDelivery(dashboard: Dashboard, plan: Plan, task: Task, host?: string): boolean {
  if (stoppedReading(dashboard, task, host)?.landed.length) return true;
  return Boolean(task.delivery) || Boolean(task.qa_cards) || Boolean(task.auto_closed) || Boolean(trelloCard(task)) || dashboard.merged.shown(plan, task).length > 0 || (Boolean(task.run_pr) && (task.status === "review" || task.status === "done"));
}

/** The card's own PR/MRs and builds, read now (waiting at most a little), for an app card. */
async function appFacts(dashboard: Dashboard, space: SpaceEntry, task: Task): Promise<AppFacts> {
  const facts = await dashboard.reconciler.factsFor(space, task, 20_000);
  const environment = environmentOf(task);
  if (!facts) {
    const why = "this Mac has not read the card's PR/MRs and builds yet: read again in a minute";
    return { prs: [], apks: variantsOf(task).map((variant) => ({ variant, environment, state: "unknown" as const, why })), trunk: "", unread: why };
  }
  // For a hold whose agent is gone, the card's work as its other checks cover it (reconcile/stopped.ts).
  const own = facts.prs.filter((pr) => (facts.gone ? ofCard(pr, facts.trunk) : named(pr)) && pr.state !== "closed");
  const noChecksOk = Boolean(dashboard.reconciler.rule(space, task)?.no_checks_ok);
  const prs = own.map((pr) => ({
    label: pr.label,
    url: pr.url,
    state: pr.state,
    mergedAt: pr.mergedAt,
    sha: pr.mergeSha,
    blockers: pr.state === "open" || pr.state === "draft" ? mergeBlockers(space.sync.plan, task, facts, pr, new Map(), noChecksOk, (id) => dashboard.reconciler.codeMerged(space, id)) : [],
  }));
  return { prs, apks: facts.gone?.apks ?? facts.apks, trunk: facts.trunk, unread: facts.unknown[0] ?? facts.gone?.unknown[0] ?? facts.limits[0]?.why ?? "" };
}

/** The view of one task, reading git for the stage comparison. */
export async function readDelivery(dashboard: Dashboard, plan: Plan, mapping: Record<string, string | null>, task: Task, loaded: LoadedEntity, space?: SpaceEntry, host?: string): Promise<DeliveryView> {
  // A card whose agent is gone is delivered by what is merged of it, from any branch, and says the
  // same next step as its other reads (reconcile/stopped.ts). The forge is waited for once: an app
  // card's own read, else this one, short enough for the run history a task read adds after it.
  const app = space && isApp(task) ? await appFacts(dashboard, space, task) : undefined;
  if (space && !app && dashboard.reconciler.stoppedHold(space, task, host)) await dashboard.reconciler.factsFor(space, task, 15_000);
  const gone = stoppedReading(dashboard, task, host);
  const ours = app?.prs.filter((pr) => pr.state === "merged").sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0] ?? app?.prs[0];
  // The card's merged work, else its work still open: either says more than "no PR/MR of its run".
  const landed = gone?.landed[0];
  const found = landed ?? (gone?.pending.length ? gone.open[0] : undefined);
  const merge = found
    ? { label: found.label, url: found.url, state: found.state, sha: found.mergeSha }
    : ours
      ? { label: ours.label, url: ours.url, state: ours.state === "draft" ? "draft" : ours.state, sha: ours.sha }
      : mergeOf(dashboard, plan, task);
  const run = hasLiveRun(task) ? localRun(dashboard.runs, task) : undefined;
  const checks = found ? found.checks?.state : run ? dashboard.waits.facts.get(run.run_id)?.checks : undefined;
  const projectId = task.project ? mapping[task.project] : undefined;
  const root = projectId ? dashboard.projectRoots.get(projectId) : undefined;
  // A gone hold's reading compared the stage with every merge of the card, not only the latest.
  const holds = gone?.holds ?? (merge?.sha && task.delivery?.stage_sha ? await stageHolds(dashboard.git, root, merge.sha, task.delivery.stage_sha) : "unknown");
  const view = deliveryView({ task, loaded, merge, checks, holds, ...(app ? { app } : {}) });
  if (!gone || !(gone.landed.length || gone.pending.length)) return view;
  const more = [...gone.landed.slice(1), ...gone.related].map((pr) => `${pr.label} merged`);
  const steps = view.steps.map((step) => (step.step === "MR" && (more.length || gone.pending.length) ? { ...step, fact: [step.fact, ...more, ...gone.pending.map((p) => p.text)].join("; ") } : step));
  return { ...view, steps, stage: gone.stage, next_by: gone.next_by, next: gone.next };
}

/** God Mode's `delivery` read: one task's way to accepted work. */
export async function taskDelivery(ctx: { dashboard: Dashboard; host?: string }, input: RpcInput<typeof tasksDeliveryRpc>): Promise<RpcOutput<typeof tasksDeliveryRpc>> {
  const empty = { id: "", title: "", stage: "", next_by: "", next: "", steps: [], trello_blocker: "", qa_handoff: "" };
  const dashboard = ctx.dashboard;
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const { found } = resolveTaskForRead([...dashboard.spaces.values()], input.task);
  if (!found.ok) return { ...empty, error: found.error };
  const { entity: task, loaded, space } = found.value;
  const view = await readDelivery(dashboard, space.sync.plan, space.record.mapping, task, loaded, space, ctx.host);
  const d = task.delivery;
  const app = isApp(task)
    ? { variants: variantsOf(task), environment: environmentOf(task), builds: (d?.builds ?? []).map((b) => ({ variant: b.variant, environment: b.environment, sha: b.sha, url: b.url ?? "", version: b.version ?? "" })), play: d?.play ?? "" }
    : undefined;
  return { id: task.id, title: task.title, ...view, ...(app ? { app } : {}), error: "" };
}
