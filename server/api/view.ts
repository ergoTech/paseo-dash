import { hostname } from "node:os";
import { sameLabel } from "../../shared/labels.ts";
import { type Feature, hasLiveRun, type Milestone, refId, type Task } from "../../shared/model.ts";
import type { Plan } from "../plan/load.ts";
import { slugify } from "../plan/ids.ts";
import type { RunRecord, RunStore } from "../runner/runs.ts";
import { type LiveNow, type LiveOverlap, OVERLAP_FILES } from "../../shared/live.ts";
import type { RunLive } from "../tracker/follow.ts";
import { describe } from "./resolve.ts";

/** Derived views of the plan, read from the in-memory index only (no git, disk or network). */

export function tasksOf(plan: Plan): Task[] {
  return [...plan.entities.values()].map((l) => l.entity).filter((e): e is Task => e.type === "task");
}

export function featuresOf(plan: Plan): Feature[] {
  return [...plan.entities.values()].map((l) => l.entity).filter((e): e is Feature => e.type === "feature");
}

export function milestonesOf(plan: Plan): Milestone[] {
  return [...plan.entities.values()].map((l) => l.entity).filter((e): e is Milestone => e.type === "milestone");
}

/** The milestone a task belongs to: its own, else its feature's. */
export function milestoneOf(plan: Plan, task: Task): string | undefined {
  const own = refId(task.milestone);
  if (own) return own;
  const feature = plan.entities.get(refId(task.feature) ?? "")?.entity;
  return feature?.type === "feature" ? refId(feature.milestone) : undefined;
}

/**
 * The tasks a task waits for that are not done, by id and as text; a reference to nothing blocks too.
 * A canceled task will not be done, so waiting for it blocks nothing (decided 2026-10-28).
 */
export function blockingTasks(plan: Plan, task: Task): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const ref of task.depends_on) {
    const id = refId(ref);
    const other = id ? plan.entities.get(id)?.entity : undefined;
    if (!other) out.push({ id: id ?? ref, text: `${id ?? ref} (not found)` });
    else if (other.status !== "done" && other.status !== "canceled") out.push({ id: other.id, text: describe(other) });
  }
  return out;
}

export function blockers(plan: Plan, task: Task): string[] {
  return blockingTasks(plan, task).map((b) => b.text);
}

/** This Mac as a run's host is named: the host name without the `.local` mDNS suffix. */
export function localHost(): string {
  return hostname().replace(/\.local$/i, "");
}

/**
 * The branch a task runs on (03-model.md, Branch names): its own `branch`; else its feature's when the
 * feature has no other task in the same project; else `<feature branch>-<task slug>`; else
 * `task/<id>-<slug>`.
 */
