import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Milestone } from "../shared/model.ts";
import { NEEDS_KINDS, type overviewRpc } from "../shared/overview.ts";
import type { Dashboard } from "./dashboard.ts";
import { hasLiveRun } from "../shared/model.ts";
import { blockers, localHost, localRun, milestoneOf, prText, tasksOf } from "./api/view.ts";
import type { SpaceSync } from "./sync/space-sync.ts";
import { planProblems } from "./plan/load.ts";
import { unreadCount } from "./events.ts";
import { flat, needOf, runActivity, SYNC_NEXT, waitState } from "./needs.ts";
import { cardLabel, qaNeed } from "./qa-cards.ts";
import { reconcileNeeds } from "./reconcile/needs.ts";
import { stoppedReading } from "./reconcile/stopped.ts";

type Overview = RpcOutput<typeof overviewRpc>;

/** Lists are excerpts unless a screen asks for more; `counts` carries the totals. */
const LIST_LIMIT = 10;

function syncedText(sync: SpaceSync): string {
  const { error, pending, lastFetchOk } = sync.state;
  if (error) return `not synced: ${error}${pending ? `; ${pending} change${pending === 1 ? "" : "s"} pending` : ""}`;
  if (pending) return `not synced: ${pending} change${pending === 1 ? "" : "s"} pending`;
  return lastFetchOk ? `synced at ${lastFetchOk}` : "not synced yet";
}

/**
 * When a task in review started to wait: its run's move to review, else the run's start. A date from
 * before the run (a claim by an older version that did not clear it) is an earlier run's.
 */
function reviewSince(task: { run_review_at?: string; run_started?: string }): string {
  const started = task.run_started ?? "";
  return task.run_review_at && task.run_review_at >= started ? task.run_review_at : started;
}

