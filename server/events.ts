import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { EVENT_KINDS, type EventKind, type eventsListRpc, type eventsSeenRpc, type TaskEvent } from "../shared/events.ts";
import type { Dashboard } from "./dashboard.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";
import type { Activity, RunRecord, WaitingKind } from "./runner/runs.ts";
import { normalizeRemote } from "./spaces/mapping.ts";
import { forgeOf } from "./tracker/forge.ts";
import { QUESTION_NEXT } from "./needs.ts";

/**
 * The task events of this machine's runs (`plugin-data/dashboard/events.json`, 0600; shared/events.ts).
 *
 * - An event is made only where a run's activity changes (RunStore.setActivity), by hooks, by the
 *   tracker's reconcile pass and by a failed start alike. A pass that finds the activity it already
 *   has, a plugin reload and a client reconnecting make none: runs.json keeps the activity across
 *   them. The event is written before runs.json, so a crash between the two writes repeats an event
 *   rather than losing one.
 * - A change missed while the plugin was not running is seen once by the next reconcile pass, as one
 *   change from the activity runs.json last had: intermediate turns are not replayed.
 * - Reading never marks anything; `events.seen` does. An event of a run that is over (the plan held
 *   it and its task is done, released or claimed again) reads as read: nothing about it waits for
 *   anyone. A run that is over makes no new events, even when someone goes on talking to its agent.
 *   A start whose claim never landed was never held, so its failure stays an unread event.
 */

/** Events kept; the oldest go first, read or not. */
export const KEEP_EVENTS = 500;
const SUMMARY_CHARS = 300;
const DEFAULT_LIMIT = 20;

const storedSchema = z.object({
  id: z.number().int(),
  kind: z.enum(EVENT_KINDS),
  task: z.string(),
  space: z.string(),
  project: z.string(),
  run_id: z.string(),
  chat_id: z.string(),
  workspace_id: z.string(),
  at: z.string(),
  summary: z.string(),
  /** The task's title when the event was made. */
  title: z.string(),
  read_at: z.string().optional(),
});
export type StoredEvent = z.output<typeof storedSchema>;

const fileSchema = z.object({ version: z.literal(1), last_id: z.number().int(), events: z.array(storedSchema) });

/** The event a change of a run's activity makes, if any; an agent's questions are `question`. */
export function eventOf(previous: Activity, next: Activity, waitingKind?: WaitingKind): EventKind | undefined {
  if (previous === next) return undefined;
  if (next === "needs_input") return waitingKind === "question" ? "question" : "needs_input";
  if (next === "failed") return "failed";
  // A failed turn leaves the agent idle; that is not a finish. A stopped run does not come back.
  if (next === "waiting" && previous !== "failed" && previous !== "stopped") return "finished";
  return undefined;
}

export function cut(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS - 1)}…`;
}

/**
 * The web page of a file in the plan repository: GitHub's `blob/` or GitLab's `-/blob/` URL on the
 * plan's branch, built from its remote. Empty for a local path, or a host without a dot (an SSH
 * alias), where no web page can be told.
 */
export function planFileUrl(remote: string, branch: string, path: string): string {
  const value = remote.trim();
  if (!value || value.startsWith("/") || /^file:/i.test(value)) return "";
  const normalized = normalizeRemote(value);
  const slash = normalized.indexOf("/");
  const host = slash > 0 ? normalized.slice(0, slash) : "";
  const repo = slash > 0 ? normalized.slice(slash + 1) : "";
  if (!host.includes(".") || !repo || !path) return "";
  const encode = (text: string) => text.split("/").map(encodeURIComponent).join("/");
  const blob = forgeOf(value) === "github" ? "blob" : "-/blob";
  return `https://${host}/${repo}/${blob}/${encode(branch)}/${encode(path)}`;
}

