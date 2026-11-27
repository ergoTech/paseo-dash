import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { overlapText } from "../../shared/live.ts";
import { type Feature, hasLiveRun, isArchived, refId, startable, type Task, unheld } from "../../shared/model.ts";
import type {
  inboxListRpc,
  releaseCheckRpc,
  roadmapRpc,
  startCheckRpc,
  tasksGetRpc,
  tasksListRpc,
} from "../../shared/api.ts";
import { TASK_ROW_OPTIONAL } from "../../shared/api.ts";
import type { uiStartCheckRpc } from "../../shared/ui.ts";
import { BOARD_COLUMN_LIMIT, BOARD_COLUMNS, BOARD_DONE_LIMIT, type uiBoardRpc } from "../../shared/board.ts";
import type { Dashboard } from "../dashboard.ts";
import type { Glyph } from "../../shared/map.ts";
import { glyphFor } from "../map/read.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import type { PaseoApi } from "../paseo.ts";
import { type BranchPlan, decideBranch, type ExistingBranch, originHead, type PreviousWorkspace, trunkNames } from "../runner/branch.ts";
import { closureFact } from "../issues/link.ts";
import { issueFacts, readableIssue } from "../tracker/issues.ts";
import { localProjects } from "../spaces/local.ts";
import type { AgentSettings } from "../runner/profiles.ts";
import { pickForTask, taskSignals } from "../runner/model-policy.ts";
import { HANDOFF_MAX } from "../agent-tools/schema.ts";
import { agentTitle, spaceTemplate } from "../runner/prompt.ts";
import type { RunRecord } from "../runner/runs.ts";
import { factText, hashText, type InstructionsPart, type PartFact, taskInstructions, taskPartKey, taskPartName, TEMPLATE_PART } from "../runner/seen.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import { type FoundEntity, type Resolved, resolveEntity, resolveProject, resolveSpaces, resolveTaskForRead, type SpaceEntry } from "./resolve.ts";
import { type Found, type Match as TaskMatch, namedThings, parseQuery, search } from "../search/core.ts";
import { historyWithin, localRecord, runProgress, runResult } from "./runs.ts";
import { claiming, needOf, waitState } from "../needs.ts";
import { hasDelivery, readDelivery } from "../delivery.ts";
import { stoppedReading } from "../reconcile/stopped.ts";
import { decideSet, ownerGate, UNHELD_REASON, waitsText } from "./start-verdict.ts";
import { startWithoutAsking } from "../godmode-settings.ts";
import { findPerson, personByEmail, sameLabel } from "../../shared/labels.ts";
import {
  activityText,
  blockers,
  blockingTasks,
  liveNowOf,
  localRun,
  overlapsByTask,
  prText,
  cut,
  daysLeft,
  featuresOf,
  HUMAN_WORK_CHARS,
  humanWork,
  localHost,
  milestoneOf,
  milestonesOf,
  plannedBranch,
  progressText,
  sortTasks,
  startGroup,
  taskSection,
  spokenTime,
  tasksOf,
} from "./view.ts";

/**
 * The plan's reads (06-god-mode.md, Reads). They touch only the in-memory index, except
 * `tasks.start-check`, which also asks git who last changed the task.
 */

export interface ReadContext {
  dashboard: Dashboard;
  now?: () => Date;
  host?: string;
}

const clock = (ctx: ReadContext) => (ctx.now ?? (() => new Date()))();

/** Not the owner of this daemon's data: reads would show another installation's stale copy. */
function notOwner(ctx: ReadContext): string {
  return !ctx.dashboard.owner && ctx.dashboard.ownerReason ? ctx.dashboard.ownerReason : "";
}

// ---------------------------------------------------------------- filters

/** Who and what a task list is narrowed to: a person per space (`mine`, `assignee`) and a label. */
interface TaskFilter {
  /** Per space key: the person keys (or, for an `assignee` space.yaml does not list, the text asked) a task must be assigned to. */
  people?: Map<string, string[]>;
  label?: string;
}

/**
 * `mine` is the person whose emails hold this machine's git email (each space's own clone answers);
 * `assignee` is a person by key or name, or the text itself where a space does not list them.
 */
async function taskFilter(spaces: SpaceEntry[], input: { mine?: boolean; assignee?: string; label?: string }): Promise<Resolved<TaskFilter>> {
  const filter: TaskFilter = { label: input.label?.trim() || undefined };
  if (!input.mine && !input.assignee) return { ok: true, value: filter };
  const people = new Map<string, string[]>();
  let email = "";
  for (const space of spaces) {
    const listed = space.sync.plan.space?.people ?? {};
    const wanted: string[][] = [];
    if (input.mine) {
      const own = await space.sync.gitEmail();
      email ||= own;
      const me = personByEmail(listed, own);
      wanted.push(me ? [me] : []);
    }
    if (input.assignee) {
      const key = findPerson(listed, input.assignee);
      wanted.push([key ?? input.assignee.trim()]);
    }
    // Both asked: only a person who is both.
    const both = wanted.reduce((a, b) => a.filter((key) => b.some((other) => other.toLowerCase() === key.toLowerCase())));
    people.set(space.record.key, both);
  }
  if (input.mine && ![...people.values()].some((keys) => keys.length)) {
    const why = email ? `this machine's git email (${email})` : "this machine's git email (git config user.email is not set)";
    return { ok: false, error: `No person in space.yaml has ${why}; add it to a person on the People & labels tab of Paseo Dash.` };
  }
  filter.people = people;
  return { ok: true, value: filter };
}

function passes(filter: TaskFilter, space: SpaceEntry, task: Task): boolean {
  if (filter.label && !task.labels.some((label) => sameLabel(label, filter.label!))) return false;
  if (!filter.people) return true;
  const assignee = task.assignee?.trim().toLowerCase();
  if (!assignee) return false;
  const listed = space.sync.plan.space?.people ?? {};
  // A hand-written assignee may be the person's name rather than the key.
  return (filter.people.get(space.record.key) ?? []).some(
    (key) => key.toLowerCase() === assignee || (Object.hasOwn(listed, key) && listed[key]!.name?.trim().toLowerCase() === assignee),
  );
}