/** Earlier first; an unknown time after the known ones. */
function oldest(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

/**
 * What is going on across the plan. Agent activity (needs_you, running) is known for this machine's
 * runs; another machine's live run is listed as working on its host. `host` is this machine's name as
 * runs record it (tests name one).
 */
export function readOverview(dashboard: Dashboard, { space, limit }: RpcInput<typeof overviewRpc>, host = localHost()): Overview {
  const empty: Overview = {
    needs_you: [],
    running: [],
    review: [],
    counts: { needs_you: 0, running: 0, review: 0, inbox: 0, events: 0 },
    events_latest: 0,
    milestones: [],
    spaces: [],
    error: "",
  };
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const wanted = space?.trim().toLowerCase();
  const chosen = [...dashboard.spaces.values()].filter(
    ({ record }) => !wanted || record.key.toLowerCase() === wanted || record.name.toLowerCase() === wanted,
  );
  if (wanted && chosen.length === 0) {
    const known = [...dashboard.spaces.values()].map(({ record }) => `${record.name} (${record.key})`).join(", ");
    return { ...empty, error: `No space matches «${space!.trim()}»${known ? `; spaces: ${known}` : ": no space is connected yet"}.` };
  }

  const result = empty;
  /** When each item started to wait, to order items of one kind; empty sorts first. */
  const since = new Map<Overview["needs_you"][number], string>();
  const need = (item: Omit<Overview["needs_you"][number], "since">, at = "") => {
    const full = { ...item, since: at };
    result.needs_you.push(full);
    since.set(full, at);
  };
  for (const entry of chosen) {
    const { record, sync } = entry;
    const plan = sync.plan;
    const tasks = tasksOf(plan);
    const key = record.key;
    result.counts.inbox += tasks.filter((t) => t.status === "inbox").length;
    // Plan changes of this machine that cannot reach the plan repository. A failed fetch alone (a
    // network drop) heals on the next tick and is not listed; conflicts are counted under `spaces`.
    if (sync.state.error && sync.state.pending > 0) {
      const n = sync.state.pending;
      need({ task: "", title: record.name, why: `${n} change${n === 1 ? "" : "s"} not pushed: ${flat(sync.state.error)}`, next: SYNC_NEXT, chat_id: "", kind: "sync", space: key });
    }
    for (const task of tasks.filter(hasLiveRun)) {
      const run = localRun(dashboard.runs, task);
      const needed = needOf(dashboard, task, host);
      const chat = dashboard.chats.of(run);
      // A chat that is gone has nothing to open.
      const own = chat?.state === "gone" ? "" : (run?.agentId ?? "");
      if (needed) {
        const held = dashboard.reconciler.heldRun(entry, task, needed);
        // Work found for a gone agent's card names its own step: the rule's hold on the claim would hide it.
        const gone = stoppedReading(dashboard, task, host);
        need({ task: task.id, title: task.title, why: needed.why, next: gone && needed.next === gone.next ? needed.next : (held?.next ?? needed.next), chat_id: needed.chatId ?? own, kind: needed.kind, space: key, ...(held ? { cards: held.cards } : {}), ...(chat ? { chat } : {}) }, needed.since);
      }
      if (task.status !== "in_progress") continue;
      result.running.push({ task: task.id, title: task.title, activity: runActivity(dashboard, task, host), state: waitState(dashboard, task, host).state, host: task.run_host ?? "", chat_id: own, since: task.run_started ?? "" });
    }
    for (const task of tasks) {
      const qa = qaNeed(task);
      if (!qa) continue;
      const links = qa.cards.map((run) => ({ label: cardLabel(run.card), url: run.card.url }));
      const cards = [{ task: task.id, title: task.title, note: flat(qa.why), source: "Trello, as last recorded", links }];
      need({ task: task.id, title: task.title, why: flat(qa.why), next: qa.next, chat_id: "", kind: "qa", space: key, cards });
    }
    for (const item of reconcileNeeds(dashboard, entry)) need({ ...item, chat_id: "", space: key });
    const review = tasks.filter((t) => t.status === "review");
    result.counts.review += review.length;
    result.review.push(...review.map((t) => ({ task: t.id, title: t.title, pr: prText(dashboard.prs.seen.get(t.id), t), since: reviewSince(t) })));
    const milestones = [...plan.entities.values()]
      .map((l) => l.entity)
      .filter((e): e is Milestone => e.type === "milestone" && e.status !== "done" && e.status !== "canceled");
    for (const milestone of milestones) {
      // Drafts are not accepted work yet, and canceled work will not be done: neither counts.
      const own = tasks.filter((t) => t.status !== "canceled" && t.status !== "inbox" && milestoneOf(plan, t) === milestone.id);
      result.milestones.push({
        id: milestone.id,
        title: milestone.title,
        due: milestone.due ?? "",
        done: own.filter((t) => t.status === "done").length,
        total: own.length,
        blocked: own.filter((t) => t.status === "todo" && blockers(plan, t).length > 0).length,
      });
    }
    result.spaces.push({
      key: record.key,
      name: record.name,
      synced: syncedText(sync),
      conflicts: sync.state.conflicts.length,
      needs_you: result.needs_you.filter((n) => n.space === key).length,
      problems: planProblems(plan).length + sync.state.lateClaims.length,
    });
  }
  // Most urgent kind first; within a kind, the one waiting longest where that is known.
  result.needs_you.sort((a, b) => NEEDS_KINDS.indexOf(a.kind) - NEEDS_KINDS.indexOf(b.kind) || (since.get(a) ?? "").localeCompare(since.get(b) ?? ""));
  result.counts.needs_you = result.needs_you.length;
  result.counts.events = unreadCount(dashboard, new Set(chosen.map(({ record }) => record.key)));
  result.events_latest = dashboard.events?.latest ?? 0;
  result.counts.running = result.running.length;
  // Working: an agent waiting for the person or failed first, then the longest running; no agent at
  // work goes last (Needs you lists it, as stopped or checkout). Review: the longest waiting.
  const attention = ["waiting", "failed", "launching", "working", "stopped"];
  result.running.sort((a, b) => attention.indexOf(a.activity) - attention.indexOf(b.activity) || oldest(a.since, b.since) || a.task.localeCompare(b.task));
  result.review.sort((a, b) => oldest(a.since, b.since) || a.task.localeCompare(b.task));
  const cap = limit ?? LIST_LIMIT;
  const shown = result.needs_you.slice(0, cap);
  // The one list of PR/MRs to merge stays in a short excerpt too.
  const merge = result.needs_you.slice(cap).find((item) => item.kind === "merge");
  if (merge && shown.length && !shown.some((item) => item.kind === "merge")) shown[shown.length - 1] = merge;
  result.needs_you = shown;
  result.running = result.running.slice(0, cap);
  result.review = result.review.slice(0, cap);
  result.milestones.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  result.milestones = result.milestones.slice(0, LIST_LIMIT);
  return result;
}