export class EventStore {
  readonly events: StoredEvent[];
  readonly movedAside: string | undefined;
  private lastId: number;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const read = readJsonFile(path, fileSchema, () => ({ version: 1 as const, last_id: 0, events: [] }));
    this.events = read.value.events;
    this.lastId = Math.max(read.value.last_id, ...this.events.map((e) => e.id));
    this.movedAside = read.movedAside;
  }

  get latest(): number {
    return this.lastId;
  }

  private save(): void {
    writeJsonFile(this.path, { version: 1, last_id: this.lastId, events: this.events });
  }

  record(event: Omit<StoredEvent, "id" | "read_at">): StoredEvent {
    const stored = { ...event, id: ++this.lastId };
    this.events.push(stored);
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
    this.save();
    return stored;
  }

  /**
   * The reply of a finished turn, read after the event was made: it goes on that turn's event (the
   * run's finish at `at`), and a later read of the same turn (the reconcile pass reads it again)
   * replaces it.
   */
  fill(runId: string, at: string, summary: string): boolean {
    const text = cut(summary);
    if (!text) return false;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]!;
      if (event.run_id !== runId) continue;
      if (event.kind !== "finished" || event.at !== at || event.summary === text) return false;
      event.summary = text;
      this.save();
      return true;
    }
    return false;
  }

  /** Marks read every unread event up to `through` (in `spaces`, when given); returns how many. */
  markRead(through: number, at: string, spaces?: Set<string>): number {
    let marked = 0;
    for (const event of this.events) {
      if (event.id > through || event.read_at || (spaces && !spaces.has(event.space))) continue;
      event.read_at = at;
      marked++;
    }
    if (marked) this.save();
    return marked;
  }
}

/**
 * The event a run's activity change makes, recorded with the task's title from the plan. Called by
 * RunStore.setActivity before it saves the run.
 */
export function noteActivity(dashboard: Dashboard, run: RunRecord, previous: Activity): void {
  const kind = eventOf(previous, run.activity, run.waitingKind);
  const store = dashboard.events;
  if (!kind || !store || runOver(dashboard, run.space, run.task, run.run_id)) return;
  const task = dashboard.spaces.get(run.space)?.sync.plan.entities.get(run.task)?.entity;
  store.record({
    kind,
    task: run.task,
    space: run.space,
    project: run.project,
    run_id: run.run_id,
    chat_id: run.agentId ?? "",
    workspace_id: run.workspaceId ?? "",
    at: run.activityAt,
    summary: kind === "needs_input" || kind === "question" ? cut(run.waitingFor) : kind === "failed" ? cut(run.error) : "",
    title: task?.title ?? run.task,
  });
}

/**
 * Whether the plan held this run and has ended it: the task's run ended, or a later run claimed the
 * task after this one's claim landed. A claim that never landed (lost, or still undecided) leaves the
 * run not over, so a failed start stays news; so does a start that released its own claim, until the
 * task is claimed again. Unknown (false) while the space is not loaded or its plan lacks the task (a
 * file that does not parse, or not fetched yet).
 */
function runOver(dashboard: Dashboard, space: string, taskId: string, runId: string): boolean {
  const task = dashboard.spaces.get(space)?.sync.plan.entities.get(taskId)?.entity;
  if (task?.type !== "task") return false;
  if (task.run_id === runId) return Boolean(task.run_ended) && !dashboard.runs?.runs.get(runId)?.released;
  return dashboard.runs?.runs.get(runId)?.claim !== "undecided";
}

/** Unread: not marked read, and its run is not over. */
function unread(dashboard: Dashboard, event: StoredEvent): boolean {
  return !event.read_at && !runOver(dashboard, event.space, event.task, event.run_id);
}

/** An event as read: the task's title, status, page and PR/MR as the plan has them now. */
function view(dashboard: Dashboard, event: StoredEvent): TaskEvent {
  const entry = dashboard.spaces.get(event.space);
  const loaded = entry?.sync.plan.entities.get(event.task);
  const task = loaded?.entity.type === "task" ? loaded.entity : undefined;
  const seen = task ? dashboard.prs.seen.get(task.id) : undefined;
  const pr = task?.run_id === event.run_id ? (seen?.run_id === event.run_id && seen.url ? seen.url : (task.run_pr ?? "")) : "";
  return {
    id: event.id,
    kind: event.kind,
    task_id: event.task,
    title: task?.title ?? event.title,
    space: event.space,
    project: event.project,
    chat_id: event.chat_id,
    workspace_id: event.workspace_id,
    at: event.at,
    summary: event.summary,
    link: entry && loaded ? planFileUrl(entry.record.remote, entry.record.branch, loaded.path) : "",
    pr,
    status: task?.status ?? "",
    unread: unread(dashboard, event),
  };
}