// ---------------------------------------------------------------- tasks.list

type TaskRow = TasksList["tasks"][number];
type FullRow = Omit<TaskRow, (typeof TASK_ROW_OPTIONAL)[number]> & {
  [K in (typeof TASK_ROW_OPTIONAL)[number]]-?: K extends "blocked" ? boolean : Exclude<TaskRow[K], undefined>;
};

/** A row without its empty fields ("", false, no labels): each one costs every read of every list. */
function withoutEmpty(row: FullRow): TaskRow {
  const out: Record<string, unknown> = { ...row };
  for (const key of TASK_ROW_OPTIONAL) {
    const value = out[key];
    if (value === "" || value === false || (Array.isArray(value) && value.length === 0)) delete out[key];
  }
  return out as TaskRow;
}

type TasksList = RpcOutput<typeof tasksListRpc>;

export async function listTasks(ctx: ReadContext, input: RpcInput<typeof tasksListRpc>): Promise<TasksList> {
  const fail = (error: string): TasksList => ({ tasks: [], total: 0, shown: 0, error });
  const owner = notOwner(ctx);
  if (owner) return fail(owner);
  const spaces = resolveSpaces(ctx.dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  const limit = input.limit ?? 20;

  let feature: string | undefined;
  let milestone: string | undefined;
  if (input.feature) {
    const found = resolveEntity(spaces.value, "feature", input.feature);
    if (!found.ok) return fail(found.error);
    feature = found.value.entity.id;
  }
  if (input.milestone) {
    const found = resolveEntity(spaces.value, "milestone", input.milestone);
    if (!found.ok) return fail(found.error);
    milestone = found.value.entity.id;
  }
  const projectBySpace = new Map<string, string>();
  if (input.project) {
    for (const space of spaces.value) {
      const found = resolveProject(space, input.project);
      if (found.ok) projectBySpace.set(space.record.key, found.value);
    }
    if (projectBySpace.size === 0) {
      const one = spaces.value[0];
      return fail(one ? (resolveProject(one, input.project) as { error: string }).error : `No project «${input.project}».`);
    }
  }
  const query = input.query ? parseQuery(input.query) : undefined;
  // A search looks through finished work too, unless a status is asked.
  const status = input.status ?? (query ? "all" : "open");
  const host = ctx.host ?? localHost();
  const filter = await taskFilter(spaces.value, input);
  if (!filter.ok) return fail(filter.error);

  const candidates: Candidate[] = [];
  for (const space of spaces.value) {
    if (input.project && !projectBySpace.has(space.record.key)) continue;
    const plan = space.sync.plan;
    for (const loaded of plan.entities.values()) {
      if (loaded.entity.type !== "task") continue;
      const task = loaded.entity;
      if (status === "open" ? task.status === "done" || task.status === "canceled" : status !== "all" && task.status !== status) continue;
      if (input.project && task.project !== projectBySpace.get(space.record.key)) continue;
      if (feature && refId(task.feature) !== feature) continue;
      if (milestone && milestoneOf(plan, task) !== milestone) continue;
      if (!passes(filter.value, space, task)) continue;
      candidates.push({ task, plan, loaded });
    }
  }
  const found = query ? searchCandidates(ctx, candidates, input.query!, true) : undefined;
  const matches = found ? found.hits.map((h) => ({ ...h.item, match: h.match })) : sortTasks(candidates, { activity: (task) => localRun(ctx.dashboard.runs, task)?.activity });
  const offset = input.offset ?? 0;
  const shown = matches.slice(offset, offset + limit);
  // Only on the first page: what else the words name, so a feature or release is found by its name.
  const also = query && !query.ref && offset === 0 ? namedThings(spaces.value.map((s) => ({ key: s.record.key, plan: s.sync.plan })), input.query!) : [];
  return {
    tasks: shown.map(({ task, plan, match }) => taskRowOf(ctx, plan, task, host, match)),
    total: matches.length,
    shown: shown.length,
    ...(also.length ? { also } : {}),
    ...searchFacts(found),
    error: "",
  };
}

/** A task a list may show, before the search. */
interface Candidate {
  task: Task;
  plan: Plan;
  loaded: LoadedEntity;
  match?: TaskMatch;
}

/** The candidates a query finds, best first, the list order (sortTasks) breaking ties. */
function searchCandidates(ctx: ReadContext, candidates: Candidate[], text: string, partial: boolean): Found<Candidate> {
  const order = new Map(sortTasks(candidates, { activity: (task) => localRun(ctx.dashboard.runs, task)?.activity }).map((c, i) => [c, i]));
  return search(candidates, text, { partial, order: (c) => order.get(c) ?? 0 }) ?? { hits: [], partial: false, searchedFor: "" };
}

/** `partial` and `searched_for` of a list's answer, each only when it holds. */
function searchFacts(found: Found<unknown> | undefined): { partial?: true; searched_for?: string } {
  return { ...(found?.partial ? { partial: true as const } : {}), ...(found?.searchedFor ? { searched_for: found.searchedFor } : {}) };
}

/** One task as tasks.list and the board show it. */
function taskRowOf(ctx: ReadContext, plan: Plan, task: Task, host: string, match?: TaskMatch): TaskRow {
  const waits = blockers(plan, task);
  const release = plan.entities.get(milestoneOf(plan, task) ?? "")?.entity;
  const needed = needOf(ctx.dashboard, task, host);
  return withoutEmpty({
    id: task.id,
    title: task.title,
    status: task.status,
    section: taskSection(plan, task),
    // Drafts and canceled work are never blocked: a plain mark, as the map's depot draws them.
    glyph: task.status === "inbox" || task.status === "canceled" ? "todo" : glyphFor(ctx.dashboard, plan, task),
    priority: task.priority ?? plan.space?.defaults.priority ?? "medium",
    release: release?.type === "milestone" ? release.title : "",
    activity: activityText(task, host, localRun(ctx.dashboard.runs, task), claiming(ctx.dashboard, task)),
    needs: needed?.kind ?? "",
    next: needed?.next ?? "",
    project: task.project ?? "",
    assignee: task.assignee ?? "",
    labels: task.labels,
    blocked: waits.length > 0,
    blocked_by: waits.join("; "),
    matched_in: match?.field ?? "",
    quote: match?.quote ?? "",
  });
}

// ---------------------------------------------------------------- ui.board

type Board = RpcOutput<typeof uiBoardRpc>;

/**
 * The board's columns (shared/board.ts): every task of the spaces asked for but canceled and archived
 * ones, cut by taskSection and ordered by sortTasks, the same as tasks.list; each column lists at most
 * its limit, done the latest finished ones, and counts the rest. With `archived`, only the archived
 * tasks, done and canceled both, in the done column (03-model.md, Archive).
 */
export async function readBoard(ctx: ReadContext, input: RpcInput<typeof uiBoardRpc>): Promise<Board> {
  const columns = (): Board["columns"] => BOARD_COLUMNS.map((column) => ({ column, total: 0, tasks: [] }));
  const fail = (error: string): Board => ({ columns: columns(), error });
  const owner = notOwner(ctx);
  if (owner) return fail(owner);
  const spaces = resolveSpaces(ctx.dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  const filter = await taskFilter(spaces.value, input);
  if (!filter.ok) return fail(filter.error);
  const query = input.query ? parseQuery(input.query) : undefined;
  const host = ctx.host ?? localHost();
  const items: Candidate[] = [];
  for (const space of spaces.value) {
    const plan = space.sync.plan;
    for (const loaded of plan.entities.values()) {
      if (loaded.entity.type !== "task") continue;
      const task = loaded.entity;
      if (input.archived ? !isArchived(task) : task.status === "canceled" || isArchived(task)) continue;
      if (!passes(filter.value, space, task)) continue;
      items.push({ task, plan, loaded });
    }
  }
  // As tasks.list, with every word (a board of partial matches would read as a filter that failed);
  // each column keeps its own order.
  const searched = query ? searchCandidates(ctx, items, input.query!, false) : undefined;
  const found = searched ? searched.hits.map((h) => ({ ...h.item, match: h.match })) : items;
  const out = columns();
  const byColumn = new Map(out.map((c) => [c.column as string, c]));
  const overlaps = overlapsByTask(ctx.dashboard);
  for (const item of sortTasks(found, { activity: (task) => localRun(ctx.dashboard.runs, task)?.activity })) {
    const column = byColumn.get(input.archived ? "done" : taskSection(item.plan, item.task));
    if (!column) continue;
    column.total += 1;
    if (column.tasks.length >= (column.column === "done" ? BOARD_DONE_LIMIT : BOARD_COLUMN_LIMIT)) continue;
    const merged = ctx.dashboard.merged.shown(item.plan, item.task);
    const live = liveNowOf(ctx.dashboard.runs, ctx.dashboard.follower, item.task);
    const shared = overlaps.get(item.task.id);
    column.tasks.push({
      ...taskRowOf(ctx, item.plan, item.task, host, item.match),
      ...(merged.length ? { merged } : {}),
      ...(isArchived(item.task) ? { archived: true } : {}),
      ...(unheld(item.task) ? { unheld: true } : {}),
      ...(live ? { live } : {}),
      ...(shared ? { overlaps: shared } : {}),
    });
  }
  // A board on view keeps the readings of work merged outside the dashboard fresh, without waiting for them.
  ctx.dashboard.merged.peek();
  return { columns: out, ...(searched?.searchedFor ? { searched_for: searched.searchedFor } : {}), error: "" };
}

// ---------------------------------------------------------------- tasks.get

type TaskRead = RpcOutput<typeof tasksGetRpc>;

const EMPTY_TASK: TaskRead = {
  id: "",
  title: "",
  status: "",
  activity: "",
  needs: "",
  next: "",
  progress: "",
  blocked_by: "",
  pr: "",
  chat_id: "",
  project: "",
  feature: "",
  milestone: "",
  priority: "",
  assignee: "",
  labels: [],
  issue: "",
  issue_state: "",
  agent_profile: "",
  branch: "",
  held_by: "",
  host: "",
  since: "",
  acceptance: [],
  last_message: "",
  brief: "",
  handoff: "",
  runs: [],
  runs_error: "",
  error: "",
};

function titleOf(plan: Plan, id: string | undefined): string {
  const entity = id ? plan.entities.get(id)?.entity : undefined;
  return entity ? `${entity.title} (${entity.id})` : (id ?? "");
}

export function getTask(ctx: ReadContext, input: RpcInput<typeof tasksGetRpc>): TaskRead {
  const owner = notOwner(ctx);
  if (owner) return { ...EMPTY_TASK, error: owner };
  // A read that only shows: a vague name may still find the one task search points to.
  const { found, foundBy } = resolveTaskForRead([...ctx.dashboard.spaces.values()], input.task);
  if (!found.ok) return { ...EMPTY_TASK, error: found.error };
  const { entity: task, loaded, space } = found.value;
  const plan = space.sync.plan;
  const live = hasLiveRun(task);
  const run = localRun(ctx.dashboard.runs, task);
  const issue = issueFacts(task, ctx.dashboard.issues.peek(task, plan), readableIssue(plan, task.issue));
  const host = ctx.host ?? localHost();
  const needed = needOf(ctx.dashboard, task, host);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    activity: activityText(task, host, run, claiming(ctx.dashboard, task)),
    needs: needed?.kind ?? "",
    next: needed?.next ?? "",
    ...(live ? { state: stateText(ctx, task, host) } : {}),
    progress: progressText(task, loaded.acceptance),
    blocked_by: blockers(plan, task).join("; "),
    pr: live ? prText(ctx.dashboard.prs.seen.get(task.id), task) || mergedPrText(ctx, task, host) : (task.run_pr ?? ""),
    chat_id: run?.agentId ?? "",
    project: task.project ?? "",
    feature: titleOf(plan, refId(task.feature)),
    milestone: titleOf(plan, milestoneOf(plan, task)),
    priority: task.priority ?? "",
    assignee: task.assignee ?? "",
    labels: task.labels,
    issue: task.issue ?? "",
    issue_state: issue.note ? `${issue.state}: ${issue.note}` : issue.state,
    agent_profile: task.agent_profile ?? "",
    branch: live ? (task.run_branch ?? "") : plannedBranch(plan, task),
    held_by: live ? (task.run_by ?? "") : "",
    host: live ? (task.run_host ?? "") : "",
    since: live ? spokenTime(task.run_started, clock(ctx)) : "",
    acceptance: loaded.acceptance.map(({ text, done }) => ({ text, done })),
    last_message: cut(run?.lastMessage ?? "", 600),
    brief: cut(loaded.brief, TASK_BRIEF_CHARS),
    ...(loaded.brief.length > TASK_BRIEF_CHARS ? { brief_chars: loaded.brief.length } : {}),
    handoff: loaded.handoff ? cut(loaded.handoff.text, HANDOFF_MAX) : "",
    runs: [],
    runs_error: "",
    ...(foundBy ? { found_by: foundBy } : {}),
    ...sharesFiles(ctx, task.id),
    error: "",
  };
}

/** "#12 merged": the merged work of a card whose agent is gone and whose run recorded no PR/MR. */
function mergedPrText(ctx: ReadContext, task: Task, host: string): string {
  const landed = stoppedReading(ctx.dashboard, task, host)?.landed ?? [];
  return landed.length ? `${landed.map((pr) => pr.label).join(", ")} merged` : "";
}

/** A live run's state with its fact: "subagent_working: a sub-agent of it at work". */
function stateText(ctx: ReadContext, task: Task, host: string): string {
  const { state, note } = waitState(ctx.dashboard, task, host);
  return note ? `${state}: ${note}` : state;
}

/** Characters of the brief the compact task read carries; task_text reads the rest. */
export const TASK_BRIEF_CHARS = 1200;

/** How many of a task's runs God Mode's task read carries, newest first. */
export const RUNS_IN_TASK = 5;

/**
 * `tasks.get` as God Mode reads it: the task with its latest runs from the plan's history (asked of
 * git, cached per clone HEAD). A history that cannot be read leaves the task read standing and says why.
 */
export async function getTaskWithRuns(ctx: ReadContext, input: RpcInput<typeof tasksGetRpc>): Promise<TaskRead> {
  const read = getTask(ctx, input);
  if (read.error) return read;
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", read.id);
  if (!found.ok) return { ...read, runs_error: found.error };
  const now = clock(ctx);
  const { entity: task, loaded, space } = found.value;
  if (task.type === "task" && hasDelivery(ctx.dashboard, space.sync.plan, task, ctx.host)) {
    const view = await readDelivery(ctx.dashboard, space.sync.plan, space.record.mapping, task, loaded, space, ctx.host);
    read.delivery = cut(`${view.stage}; next ${view.next_by || "nobody"}: ${view.next}`, 300);
  }
  const history = await historyWithin(ctx.dashboard, found.value.space.sync, found.value.loaded);
  if (history.error) return { ...read, runs_error: history.error };
  const runs = history.runs.slice(0, RUNS_IN_TASK).map((run) => {
    const record = localRecord(ctx.dashboard, run, read.id);
    return {
      run_id: run.run_id,
      by: run.by,
      host: run.host,
      branch: run.branch,
      started: spokenTime(run.started, now),
      ended: spokenTime(run.ended, now),
      result: runResult(run, record),
      pr: run.pr,
      progress: runProgress(run),
      handoff: cut(run.handoff?.text ?? "", 600),
      chat_id: record?.agentId ?? "",
      last_message: cut(record?.lastMessage ?? "", 300),
    };
  });
  return { ...read, runs };
}

// ---------------------------------------------------------------- roadmap.get

type Roadmap = RpcOutput<typeof roadmapRpc>;

const STAGE: Record<string, number> = { inbox: 0, todo: 1, in_progress: 2, review: 3, done: 4 };

/** Per project, how far the feature got there: its least advanced open task, or done. */
function projectsLine(tasks: Task[], planned: string[]): string {
  const byProject = new Map<string, Task[]>();
  for (const project of planned) byProject.set(project, []);
  for (const task of tasks) {
    const key = task.project ?? "no project";
    byProject.set(key, [...(byProject.get(key) ?? []), task]);
  }
  return [...byProject.entries()]
    .map(([project, own]) => {
      if (own.length === 0) return `${project} no tasks`;
      const least = own.reduce((a, b) => ((STAGE[a.status] ?? 0) <= (STAGE[b.status] ?? 0) ? a : b));
      return `${project} ${least.status}`;
    })
    .join(" · ");
}

export function readRoadmap(ctx: ReadContext, input: RpcInput<typeof roadmapRpc>): Roadmap {
  const fail = (error: string): Roadmap => ({ milestones: [], later: [], error });
  const owner = notOwner(ctx);
  if (owner) return fail(owner);
  const spaces = resolveSpaces(ctx.dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  let only: string | undefined;
  if (input.milestone) {
    const found = resolveEntity(spaces.value, "milestone", input.milestone);
    if (!found.ok) return fail(found.error);
    only = found.value.entity.id;
  }
  const now = clock(ctx);
  const result: Roadmap = { milestones: [], later: [], error: "" };
  for (const space of spaces.value) {
    const plan = space.sync.plan;
    // Drafts are not accepted work yet, and canceled work will not be done: neither counts.
    const counted = tasksOf(plan).filter((t) => t.status !== "canceled" && t.status !== "inbox");
    const featureLine = (feature: Feature) => {
      const own = counted.filter((t) => refId(t.feature) === feature.id);
      return {
        id: feature.id,
        title: feature.title,
        status: feature.status,
        done: own.filter((t) => t.status === "done").length,
        total: own.length,
        projects: projectsLine(own, feature.projects),
      };
    };
    for (const milestone of milestonesOf(plan)) {
      if (only ? milestone.id !== only : milestone.status === "done" || milestone.status === "canceled") continue;
      const own = counted.filter((t) => milestoneOf(plan, t) === milestone.id);
      result.milestones.push({
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        due: milestone.due ?? "",
        days_left: daysLeft(milestone.due, now),
        done: own.filter((t) => t.status === "done").length,
        total: own.length,
        blocked: own.filter((t) => t.status === "todo" && blockers(plan, t).length > 0).length,
        features: featuresOf(plan)
          .filter((f) => refId(f.milestone) === milestone.id && f.status !== "canceled")
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
          .map(featureLine),
      });
    }
    if (!only) {
      for (const feature of featuresOf(plan)) {
        if (refId(feature.milestone) || feature.status === "done" || feature.status === "canceled") continue;
        const { id, title, done, total } = featureLine(feature);
        result.later.push({ id, title, done, total });
      }
    }
  }
  result.milestones.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  return result;
}

// ---------------------------------------------------------------- inbox.list

type InboxList = RpcOutput<typeof inboxListRpc>;

export async function listInbox(ctx: ReadContext, input: RpcInput<typeof inboxListRpc>): Promise<InboxList> {
  const owner = notOwner(ctx);
  if (owner) return { items: [], total: 0, error: owner };
  const spaces = resolveSpaces(ctx.dashboard, input.space);
  if (!spaces.ok) return { items: [], total: 0, error: spaces.error };
  const filter = await taskFilter(spaces.value, input);
  if (!filter.ok) return { items: [], total: 0, error: filter.error };
  const candidates: Candidate[] = spaces.value.flatMap((space) =>
    [...space.sync.plan.entities.values()]
      .filter((loaded): loaded is LoadedEntity & { entity: Task } => loaded.entity.type === "task" && loaded.entity.status === "inbox" && passes(filter.value, space, loaded.entity))
      .map((loaded) => ({ task: loaded.entity, plan: space.sync.plan, loaded })),
  );
  // With a query, best first; else the order of every task list (sortTasks): by priority, then creation time.
  const found = input.query && parseQuery(input.query) ? searchCandidates(ctx, candidates, input.query, true) : undefined;
  const drafts = (found ? found.hits.map((h) => h.item) : sortTasks(candidates)).map(({ task }) => task);
  const offset = input.offset ?? 0;
  return {
    items: drafts.slice(offset, offset + (input.limit ?? 20)).map((t) => ({
      id: t.id,
      title: t.title,
      project: t.project ?? "",
      meeting_title: t.meeting_title ?? "",
      created: t.created ?? "",
      assignee: t.assignee ?? "",
      labels: t.labels,
    })),
    total: drafts.length,
    ...searchFacts(found),
    error: "",
  };
}

// ---------------------------------------------------------------- tasks.release-check

type ReleaseCheck = RpcOutput<typeof releaseCheckRpc>;

export function releaseCheck(ctx: ReadContext, input: RpcInput<typeof releaseCheckRpc>): ReleaseCheck {
  const empty = { title: "", held_by: "", host: "", since: "" };
  const owner = notOwner(ctx);
  if (owner) return { ...empty, error: owner };
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return { ...empty, error: found.error };
  const task = found.value.entity;
  if (!hasLiveRun(task)) return { ...empty, error: `«${task.title}» (${task.id}) is ${task.status} and has no live run; nothing to release.${unheld(task) ? " Change its status with update_task (todo, done or canceled)." : ""}` };
  return {
    title: task.title,
    held_by: task.run_by ?? "someone",
    host: task.run_host ?? "another machine",
    since: spokenTime(task.run_started, clock(ctx)),
    error: "",
  };
}

// ---------------------------------------------------------------- tasks.start-check

export type StartCheck = RpcOutput<typeof startCheckRpc>;

export interface StartPlan {
  found: FoundEntity<Task>;
  branch: string;
  workspace: BranchPlan extends infer P ? (P extends { ok: true; workspace: infer W } ? W : never) : never;
  /** The workspace's title in Paseo: the previous run's when it is reused, else the new worktree's. */
  workspaceTitle: string;
  /** The previous run's open PR/MR the agent continues. */
  continuesPr?: string;
  /** The start continues an existing branch no run of this task made: the agent reads its work first. */
  continues?: boolean;
  /** The task's run when it was checked; the claim refuses if another run came meanwhile. */
  previousRunId: string | undefined;
  /** The task's project and feature when it was checked; the branch and repository were decided from them. */
  checked: { project: string | undefined; feature: string | undefined };
  /** The base branch: the task's, else the project's trunk from space.yaml; undefined lets Paseo choose. */
  base: string | undefined;
  /** The Paseo project the task's project maps to on this Mac. */
  projectId: string;
  settings: AgentSettings;
  facts: StartCheck;
  /** The tasks it waits for that are not done; a start goes past only those a person agreed to. */
  blocking: { id: string; text: string }[];
  /** The same tasks as the dashboard's confirmation lists them. */
  waits: Wait[];
  /** Each part of the instructions with whether the local user saw it as it is now. */
  instructions: PartFact[];
  parts: InstructionsPart[];
}

export interface StartOptions {
  /**
   * The blocking tasks (ids) a person chose to start past in the dashboard's confirmation, so a
   * blocker added after it showed them still refuses; "all" only for that confirmation's own check,
   * which starts nothing. God Mode never sets it.
   */
  startPast?: string[] | "all";
  /** The agent mode a person picked in the dashboard's confirmation, one of the provider's. God Mode never sets it. */
  mode?: string;
  /** The effort a person picked in the dashboard's confirmation, one of the model's. God Mode never sets it. */
  effort?: string;
  /** The model a person picked in the dashboard's confirmation, one of the provider's. God Mode never sets it. */
  model?: string;
  /**
   * A start nobody asked for by this task alone (Start ready tasks, the autopilot, start_tasks): refused
   * for a task its labels mark as a person's work, also when the claim's fresh fetch is the first to show the label.
   */
  automatic?: boolean;
  /**
   * The network lookups may answer from the last minute: only the dashboard's confirmation sets it,
   * and its start sends what it showed (`StartRequest.shown`) to be checked against a fresh decision.
   */
  cached?: boolean;
  /**
   * For a task that never ran whose planned branch already exists: continue on it, or take the
   * planned name with a suffix (03-model.md, Branch names). Only the dashboard's confirmation sets
   * it; without it such a start is refused and says what the branch holds.
   */
  branch?: "continue" | "fresh";
}

/** A start that cannot go on: why, the facts read so far, and, for an existing branch, what it holds. */
export interface StartRefusal {
  error: string;
  facts: StartCheck;
  blocking: { id: string; text: string }[];
  waits: Wait[];
  existing?: ExistingBranch;
}

/** A task a start waits for, as the start confirmation offers it: its screen, and Start when it can start now. */
export interface Wait {
  id: string;
  title: string;
  status: string;
  glyph: Glyph;
  can_start: boolean;
}

/**
 * The blocking tasks with what the confirmation shows of them. "Can start now" is what the task
 * screen decides from the index (todo, no live run, nothing it waits for, its project mapped here);
 * its own start check says the rest.
 */
function waitsOf(dashboard: Dashboard, plan: Plan, mapping: Record<string, string | null>, blocking: { id: string; text: string }[]): Wait[] {
  return blocking.map(({ id }) => {
    const other = plan.entities.get(id)?.entity;
    if (other?.type !== "task") return { id, title: other?.title ?? "(not found)", status: other?.status ?? "missing", glyph: "blocked", can_start: false };
    const ready = startGroup(plan, other) === 0 && Boolean(other.project && mapping[other.project]);
    return { id, title: other.title, status: other.status, glyph: glyphFor(dashboard, plan, other), can_start: ready };
  });
}

/** The blocking tasks a start may not go past. */
function blockingLeft(blocking: { id: string; text: string }[], options: StartOptions): { id: string; text: string }[] {
  const past = options.startPast ?? [];
  return past === "all" ? [] : blocking.filter((b) => !past.includes(b.id));
}

/**
 * The parts of a task's instructions a start sends to its agent: the brief, acceptance, clarifications
 * and latest handoff, and the space's own start template when it has one (the built-in one ships with the plugin).
 */
export async function instructionsParts(space: SpaceEntry, loaded: LoadedEntity): Promise<InstructionsPart[]> {
  const parts: InstructionsPart[] = [];
  for (const { path, ...part } of instructionTexts(space.sync.root, loaded)) parts.push({ ...part, author: await space.sync.lastAuthor(path) });
  return parts;
}

/** The same parts without their git authors, read at once (the managed queue's checks); `path`: the file of each in the plan. */
export function instructionTexts(root: string, loaded: LoadedEntity): (Omit<InstructionsPart, "author"> & { path: string })[] {
  const template = spaceTemplate(root);
  return [
    {
      key: taskPartKey(loaded.entity.id),
      name: taskPartName(loaded.handoff?.text, loaded.clarifications),
      text: taskInstructions(loaded.brief, loaded.acceptance.map((a) => a.text), loaded.handoff?.text, loaded.clarifications),
      path: loaded.path,
    },
    ...(template === undefined ? [] : [{ key: TEMPLATE_PART, name: "the space's start template", text: template, path: "templates/start-prompt.md" }]),
  ];
}

/**
 * Whether a task can be started from this Mac now, and what a start would do. Shared by the read and
 * by `tasks.start`, so the start refuses exactly what the check reports.
 */
export async function planStart(
  ctx: ReadContext,
  input: RpcInput<typeof startCheckRpc>,
  options: StartOptions = {},
): Promise<StartPlan | StartRefusal> {
  const facts: StartCheck = { title: "", project: "", branch: "", workspace: "", profile: "", mode: "", instructions: "", issue: "", human: "", error: "", decision: "", next: "", waits_for: "", asks_first: true };
  let blocking: { id: string; text: string }[] = [];
  let waits: Wait[] = [];
  const fail = (error: string, existing?: ExistingBranch): StartRefusal => ({ error, facts: { ...facts, error }, blocking, waits, ...(existing ? { existing } : {}) });
  const owner = notOwner(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space, loaded } = found.value;
  const plan = space.sync.plan;
  const name = `«${task.title}» (${task.id})`;
  facts.title = task.title;
  facts.project = task.project ?? "";
  const human = humanWork(plan, task);
  // Merged work or a recorded requirement holds it like a label does (start-verdict.ts ownerGate).
  const gate = human ? undefined : ownerGate(ctx.dashboard, plan, task);
  const held = human || gate?.reason || "";
  // Said in every read-back of the start: a start of this task alone stays possible.
  if (held) facts.human = cut(`${held[0]!.toUpperCase()}${held.slice(1)}: an agent starts it only because this one task was asked for`, HUMAN_WORK_CHARS);

  if (hasLiveRun(task)) {
    return fail(`${name} is already started by ${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"} since ${spokenTime(task.run_started, clock(ctx))}.`);
  }
  if (!startable(task)) return fail(`${name} is ${task.status}, not todo; only a todo task can start.`);
  // Unheld (in progress with no live run, 03-model.md, Statuses): a person decides what became of it,
  // so only a start someone asked for claims it again, never the autopilot.
  if (options.automatic && task.status !== "todo") return fail(`${name} is ${task.status} with no live run; only a person starts it again.`);
  if (options.automatic && held) return fail(`${name}: ${held}.`);
  blocking = blockingTasks(plan, task);
  waits = waitsOf(ctx.dashboard, plan, space.record.mapping, blocking);
  const left = blockingLeft(blocking, options);
  if (left.length) return fail(`${name} is blocked by ${left.map((b) => b.text).join("; ")}.`);
  if (!task.project) return fail(`${name} has no project.`);
  if (!space.sync.plan.space?.projects[task.project]) return fail(`${name} names project ${task.project}, which ${space.record.name} does not list.`);
  const projectId = space.record.mapping[task.project];
  if (!projectId) {
    return fail(`Project ${task.project} is not mapped on this Mac: no Paseo project here has its remote. Open it in Paseo first.`);
  }
  const planned = plannedBranch(plan, task);
  if (!SAFE_BRANCH.test(planned)) return fail(`The branch name ${JSON.stringify(planned)} is not usable; set the task's branch.`);

  const paseo = ctx.dashboard.paseo;
  if (!paseo) return fail("Paseo has not connected to Paseo Dash yet; open Paseo on this Mac and try again.");
  const base = task.base ?? space.sync.plan.space?.projects[task.project]?.trunk;
  const usableBase = !base || SAFE_BRANCH.test(base);
  const project = task.project;

  // The one place a check leaves the in-memory index: git and the forge decide the branch. The
  // agent settings, the branch and the instructions do not depend on one another, so they are read
  // at once; their objections are then said in the order they always were.
  const deciding = async () => {
    const host = ctx.host ?? localHost();
    const previousRun = task.run_id ? ctx.dashboard.runs?.runs.get(task.run_id) : undefined;
    // God Mode may start tasks before any Paseo client said hello: the checkout paths come from Paseo.
    if (!ctx.dashboard.projectRoots.has(projectId)) {
      ctx.dashboard.addProjectRoots(await localProjects(paseo).catch(() => []));
    }
    const root = ctx.dashboard.projectRoots.get(projectId);
    const [previous, trunks, defaultBranch] = await Promise.all([
      previousWorkspace(paseo, previousRun),
      trunkNames(ctx.dashboard.git, root, [base, space.sync.plan.space?.projects[project]?.trunk, previousRun?.adopted?.trunk]),
      // The default branch as the checkout knows it: the forge closes issues only for merges into it.
      task.issue && root ? originHead(ctx.dashboard.git, root).catch(() => undefined) : undefined,
    ]);
    const decided = await decideBranch({
      task,
      planned,
      root,
      remote: space.sync.plan.space!.projects[project]!.remote,
      host,
      git: ctx.dashboard.git,
      forge: ctx.dashboard.forge,
      previous,
      trunks,
      cache: ctx.dashboard.startLookups,
      reuseLookups: Boolean(options.cached),
      existing: options.branch,
    });
    return { decided, previous, defaultBranch };
  };
  // This Mac's start defaults (Settings → Autopilot) sit below the profile's and above the provider's.
  const macStart = ctx.dashboard.autopilot?.startDefaults();
  const [choice, branching, parts] = await Promise.all([
    ctx.dashboard.profiles.choose(paseo, {
      asked: input.profile,
      task: task.agent_profile,
      space: space.sync.plan.space?.defaults.agent_profile,
      mode: { asked: options.mode, space: space.sync.plan.space?.defaults.mode, mac: macStart && { id: macStart.mode, provider: macStart.mode_provider } },
      effort: options.effort,
      macEffort: macStart?.effort,
      model: options.model,
      // The same pick for the confirmation, the autopilot and God Mode (server/runner/model-policy.ts); on until this Mac turns it off.
      policy: macStart?.auto_model === false ? undefined : pickForTask(taskSignals(task, loaded)),
    }),
    usableBase ? deciding() : undefined,
    instructionsParts(space, loaded),
  ]);
  if (!choice.ok) return fail(choice.error);
  if (!branching) return fail(`The base branch ${JSON.stringify(base)} is not usable; fix it in space.yaml or on the task.`);
  const { decided, previous, defaultBranch } = branching;
  if (!decided.ok) return fail(decided.error, decided.existing);
  const branch = decided.branch;

  facts.branch = decided.note ? `${branch} (${decided.note})` : branch;
  const workspaceTitle = decided.workspace.kind === "reuse" ? previous?.title || `${task.project}:${branch}` : agentTitle(task);
  facts.workspace = decided.workspace.kind === "reuse" ? `the previous run's workspace «${workspaceTitle}»` : `a new worktree, «${workspaceTitle}»`;
  // God Mode reads the model in the agent's fact: the profile alone no longer names it.
  facts.profile = `${choice.settings.label}; model ${choice.settings.model}`;
  // Said in the facts God Mode reads back too: a start in such a mode waits for a person at once.
  // God Mode shows at most 8 fields of a read-back, all taken: the effort is said with the mode.
  const mode = choice.settings.asks ? `${choice.settings.mode}; it stops for the user's approval, so the agent waits for the user` : choice.settings.mode;
  facts.mode = `${mode}; effort ${choice.settings.effort}`;
  if (task.issue) facts.issue = closureFact({ task, project: space.sync.plan.space!.projects[project], defaultBranch });
  const instructions =
    ctx.dashboard.seen?.facts(space.record.key, parts) ??
    parts.map((part): PartFact => ({ key: part.key, name: part.name, hash: hashText(part.text), state: "unseen", author: part.author, diff: [] }));
  facts.instructions = factText(instructions);
  return {
    found: found.value as FoundEntity<Task>,
    branch,
    base,
    projectId,
    settings: choice.settings,
    workspace: decided.workspace,
    workspaceTitle,
    continuesPr: decided.continuesPr,
    ...(decided.continues ? { continues: true } : {}),
    previousRunId: task.run_id,
    checked: { project: task.project, feature: refId(task.feature) },
    facts,
    blocking,
    waits,
    instructions,
    parts,
  };
}

/**
 * The checks of `planStart` that the claim itself does not make, run again by the claim on the state
 * it just fetched (the index they were first made on may be a fetch interval old).
 */
export function startObjection(
  plan: Plan,
  taskId: string,
  previousRunId: string | undefined,
  options: StartOptions = {},
  checked?: StartPlan["checked"],
): string | undefined {
  const task = plan.entities.get(taskId)?.entity;
  if (!task || task.type !== "task") return `${taskId} is no longer a task`;
  // Someone else's live run: the claim itself answers "already started by …", the reason that matters.
  if (hasLiveRun(task)) return undefined;
  const human = options.automatic ? humanWork(plan, task) : "";
  if (human) return `«${task.title}» (${task.id}): ${human}.`;
  const left = blockingLeft(blockingTasks(plan, task), options);
  if (left.length) return `«${task.title}» (${task.id}) is blocked by ${left.map((b) => b.text).join("; ")}.`;
  // The branch was decided from the run seen at the check; another run since means another decision.
  if (task.run_id !== previousRunId) return `«${task.title}» (${task.id}) was started and released elsewhere since it was checked; check it again.`;
  // A move since the check: the worktree would be made in the old repository or on the old branch.
  if (checked && (task.project !== checked.project || refId(task.feature) !== checked.feature)) {
    return `«${task.title}» (${task.id}) was moved to another ${task.project !== checked.project ? "project" : "feature"} since it was checked; check it again.`;
  }
  return undefined;
}

/** The previous run's workspace on this machine, when Paseo still has it, with its agent's status. */
async function previousWorkspace(paseo: PaseoApi, run: RunRecord | undefined): Promise<PreviousWorkspace | undefined> {
  if (!run?.workspaceId) return undefined;
  const workspace = await paseo.workspaces.ref(run.workspaceId).refresh().catch(() => null);
  // Only a live workspace still on the run's branch: a failed start's stray workspace is never reused.
  if (!workspace || workspace.archivingAt || workspace.gitRuntime?.currentBranch !== run.branch) return undefined;
  // A tracked run may have been a person's own checkout: its kind decides whether it may be reused.
  const kind = (workspace as { workspaceKind?: string }).workspaceKind ?? run.adopted?.kind;
  // A refresh that fails cannot tell whether the agent still works; null means it is gone.
  const agent = run.agentId ? await paseo.agents.ref(run.agentId).refresh().catch(() => "unknown" as const) : null;
  const title = workspace.title || workspace.name || undefined;
  if (agent === "unknown") return { workspaceId: run.workspaceId, agentStatus: "unknown", kind, title };
  return { workspaceId: run.workspaceId, agentStatus: agent?.agent.archivedAt ? undefined : (agent?.agent.status ?? undefined), kind, title };
}

/**
 * The facts God Mode reads back before a start, with what a start does now (start_plan's decision for
 * a set of this one task): the read-back's shown fields stay as they were, these only add to them.
 */
export async function startCheck(ctx: ReadContext, input: RpcInput<typeof startCheckRpc>): Promise<StartCheck> {
  const checked = await planStart(ctx, input);
  // God Mode shows at most 8 fields of a read-back: the label goes first into `issue`, the sentence
  // just before "Start it?", and stays in the first 200 characters it keeps of a field.
  const facts = checked.facts.human ? { ...checked.facts, issue: [`${checked.facts.human}.`, checked.facts.issue].filter(Boolean).join(" ") } : checked.facts;
  const plan = { ...checked, facts };
  const asks_first = !startWithoutAsking(ctx.dashboard.dataDir);
  // A task marked as a person's work can start, but only on its own: start_plan's decision says so.
  // An unheld task (in progress with no live run) says why a start is allowed: it claims the task again.
  if ("found" in plan && !plan.facts.human) {
    const task = plan.found.entity;
    return { ...plan.facts, decision: "can_start", next: unheld(task) ? UNHELD_REASON(task.status) : "", waits_for: "", asks_first };
  }
  const found = notOwner(ctx) ? undefined : resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found?.ok) return { ...plan.facts, decision: "refused", next: "nothing starts until this is fixed: tell the user the reason", asks_first };
  // A blocked task's other objections come only from a check past its blockers.
  const past = plan.blocking.length ? await planStart(ctx, input, { startPast: "all", cached: true }) : plan;
  const item = { plan: found.value.space.sync.plan, task: found.value.entity, refusal: "found" in past ? "" : past.error };
  const verdict = decideSet(ctx.dashboard, ctx.host ?? localHost(), [item]).get(found.value.entity.id)!;
  return { ...plan.facts, decision: verdict.decision, next: verdict.next, waits_for: waitsText(verdict.waits_for), asks_first };
}

/** An existing branch as the start confirmation shows it. */
function existingFacts(existing: ExistingBranch): NonNullable<RpcOutput<typeof uiStartCheckRpc>["existing"]> {
  const { pr } = existing;
  return {
    branch: existing.branch,
    where: existing.where,
    ...(existing.merged === undefined ? {} : { merged: existing.merged }),
    ...(pr ? { pr: { label: pr.label, url: pr.url, state: pr.state, merged_at: pr.mergedAt ?? "" } } : {}),
    in_trunk: existing.inTrunk ?? "",
    fresh: existing.fresh,
    cannot_continue: existing.cannotContinue,
  };
}

/** The dashboard's start confirmation: God Mode's facts plus the blocking tasks and the diffs. */
export async function uiStartCheck(ctx: ReadContext, input: RpcInput<typeof uiStartCheckRpc>): Promise<RpcOutput<typeof uiStartCheckRpc>> {
  const plan = await planStart(ctx, input, { startPast: input.anyway ? "all" : [], mode: input.mode, effort: input.effort, model: input.model, cached: true, branch: input.branch });
  const settings = "found" in plan ? plan.settings : undefined;
  return {
    ...plan.facts,
    // The dialog shows the effort on its own line: the mode alone here.
    mode: settings ? plan.facts.mode.slice(0, plan.facts.mode.lastIndexOf(`; effort ${settings.effort}`)) : plan.facts.mode,
    mode_id: settings?.modeId ?? "",
    modes: settings?.modes ?? [],
    mode_asks: settings?.asks ?? false,
    effort: settings?.effort ?? "",
    effort_id: settings?.thinkingOptionId ?? "",
    efforts: settings?.efforts ?? [],
    model: settings?.model ?? "",
    model_id: settings?.modelId ?? "",
    models: settings?.models ?? [],
    profiles: settings?.profiles ?? [],
    blocked_by: plan.blocking.map((b) => b.text),
    blocked_ids: plan.blocking.map((b) => b.id),
    waits: plan.waits,
    parts: "found" in plan ? plan.instructions : [],
    existing: "found" in plan || !plan.existing ? null : existingFacts(plan.existing),
  };
}

/** For a task whose run here changes files another task's run here also changes: "ERG-X: a.ts, b.ts; ERG-Y: c.ts". */
function sharesFiles(ctx: ReadContext, task: string): { shares_files_with?: string } {
  const shared = overlapsByTask(ctx.dashboard).get(task);
  return shared?.length ? { shares_files_with: shared.map(overlapText).join("; ") } : {};
}