export function plannedBranch(plan: Plan, task: Task): string {
  if (task.branch) return task.branch;
  const slug = slugify(task.title);
  const feature = plan.entities.get(refId(task.feature) ?? "")?.entity;
  if (feature?.type === "feature" && feature.branch) {
    const siblings = tasksOf(plan).filter(
      (other) => other.id !== task.id && other.status !== "canceled" && refId(other.feature) === feature.id && other.project === task.project,
    );
    if (siblings.length === 0) return feature.branch;
    return slug ? `${feature.branch}-${slug}` : `${feature.branch}-${task.id.toLowerCase()}`;
  }
  return `task/${task.id.toLowerCase()}${slug ? `-${slug}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as a person says it: "21:02" today, otherwise "Oct 23, 21:02" (the daemon's time zone). */
export function spokenTime(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? clock : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock}`;
}

/** The local calendar day, YYYY-MM-DD. */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whole days from today to a YYYY-MM-DD date; null when there is none. */
export function daysLeft(due: string | undefined, now: Date): number | null {
  if (!due || !/^\d{4}-\d{2}-\d{2}/.test(due)) return null;
  const toUtc = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return Math.round((toUtc(due) - toUtc(localDay(now))) / 86_400_000);
}

/**
 * What a task's run is doing, as far as the plan says. The agent's own activity (working, waiting,
 * needs input) comes from the runner, which is not part of this version. `claiming`: this Mac's claim
 * of the run is still on its way to the plan repository (server/needs.ts), so its start has no record yet.
 */
export function activityText(task: Task, host = localHost(), run?: RunRecord, claiming = false): string {
  if (!hasLiveRun(task)) return "";
  if (run && run.run_id === task.run_id) {
    switch (run.activity) {
      case "launching":
        return "launching on this Mac";
      case "working":
        return "working on this Mac";
      case "waiting":
        return "waiting for a message on this Mac";
      case "needs_input":
        return `needs your answer on this Mac${run.waitingFor ? `: ${run.waitingFor}` : ""}`;
      case "failed":
        return `failed on this Mac${run.error ? `: ${cut(run.error, 300)}` : ""}`;
      case "stopped":
        // A tracked workspace may never have had an agent the dashboard knows.
        if (run.adopted && !run.agentId) return "tracked on this Mac, without an agent in its workspace";
        return "stopped on this Mac: its agent is gone";
    }
  }
  if (task.run_host === host) return claiming ? "launching on this Mac" : "started on this Mac, without an agent known here";
  return `running on ${task.run_host ?? "another machine"}`;
}

/** This machine's run record of a task's live run, if this machine started it. */
export function localRun(runs: RunStore | undefined, task: Task): RunRecord | undefined {
  const run = task.run_id ? runs?.runs.get(task.run_id) : undefined;
  return run && hasLiveRun(task) ? run : undefined;
}

/** The latest call of the task's run on this machine, while it is followed (server/tracker/follow.ts). */
export function liveNowOf(runs: RunStore | undefined, follower: { nowOf(runId: string): RunLive["now"] | undefined }, task: Task): LiveNow | undefined {
  const run = localRun(runs, task);
  const now = run ? follower.nowOf(run.run_id) : undefined;
  return now ? { op: now.op, target: now.target, at: now.at } : undefined;
}

/** What `overlapsByTask` reads: the dashboard has it. */
export interface OverlapSource {
  runs: RunStore | undefined;
  follower: { overlaps(groupOf: (runId: string) => string | undefined): Map<string, { runId: string; files: string[] }[]> };
  isLive(run: RunRecord): boolean | undefined;
}

/**
 * Each task whose run on this machine shares changed files with another task's run in the same
 * Paseo project, by task id. A run counts only while it is its task's live run and not stopped: the
 * agent of a merged or released task may stay open, with its changed files frozen, and is not a
 * collision. Two runs of one task are not a collision either. Computed once per read: a board or a
 * map asks it for every task.
 */
export function overlapsByTask(source: OverlapSource): Map<string, LiveOverlap[]> {
  const out = new Map<string, LiveOverlap[]>();
  const runs = source.runs;
  if (!runs) return out;
  const counted = (runId: string) => {
    const run = runs.runs.get(runId);
    return run && run.projectId && run.activity !== "stopped" && source.isLive(run) === true ? run : undefined;
  };
  // Task, then the other task, then the files they share (several runs of a task merge here).
  const shared = new Map<string, Map<string, Set<string>>>();
  for (const [runId, others] of source.follower.overlaps((id) => counted(id)?.projectId)) {
    const task = counted(runId)?.task;
    if (!task) continue;
    for (const { runId: other, files } of others) {
      const otherTask = counted(other)?.task;
      if (!otherTask || otherTask === task) continue;
      const byOther = shared.get(task) ?? new Map<string, Set<string>>();
      const set = byOther.get(otherTask) ?? new Set<string>();
      for (const file of files) set.add(file);
      byOther.set(otherTask, set);
      shared.set(task, byOther);
    }
  }
  for (const [task, byOther] of shared) {
    const list = [...byOther]
      .map(([other, set]) => {
        const files = [...set].sort();
        return { task: other, files: files.slice(0, OVERLAP_FILES), more: Math.max(0, files.length - OVERLAP_FILES) };
      })
      .sort((a, b) => a.task.localeCompare(b.task));
    out.set(task, list);
  }
  return out;
}

export function progressText(task: Task, acceptance: { done: boolean }[]): string {
  if (task.progress_total) {
    const head = `${task.progress_done ?? 0} of ${task.progress_total}`;
    return task.progress_note ? `${head} · ${task.progress_note}` : head;
  }
  if (task.progress_note) return task.progress_note;
  if (acceptance.length) return `${acceptance.filter((a) => a.done).length} of ${acceptance.length} acceptance lines done`;
  return "";
}

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** A task's priority as lists rank it: its own, else the space's default, else medium. */
export function priorityRank(plan: Plan, task: Task): number {
  return PRIORITY_ORDER[task.priority ?? plan.space?.defaults.priority ?? "medium"] ?? PRIORITY_ORDER.medium!;
}

/** Where a task stands for a person picking one to start: 0 can start now (todo, not blocked), 1 blocked, 2 the rest. */
export function startGroup(plan: Plan, task: Task): 0 | 1 | 2 {
  if (task.status !== "todo" || hasLiveRun(task)) return 2;
  return blockingTasks(plan, task).length ? 1 : 0;
}

/**
 * The sections every task list is cut into, in the order they show: work running (what waits for
 * the person first), work in review, tasks that can start now, blocked ones, inbox drafts, then
 * finished work.
 */
export const TASK_SECTIONS = ["running", "review", "ready", "blocked", "draft", "done", "canceled"] as const;
export type TaskSection = (typeof TASK_SECTIONS)[number];

export function taskSection(plan: Plan, task: Task): TaskSection {
  switch (task.status) {
    case "in_progress":
      return "running";
    case "review":
      return "review";
    case "inbox":
      return "draft";
    case "done":
      return "done";
    case "canceled":
      return "canceled";
    default:
      if (hasLiveRun(task)) return "running";
      return blockingTasks(plan, task).length ? "blocked" : "ready";
  }
}

/** God Mode keeps 200 characters of a shown field; the reason goes into read-backs. */
export const HUMAN_WORK_CHARS = 200;
const HUMAN_WORK_NAMED = 3;

/** The task's labels that its space's `defaults.human_labels` names; none without that setting. */
function humanLabels(plan: Plan, task: Task): string[] {
  const marked = plan.space?.defaults.human_labels ?? [];
  return task.labels.filter((label) => marked.some((name) => sameLabel(name, label)));
}

const PERSON_WORK = "a person's work";
const labelsText = (labels: string[]) => (labels.length === 1 ? `label ${labels[0]} marks` : `labels ${labels.join(", ")} mark`);

/** Why nothing starts the task on its own; "" when no label of it marks it as a person's work. */
export function humanWork(plan: Plan, task: Task): string {
  const labels = humanLabels(plan, task);
  return labels.length ? cut(`${labelsText(labels)} it as ${PERSON_WORK}`, HUMAN_WORK_CHARS) : "";
}

/**
 * Whether a refused start of `taskId` is the refusal `humanWork` makes (`«title» (ID): label … marks it
 * as a person's work.`): the task waits for a person, the start did not fail.
 */
export function isHumanWorkRefusal(error: string, taskId: string): boolean {
  return error.endsWith(`as ${PERSON_WORK}.`) && /\): labels? /.test(error.slice(error.lastIndexOf(`(${taskId})`)));
}

/** Several such tasks in one line: which, and the labels that mark them. */
export function humanWorkOf(items: { plan: Plan; task: Task }[]): string {
  const ids = items.map(({ task }) => task.id);
  const shown = ids.length > HUMAN_WORK_NAMED ? `${ids.slice(0, HUMAN_WORK_NAMED).join(", ")} and ${ids.length - HUMAN_WORK_NAMED} more` : ids.join(", ");
  const labels: string[] = [];
  for (const { plan, task } of items) for (const label of humanLabels(plan, task)) if (!labels.some((seen) => sameLabel(seen, label))) labels.push(label);
  return cut(`${shown}: ${labelsText(labels)} ${ids.length === 1 ? "it" : "them"} as ${PERSON_WORK}`, HUMAN_WORK_CHARS);
}

/** A running task's agent activity, most in need of the person first; unknown here (another machine's run) last. */
const ATTENTION = ["needs_input", "failed", "waiting", "stopped", "launching", "working"];

/** Oldest first; a value missing sorts after those present. */
function ascending(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

/** The release's due day a task belongs to, for ordering; none sorts after every dated one. */
function dueOf(plan: Plan, task: Task): string | undefined {
  const milestone = plan.entities.get(milestoneOf(plan, task) ?? "")?.entity;
  return milestone?.type === "milestone" && milestone.due && milestone.status !== "done" && milestone.status !== "canceled" ? milestone.due.slice(0, 10) : undefined;
}

/** When finished work finished: its run's end, else the file's last change. */
function finishedAt(task: Task): string {
  return task.run_ended ?? task.updated ?? task.created ?? "";
}

/** By space (one rank orders only its own space's tasks), then ranked before unranked, lower rank first. */
function placed(a: { plan: Plan; task: Task }, b: { plan: Plan; task: Task }): number {
  const spaces = (a.plan.space?.key ?? "").localeCompare(b.plan.space?.key ?? "");
  if (spaces) return spaces;
  const x = a.task.rank;
  const y = b.task.rank;
  if (x === y) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return x - y;
}

export interface SortOptions {
  /** This machine's agent activity of a task's live run, when it has one. */
  activity?: (task: Task) => string | undefined;
}

/**
 * The order of every task list (the Tasks tab and God Mode's `tasks`, a station's tasks, a feature
 * phase's tasks): by section (TASK_SECTIONS), then inside each:
 * - running: the agent needing the person first (ATTENTION), then priority, then the run started first;
 * - review: priority, then the run started first;
 * - ready, blocked, drafts: priority (missing: the space's default), then the place a person gave it
 *   (`rank`, D21: ranked tasks first, lower first), then the release due first (not for drafts), then
 *   creation time (oldest first), then id. A rank orders only inside its own space, so in a list of
 *   several spaces the tasks of one priority go space by space (by key); otherwise the order could
 *   not be total.
 * - done, canceled: the latest finished first.
 */
export function sortTasks<T extends { plan: Plan; task: Task }>(items: T[], options: SortOptions = {}): T[] {
  const facts = new Map(
    items.map((item) => {
      const section = taskSection(item.plan, item.task);
      const activity = section === "running" ? options.activity?.(item.task) : undefined;
      const attention = activity ? ATTENTION.indexOf(activity) : -1;
      return [item, { section: TASK_SECTIONS.indexOf(section), name: section, priority: priorityRank(item.plan, item.task), attention: attention < 0 ? ATTENTION.length : attention, due: dueOf(item.plan, item.task) }] as const;
    }),
  );
  return [...items].sort((a, b) => {
    const x = facts.get(a)!;
    const y = facts.get(b)!;
    if (x.section !== y.section) return x.section - y.section;
    switch (x.name) {
      case "running":
        return x.attention - y.attention || x.priority - y.priority || ascending(a.task.run_started, b.task.run_started) || a.task.id.localeCompare(b.task.id);
      case "review":
        return x.priority - y.priority || ascending(a.task.run_started, b.task.run_started) || a.task.id.localeCompare(b.task.id);
      case "done":
      case "canceled":
        return finishedAt(b.task).localeCompare(finishedAt(a.task)) || a.task.id.localeCompare(b.task.id);
      case "draft":
        return x.priority - y.priority || placed(a, b) || ascending(a.task.created, b.task.created) || a.task.id.localeCompare(b.task.id);
      default:
        return x.priority - y.priority || placed(a, b) || ascending(x.due, y.due) || ascending(a.task.created, b.task.created) || a.task.id.localeCompare(b.task.id);
    }
  });
}

/** A task's PR/MR as a person says it: "#7 open", "!12 merged — <why nothing moved>", or its link. */
export function prText(seen: { run_id: string; label: string; state: string; note?: string } | undefined, task: Task): string {
  if (seen && seen.run_id === task.run_id) return `${seen.label} ${seen.state}${seen.note ? ` — ${seen.note}` : ""}`;
  return task.run_pr ?? "";
}