type Spaces = { ok: true; keys?: Set<string> } | { ok: false; error: string };

/** A space by key or name, as the overview takes it; empty: every space. */
export function spacesOf(dashboard: Dashboard, asked: string | undefined): Spaces {
  const wanted = asked?.trim().toLowerCase();
  if (!wanted) return { ok: true };
  const found = [...dashboard.spaces.values()].filter(({ record }) => record.key.toLowerCase() === wanted || record.name.toLowerCase() === wanted);
  if (found.length) return { ok: true, keys: new Set(found.map(({ record }) => record.key)) };
  const known = [...dashboard.spaces.values()].map(({ record }) => `${record.name} (${record.key})`).join(", ");
  return { ok: false, error: `No space matches «${asked!.trim()}»${known ? `; spaces: ${known}` : ": no space is connected yet"}.` };
}

/** Unread events of these spaces (all when undefined). */
export function unreadCount(dashboard: Dashboard, keys?: Set<string>): number {
  return (dashboard.events?.events ?? []).filter((e) => unread(dashboard, e) && (!keys || keys.has(e.space))).length;
}

/**
 * The steps that follow a read of events, said with the answer rather than in the description of the
 * read: marking them read, and how the user answers an agent's question (JOBBY-RTWBY). Marking read
 * takes every unread event up to `through`, so `through` stops below the first unread one not shown
 * (history and after can skip some); with none of the shown below that, nothing is offered.
 */
function nextAfter(shown: StoredEvent[], unshownUnread: StoredEvent[], space: string | undefined): string {
  if (shown.length === 0) return "";
  const gap = Math.min(...unshownUnread.map((e) => e.id));
  const through = Math.max(...shown.map((e) => e.id).filter((id) => id < gap));
  if (!Number.isFinite(through)) return "";
  const mark = `once told, mark_events_read with through ${through}${space ? ` and space ${JSON.stringify(space)}` : ""}`;
  return shown.some((e) => e.kind === "question") ? `${mark}; a question: ${QUESTION_NEXT}` : mark;
}

export function listEvents(dashboard: Dashboard, input: RpcInput<typeof eventsListRpc>): RpcOutput<typeof eventsListRpc> {
  const fail = (error: string) => ({ events: [], unread: 0, latest: 0, more: false, error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  const store = dashboard.events;
  if (!store) return fail("Paseo Dash has not started");
  const spaces = spacesOf(dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const mine = store.events.filter((e) => !spaces.keys || spaces.keys.has(e.space));
  const matching = input.history
    ? [...mine].reverse()
    : input.after !== undefined
      ? mine.filter((e) => e.id > input.after!)
      : mine.filter((e) => unread(dashboard, e));
  const shown = matching.slice(0, limit);
  const unshownUnread = mine.filter((e) => unread(dashboard, e) && !shown.includes(e));
  const next = nextAfter(shown, unshownUnread, input.space);
  return {
    events: shown.map((e) => view(dashboard, e)),
    unread: mine.filter((e) => unread(dashboard, e)).length,
    latest: store.latest,
    more: matching.length > limit,
    ...(next ? { next } : {}),
    error: "",
  };
}

export function markEventsRead(dashboard: Dashboard, input: RpcInput<typeof eventsSeenRpc>, now: () => Date = () => new Date()): RpcOutput<typeof eventsSeenRpc> {
  const fail = (error: string) => ({ ok: false, marked: 0, unread: 0, error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  const store = dashboard.events;
  if (!store) return fail("Paseo Dash has not started");
  const spaces = spacesOf(dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  // Marking again, or through an id already read, changes nothing and is no error.
  const marked = store.markRead(input.through, now().toISOString(), spaces.keys);
  return { ok: true, marked, unread: unreadCount(dashboard, spaces.keys), error: "" };
}
