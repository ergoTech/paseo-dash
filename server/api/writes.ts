import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { userInfo } from "node:os";
import type {
  featuresCreateRpc,
  featuresUpdateRpc,
  inboxAddRpc,
  milestonesCreateRpc,
  milestonesUpdateRpc,
  tasksCreateRpc,
  tasksReleaseRpc,
  tasksStartRpc,
  tasksUpdateRpc,
} from "../../shared/api.ts";
import type { tasksArchiveRpc, tasksArchiveWorkspaceRpc, tasksContinueRpc, tasksRankRpc, tasksSeenRpc, uiMoveRpc } from "../../shared/ui.ts";
import { leftWorkspaces } from "../views.ts";
import { closed, deliverySchema, type Entity, type EntityType, type Feature, hasLiveRun, lineLocked, type Milestone, refId, type Task, unheld } from "../../shared/model.ts";
import { dependencyLoop } from "../plan/dependencies.ts";
import { briefHash, clarificationEntry, isLastClarification, taskBody } from "../plan/document.ts";
import { newId, opaqueId } from "../plan/ids.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import type { Plan } from "../plan/load.ts";
import { type Operation, type Outcome, PERSON_STATUS, taskWithIssue } from "../sync/ops.ts";
import { ISSUE_RULE, issueKey, parseIssueUrl } from "../../shared/issues.ts";
import { planStart, type ReadContext, type StartOptions, startObjection } from "./reads.ts";
import { cleanLabel, findLabel, findPerson, LABEL_RULE, nextLabelColor, sameLabel } from "../../shared/labels.ts";
import {
  type FoundEntity,
  resolveCreateSpace,
  resolveEntity,
  resolvePerson,
  resolveProject,
  resolveSpaces,
  type Resolved,
  type SpaceEntry,
  wikilink,
  words,
} from "./resolve.ts";
import { newToken } from "../agent-tools/bridge.ts";
import { agentTitle, buildPrompt } from "../runner/prompt.ts";
import { hashText, taskInstructions, taskPartKey, TEMPLATE_PART } from "../runner/seen.ts";
import { startWithoutAsking } from "../godmode-settings.ts";
import { type CreatedBy, startNew } from "../auto-start.ts";
import { localHost, localRun, PRIORITY_ORDER, priorityRank, spokenTime, tasksOf } from "./view.ts";
import { rankOps, type RankPosition } from "./rank.ts";

/**
 * The plan's writes (06-god-mode.md, Actions). Each validates what it names, turns the request into
 * journaled operations and answers once they are applied locally; the push to the plan repo follows
 * in the background, and a later conflict shows in `overview`.
 */

/** How long a release waits for its agent's stop before answering; the stop goes on after it. */
const STOP_WAIT_MS = 4_000;

/** How long a write waits for the space's queue before answering "unknown" (Paseo stops at 30 s). */
const WRITE_WAIT_MS = 20_000;

export interface WriteContext extends ReadContext {
  writeWaitMs?: number;
}

/** Whether the write took effect is not known yet: the next fetches decide it. */
export class Unknown extends Error {}

/**
 * Records operations in one space and returns their outcomes. When the space is busy for too long the
 * operations stay queued, and the call throws, which God Mode reports as "unknown whether it took
 * effect"; the next read shows what happened.
 */
export async function record(ctx: WriteContext, space: SpaceEntry, ops: Operation[]): Promise<Map<string, Outcome>> {
  const { outcomes, forget } = space.sync.record(ops);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ctx.writeWaitMs ?? WRITE_WAIT_MS);
  });
  try {
    const result = await Promise.race([outcomes, late]);
    if (result === "late") {
      forget();
      throw new Unknown(`${space.record.name}'s plan is busy syncing; the change is queued and the next read shows whether it applied`);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text that goes under `## Brief` (or a draft's note). A level-1 or level-2 heading inside it would
 * end the section and could even start a fake `## Acceptance`, so those headings move down a level.
 */
export function briefText(text: string): string {
  return text.replace(/^#{1,2}(?=[ \t])/gm, "###");
}

export function refusal(outcome: Outcome | undefined): string | undefined {
  if (!outcome) return "not applied yet; it stays queued";
  if (outcome.status === "refused" || outcome.status === "dropped") return outcome.reason;
  return undefined;
}

export function ownerError(ctx: ReadContext): string {
  return ctx.dashboard.owner ? "" : ctx.dashboard.ownerReason || "Paseo Dash has not started";
}

function within<E extends Entity>(space: SpaceEntry, type: E["type"], asked: string): Resolved<FoundEntity<E>> {
  return resolveEntity([space], type, asked) as Resolved<FoundEntity<E>>;
}

/** A reference to resolve in the same space as the thing being written, as a wikilink. */
function link(space: SpaceEntry, type: EntityType, asked: string): Resolved<string> {
  const found = within(space, type, asked);
  return found.ok ? { ok: true, value: wikilink(found.value) } : found;
}

function create(space: SpaceEntry, type: EntityType, fields: Record<string, unknown>, body: string, taken: Set<string>): Operation {
  const id = newId(space.record.key, taken);
  taken.add(id);
  // The plugin writes only the fields that have a value (03-model.md).
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""));
  return { op_id: opaqueId("op"), kind: "create", type, id, fields: present, body };
}

function set(entity: Entity, field: string, value: unknown): Operation {
  return { op_id: opaqueId("op"), kind: "set", id: entity.id, field, value, expect: (entity as Record<string, unknown>)[field] };
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Set operations for the fields that change, with the field names. */
function changes(entity: Entity, wanted: Record<string, unknown>): { ops: Operation[]; fields: string[] } {
  const ops: Operation[] = [];
  const fields: string[] = [];
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    if (same((entity as Record<string, unknown>)[field], value)) continue;
    ops.push(set(entity, field, value));
    fields.push(field);
  }
  return { ops, fields };
}

/**
 * The labels asked for, spelled as the palette spells them. A label the palette lacks is defined in
 * the same commit: a `label_def` with the next palette color is added to `defs`, to be journaled
 * before the writes that use it (09-forge-issues.md, Labels for tasks).
 */
function labelsFor(space: SpaceEntry, asked: string[], defs: Operation[]): Resolved<string[]> {
  const palette = space.sync.plan.space?.labels ?? {};
  const pending = defs.filter((op): op is Extract<Operation, { kind: "label_def" }> => op.kind === "label_def");
  const out: string[] = [];
  for (const raw of asked) {
    let name = findLabel(palette, raw.trim())?.[0];
    if (name === undefined) {
      const clean = cleanLabel(raw);
      if (!clean) return { ok: false, error: `«${raw.trim()}» is not a usable label: ${LABEL_RULE}.` };
      const earlier = pending.find((op) => sameLabel(op.name, clean));
      name = earlier?.name ?? clean;
      if (!earlier) {
        const color = nextLabelColor(palette, pending.flatMap((op) => (op.value?.color ? [op.value.color] : [])));
        const def: Extract<Operation, { kind: "label_def" }> = { op_id: opaqueId("op"), kind: "label_def", name, value: { color }, expect: null, if_absent: true };
        pending.push(def);
        defs.push(def);
      }
    }
    if (!out.some((label) => sameLabel(label, name))) out.push(name);
  }
  return { ok: true, value: out };
}

/**
 * An issue link as a task stores it: the forge's URL in one form. Empty asks for no link; a task
 * that already carries the issue is named, since one issue is one task (09-forge-issues.md).
 */
function issueFor(space: SpaceEntry, asked: string | undefined, self?: string): Resolved<string | undefined> {
  if (asked === undefined || asked.trim() === "") return { ok: true, value: undefined };
  const ref = parseIssueUrl(asked);
  if (!ref) return { ok: false, error: `«${asked.trim()}» is not ${ISSUE_RULE}.` };
  const carrier = taskWithIssue(space.sync.plan, issueKey(ref.url)!);
  if (carrier && carrier.id !== self) return { ok: false, error: `«${carrier.title}» (${carrier.id}) already carries the issue ${ref.url}.` };
  return { ok: true, value: ref.url };
}

/** Resolves a list of task names in the space into wikilinks. */
function taskLinks(space: SpaceEntry, asked: string[], self?: string, selfError = "a task cannot depend on itself"): Resolved<string[]> {
  const out: string[] = [];
  for (const name of asked) {
    const found = within<Task>(space, "task", name);
    if (!found.ok) return found;
    if (found.value.entity.id === self) return { ok: false, error: selfError };
    out.push(wikilink(found.value));
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- inbox.add

type InboxAdd = RpcOutput<typeof inboxAddRpc>;

/** A Laconote meeting link, `<web URL>/meeting/<id>`, is provenance; any other URL is a plain link. */
const MEETING_URL = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?\/meeting\/[A-Za-z0-9_-]+\/?$/;

export function normalTitle(title: string): string {
  return words(title).join(" ");
}

/** One inbox draft to create; `brief` is its text before the body's sections are added. */
export interface Draft {
  title: string;
  brief: string;
  project?: string;
  priority?: Task["priority"];
  links?: string[];
  labels?: string[];
  /** Who should do it, as the source names them: becomes `assignee` when a person of the space has that key or name. */
  owner?: string;
  /** The forge issue it stands for, as parsed (`IssueRef.url`): a task already carrying it is that draft. */
  issue?: string;
}

export type DraftsAdded = InboxAdd & {
  /** Drafts not made because a task already carries their issue, with that task's id. */
  carried: { title: string; id: string }[];
};

/** Where drafts come from, and which existing tasks came from the same place. */
export interface DraftSource {
  meeting?: string;
  meeting_title?: string;
  same: (task: Pick<Task, "meeting" | "meeting_title" | "links">) => boolean;
}

export async function addToInbox(ctx: WriteContext, input: RpcInput<typeof inboxAddRpc>): Promise<InboxAdd> {
  const fail = (error: string): InboxAdd => ({ ok: false, created: [], skipped: [], error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const spaceFound = resolveCreateSpace(ctx.dashboard, input.space);
  if (!spaceFound.ok) return fail(spaceFound.error);
  const space = spaceFound.value;

  const projects: (string | undefined)[] = [];
  for (const item of input.items) {
    if (!item.project) {
      projects.push(undefined);
      continue;
    }
    const project = resolveProject(space, item.project);
    if (!project.ok) return fail(`«${item.title}»: ${project.error}`);
    projects.push(project.value);
  }

  const issues: (string | undefined)[] = [];
  for (const item of input.items) {
    const ref = item.issue ? parseIssueUrl(item.issue) : undefined;
    if (item.issue && !ref) return fail(`«${item.title}»: «${item.issue}» is not ${ISSUE_RULE}.`);
    issues.push(ref?.url);
  }

  const meeting = input.source_url && MEETING_URL.test(input.source_url) ? input.source_url.replace(/\/+$/, "") : undefined;
  const link_ = input.source_url && !meeting ? input.source_url : undefined;
  // The same title from the same source is the same draft: asking twice does not duplicate it.
  const same = (task: Pick<Task, "meeting" | "links">) =>
    meeting ? task.meeting === meeting : link_ ? !task.meeting && task.links.includes(link_) : !task.meeting && task.links.length === 0;
  const drafts = input.items.map((item, index) => ({
    title: item.title,
    brief: item.note ?? "",
    project: projects[index],
    links: link_ ? [link_] : undefined,
    labels: item.labels,
    issue: issues[index],
  }));
  const { carried: _carried, ...added } = await addDrafts(ctx, space, drafts, { meeting, meeting_title: input.source_title, same });
  return added;
}

/**
 * Creates inbox drafts in one space. A draft whose title an open task from the same source already
 * has, or a create still waiting in the journal, is skipped and named in `skipped`; so is one whose
 * issue a task (any status) or a waiting create already carries, also named in `carried`.
 */
export async function addDrafts(ctx: WriteContext, space: SpaceEntry, drafts: Draft[], source: DraftSource): Promise<DraftsAdded> {
  const existing = new Set(
    tasksOf(space.sync.plan)
      .filter((t) => t.status !== "done" && t.status !== "canceled" && source.same(t))
      .map((t) => normalTitle(t.title)),
  );
  // Drafts recorded but not applied yet (a retry after an "unknown" answer) count too. Nothing below
  // awaits before `record` journals the new ones, so concurrent calls see each other's drafts.
  // The issues tasks carry, any status, and those of creates still waiting: by issue key.
  const carriers = new Map<string, string>();
  for (const task of tasksOf(space.sync.plan)) {
    const key = issueKey(task.issue);
    if (key && !carriers.has(key)) carriers.set(key, task.id);
  }
  for (const op of space.sync.pendingCreates()) {
    const fields = op.fields as { title?: string; meeting?: string; meeting_title?: string; links?: string[]; issue?: string };
    const pending = { meeting: fields.meeting, meeting_title: fields.meeting_title, links: fields.links ?? [] };
    if (op.type === "task" && source.same(pending)) existing.add(normalTitle(String(fields.title ?? "")));
    const key = op.type === "task" ? issueKey(fields.issue) : undefined;
    if (key && !carriers.has(key)) carriers.set(key, op.id);
  }

  const taken = space.sync.takenIds();
  const defs: Operation[] = [];
  const ops: Operation[] = [];
  const skipped: string[] = [];
  const carried: { title: string; id: string }[] = [];
  const people = space.sync.plan.space?.people ?? {};
  for (const draft of drafts) {
    const issue = issueKey(draft.issue);
    const carrier = issue ? carriers.get(issue) : undefined;
    if (carrier) {
      skipped.push(draft.title);
      carried.push({ title: draft.title, id: carrier });
      continue;
    }
    const key = normalTitle(draft.title);
    // An issue's draft is told apart by its issue, not its title: two issues may share a title.
    if (!issue && existing.has(key)) {
      skipped.push(draft.title);
      continue;
    }
    existing.add(key);
    const labels = labelsFor(space, draft.labels ?? [], defs);
    if (!labels.ok) return { ok: false, created: [], skipped: [], carried: [], error: `«${draft.title}»: ${labels.error}` };
    ops.push(
      create(
        space,
        "task",
        {
          title: draft.title,
          status: "inbox",
          project: draft.project,
          priority: draft.priority,
          assignee: draft.owner ? findPerson(people, draft.owner) : undefined,
          labels: labels.value.length ? labels.value : undefined,
          meeting: source.meeting,
          meeting_title: source.meeting_title,
          issue: draft.issue,
          links: draft.links?.length ? draft.links : undefined,
        },
        `\n${taskBody(briefText(draft.brief), [])}`,
        taken,
      ),
    );
    const id = (ops.at(-1) as Extract<Operation, { kind: "create" }>).id;
    if (issue) carriers.set(issue, id);
  }
  if (ops.length === 0) return { ok: true, created: [], skipped, carried, error: "" };

  const outcomes = await record(ctx, space, [...defs, ...ops]);
  const created: { id: string; title: string }[] = [];
  const problems: string[] = [];
  for (const op of ops as Extract<Operation, { kind: "create" }>[]) {
    const outcome = outcomes.get(op.op_id);
    const reason = refusal(outcome);
    if (reason) problems.push(`«${String(op.fields.title)}»: ${reason}`);
    else if (outcome?.status === "already" && outcome.id) {
      // Another machine's draft for the same issue landed first.
      skipped.push(String(op.fields.title));
      carried.push({ title: String(op.fields.title), id: outcome.id });
    } else created.push({ id: op.id, title: String(op.fields.title) });
  }
  return { ok: problems.length === 0, created, skipped, carried, error: problems.join("; ") };
}

// ---------------------------------------------------------------- tasks.create

type TaskCreate = RpcOutput<typeof tasksCreateRpc>;

/** A profile is named as this Mac's Paseo has it, so a typo is refused when it is written and not at the task's start. */
async function knownProfile(ctx: WriteContext, asked: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const paseo = ctx.dashboard.paseo;
  if (!paseo) return { ok: false, error: "Paseo is not connected yet; try again in a moment." };
  let known: { name: string }[];
  try {
    known = (await ctx.dashboard.profiles.load(paseo)).profiles;
  } catch (error) {
    return { ok: false, error: `The agent profiles of this Mac could not be read: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const found = known.find(({ name }) => name.toLowerCase() === asked.toLowerCase());
  if (found) return { ok: true, name: found.name };
  return { ok: false, error: `There is no agent profile «${asked}» on this Mac${known.length ? `; profiles: ${known.map(({ name }) => name).join(", ")}` : ""}.` };
}

/**
 * `by`: who asks. Only the dashboard's own RPC (ui.tasks.create) says "dashboard"; tasks.create, which
 * God Mode calls, is "chatgpt", whatever the caller sends (server/auto-start.ts).
 */
export async function createTask(ctx: WriteContext, input: RpcInput<typeof tasksCreateRpc>, by: CreatedBy = "chatgpt"): Promise<TaskCreate> {
  const fail = (error: string): TaskCreate => ({ ok: false, id: "", title: input.title, status: "", start: "", start_note: "", error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const spaceFound = resolveCreateSpace(ctx.dashboard, input.space);
  if (!spaceFound.ok) return fail(spaceFound.error);
  const space = spaceFound.value;

  let project: string | undefined;
  if (input.project) {
    const found = resolveProject(space, input.project);
    if (!found.ok) return fail(found.error);
    project = found.value;
  }
  const status = input.status ?? (project ? "todo" : "inbox");
  if (status === "todo" && !project) return fail("A todo task needs a project; give one, or create it as an inbox draft.");
  const feature = input.feature ? link(space, "feature", input.feature) : undefined;
  if (feature && !feature.ok) return fail(feature.error);
  const milestone = input.milestone ? link(space, "milestone", input.milestone) : undefined;
  if (milestone && !milestone.ok) return fail(milestone.error);
  const depends = input.depends_on?.length ? taskLinks(space, input.depends_on) : undefined;
  if (depends && !depends.ok) return fail(depends.error);
  const defs: Operation[] = [];
  const labels = labelsFor(space, input.labels ?? [], defs);
  if (!labels.ok) return fail(labels.error);
  const issue = issueFor(space, input.issue);
  if (!issue.ok) return fail(issue.error);
  // Written with the task, so a start queued by this create already uses it.
  const asked = input.agent_profile?.trim();
  const profile = asked ? await knownProfile(ctx, asked) : undefined;
  if (profile && !profile.ok) return fail(`${profile.error} Nothing was created.`);

  const op = create(
    space,
    "task",
    {
      title: input.title,
      status,
      project,
      feature: feature?.ok ? feature.value : undefined,
      milestone: milestone?.ok ? milestone.value : undefined,
      priority: input.priority ?? space.sync.plan.space?.defaults.priority,
      labels: labels.value.length ? labels.value : undefined,
      depends_on: depends?.ok ? depends.value : undefined,
      issue: issue.value,
      agent_profile: profile?.name,
    },
    `\n${taskBody(briefText(input.brief ?? ""), input.acceptance ?? [])}`,
    space.sync.takenIds(),
  );
  const outcomes = await record(ctx, space, [...defs, op]);
  const outcome = outcomes.get(op.op_id);
  const reason = refusal(outcome);
  if (reason) return fail(reason);
  if (outcome?.status === "already" && outcome.id) return fail(`${outcome.id} already carries the issue ${issue.value}; nothing was created.`);
  const id = (op as Extract<Operation, { kind: "create" }>).id;
  // The task is made: a failure to ask for its start is said, never turned into a failed create.
  const start = await startNew(ctx, space, id, by, input.start).catch((error: unknown) => ({ start: "waits" as const, note: `not started: ${String((error as Error)?.message ?? error)}` }));
  return { ok: true, id, title: input.title, status, start: start.start, start_note: start.note, error: "" };
}

// ---------------------------------------------------------------- tasks.update

type TaskUpdate = RpcOutput<typeof tasksUpdateRpc>;

function heldBy(task: Task, now: Date): string {
  return `held by ${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"} since ${spokenTime(task.run_started, now)}`;
}

export async function updateTask(ctx: WriteContext, input: RpcInput<typeof tasksUpdateRpc>): Promise<TaskUpdate> {
  const fail = (error: string, task?: Task): TaskUpdate => ({
    ok: false,
    id: task?.id ?? "",
    title: task?.title ?? "",
    status: task?.status ?? "",
    changed: [],
    error,
  });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space, loaded } = found.value;
  const now = (ctx.now ?? (() => new Date()))();

  if (input.status && input.status !== task.status && hasLiveRun(task)) {
    return fail(`«${task.title}» (${task.id}) is ${heldBy(task, now)}; use release_task.`, task);
  }
  let project: string | undefined;
  if (input.project) {
    const p = resolveProject(space, input.project);
    if (!p.ok) return fail(p.error, task);
    project = p.value;
  }
  if (project && project !== task.project) {
    const locked = lineLocked(task);
    if (locked) return fail(`${locked} Nothing was changed.`, task);
  }
  // The transition table is checked before anything is recorded, so a refusable request changes nothing.
  if (input.status && input.status !== task.status) {
    if (!PERSON_STATUS[task.status].includes(input.status)) {
      return fail(`«${task.title}» (${task.id}) is ${task.status}; ${task.status} → ${input.status} is not allowed. Nothing was changed.`, task);
    }
    if (task.status === "inbox" && input.status === "todo" && !(project ?? task.project)) {
      return fail(`«${task.title}» (${task.id}) needs a project before it is accepted; give one with it. Nothing was changed.`, task);
    }
  }
  const feature = input.feature ? link(space, "feature", input.feature) : undefined;
  if (feature && !feature.ok) return fail(feature.error, task);
  const milestone = input.milestone ? link(space, "milestone", input.milestone) : undefined;
  if (milestone && !milestone.ok) return fail(milestone.error, task);
  const depends = input.depends_on ? taskLinks(space, input.depends_on, task.id) : undefined;
  if (depends && !depends.ok) return fail(depends.error, task);
  const loop = depends?.ok ? dependencyLoop(space.sync.plan, task.id, depends.value) : undefined;
  if (loop) return fail(`«${task.title}» (${task.id}) cannot wait for ${loop.join(" → ")}: that already waits for it, a loop of dependencies. Nothing was changed.`, task);
  const assignee = input.assignee ? resolvePerson(space, input.assignee) : undefined;
  if (assignee && !assignee.ok) return fail(assignee.error, task);
  // A move is computed among the tasks the task stands with now; a change of its group comes first, alone.
  const regroups = input.status && input.status !== task.status ? "status" : input.priority && PRIORITY_ORDER[input.priority] !== priorityRank(space.sync.plan, task) ? "priority" : input.depends_on ? "dependencies" : "";
  if (input.position && regroups) {
    return fail(`«${task.title}» (${task.id}): change the ${regroups} first, then move it among the tasks it then stands with. Nothing was changed.`, task);
  }
  const placed = input.position ? placeTask(space, task, input.position, input.next_to) : undefined;
  if (placed && !placed.ok) return fail(placed.error, task);
  const defs: Operation[] = [];
  const added = labelsFor(space, input.add_labels ?? [], defs);
  if (!added.ok) return fail(added.error, task);
  const issue = input.issue === undefined ? undefined : issueFor(space, input.issue, task.id);
  if (issue && !issue.ok) return fail(issue.error, task);
  const duplicate = input.duplicate_of ? taskLinks(space, [input.duplicate_of], task.id, "a task cannot duplicate itself") : undefined;
  if (duplicate && !duplicate.ok) return fail(duplicate.error, task);
  if (duplicate && (input.status ?? task.status) !== "canceled") {
    return fail(`«${task.title}» (${task.id}): duplicate_of goes with status canceled, since merging cancels the duplicate. Nothing was changed.`, task);
  }

  const asked = input.agent_profile?.trim();
  let profile: string | null | undefined;
  if (asked !== undefined) {
    if (!asked) profile = null;
    else {
      const known = await knownProfile(ctx, asked);
      if (!known.ok) return fail(`${known.error} Nothing was changed.`, task);
      profile = known.name;
    }
  }

  const accepting = task.status === "inbox" && input.status === "todo";
  const wanted: Record<string, unknown> = {
    title: input.title,
    project,
    feature: feature?.ok && refId(feature.value) !== refId(task.feature) ? feature.value : undefined,
    milestone: milestone?.ok && refId(milestone.value) !== refId(task.milestone) ? milestone.value : undefined,
    // An accepted draft without a priority takes the space's default, as a task created as todo does.
    priority: input.priority ?? (accepting && !task.priority ? space.sync.plan.space?.defaults.priority : undefined),
    assignee: assignee?.ok ? assignee.value : undefined,
    depends_on:
      depends?.ok && JSON.stringify(depends.value.map(refId)) !== JSON.stringify(task.depends_on.map(refId)) ? depends.value : undefined,
    duplicate_of: duplicate?.ok && refId(duplicate.value[0]) !== refId(task.duplicate_of) ? duplicate.value[0] : undefined,
    // "" takes the link off: null removes the field (03-model.md).
    issue: issue?.ok ? (issue.value ?? null) : undefined,
    // null takes the field off: the policy and the defaults decide again.
    agent_profile: profile,
    requires: requirementsFor(task, input.requires, now),
    delivery: deliveryFor(task, input.delivery, now),
    // A person's check of its readiness carries its day; "" takes both off.
    readiness_note: input.readiness_note === undefined ? undefined : input.readiness_note || null,
    readiness_checked: input.readiness_note === undefined ? undefined : input.readiness_note ? now.toISOString().slice(0, 10) : null,
  };
  const { ops, fields } = changes(task, wanted);
  // One operation per label, so labels added or removed on two machines both land (I2).
  const has = (label: string) => task.labels.some((own) => sameLabel(own, label));
  const removed = (input.remove_labels ?? []).filter((label) => has(label) && !added.value.some((a) => sameLabel(a, label)));
  const labelOps: Operation[] = [
    ...added.value.filter((label) => !has(label)).map((label): Operation => ({ op_id: opaqueId("op"), kind: "label", id: task.id, label, add: true })),
    ...removed.map((label): Operation => ({ op_id: opaqueId("op"), kind: "label", id: task.id, label: label.trim(), add: false })),
  ];
  if (labelOps.length) {
    // The definitions go first, so a label is in the palette by the time the task carries it.
    for (const op of [...defs, ...labelOps]) {
      ops.push(op);
      fields.push("labels");
    }
  }
  if (input.brief !== undefined && briefText(input.brief).trim() !== loaded.brief.trim()) {
    ops.push({ op_id: opaqueId("op"), kind: "brief", id: task.id, text: briefText(input.brief), expect_hash: briefHash(loaded.brief) });
    fields.push("brief");
  }
  // A new priority puts the task at the end of that priority's tasks: its old place meant nothing there.
  // A rank is a place among one priority's tasks of one section; a new priority or status drops it.
  const plan = space.sync.plan;
  const newLevel = fields.includes("priority") && PRIORITY_ORDER[String(wanted.priority)] !== priorityRank(plan, task);
  if (task.rank !== undefined && (newLevel || (input.status && input.status !== task.status))) {
    ops.push({ op_id: opaqueId("op"), kind: "set", id: task.id, field: "rank", value: null, expect: task.rank });
    fields.push("rank");
  }
  if (placed?.ok) {
    for (const op of placed.ops) {
      ops.push(op);
      fields.push("rank");
    }
  }
  // Last, so a draft accepted together with its project sees the project first.
  if (input.status && input.status !== task.status) {
    ops.push({ op_id: opaqueId("op"), kind: "status", id: task.id, to: input.status, expect: task.status });
    fields.push("status");
  }
  if (ops.length === 0) return { ok: true, id: task.id, title: task.title, status: task.status, changed: [], error: "" };

  const outcomes = await record(ctx, space, ops);
  const changed: string[] = [];
  const problems: string[] = [];
  ops.forEach((op, index) => {
    const reason = refusal(outcomes.get(op.op_id));
    if (reason) problems.push(`${fields[index]}: ${reason}`);
    else if (!changed.includes(fields[index]!)) changed.push(fields[index]!);
  });
  const after = space.sync.plan.entities.get(task.id)?.entity as Task | undefined;
  // Someone changed the task meanwhile: say what did change, since "not done" alone would be wrong.
  const applied = problems.length && changed.length ? ` The other changes were made: ${changed.join(", ")}.` : "";
  return {
    ok: problems.length === 0,
    id: task.id,
    title: after?.title ?? task.title,
    status: after?.status ?? task.status,
    changed,
    error: problems.length ? `${problems.join("; ")}.${applied}` : "",
  };
}

/**
 * The requirements asked for as the plan keeps them: each with the day it was checked, an unchanged
 * one keeping its day; null takes the list off; undefined leaves it.
 */
function requirementsFor(task: Task, asked: { kind: Task["requires"][number]["kind"]; reason: string }[] | undefined, now: Date): unknown {
  if (asked === undefined) return undefined;
  if (!asked.length) return null;
  const today = now.toISOString().slice(0, 10);
  return asked.map(({ kind, reason }) => {
    const kept = task.requires.find((r) => r.kind === kind && r.reason === reason.trim());
    return { kind, reason: reason.trim(), checked: kept?.checked ?? today };
  });
}

/**
 * The delivery facts after a change: the fields given replace theirs ("" clears one), each group gets
 * the day it was recorded (stage, Trello, QA); null takes it off once nothing is left; undefined leaves it.
 */
function deliveryFor(task: Task, asked: RpcInput<typeof tasksUpdateRpc>["delivery"], now: Date): unknown {
  if (!asked || !Object.values(asked).some((v) => v !== undefined)) return undefined;
  const next: Record<string, unknown> = { ...(task.delivery ?? {}) };
  for (const [key, value] of Object.entries(asked)) {
    if (value === undefined) continue;
    if (value === "" || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
  }
  const at = now.toISOString();
  if (["stage_sha", "stage_url", "stage_version"].some((k) => (asked as Record<string, unknown>)[k] !== undefined)) next.stage_checked = at;
  if (asked.trello_state !== undefined) next.trello_checked = at;
  if (asked.qa !== undefined) next.qa_at = at;
  // As the plan reads it back: known fields in their order, nothing empty.
  const normal = deliverySchema.parse(next) ?? {};
  const out = Object.fromEntries(Object.entries(normal).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  const facts = Object.keys(out).filter((k) => !["stage_checked", "trello_checked", "qa_at"].includes(k));
  return facts.length ? out : null;
}

// ---------------------------------------------------------------- tasks.rank

/** The moves that put a task at `position`, `next_to` naming a task of the same space (rank.ts). */
function placeTask(space: SpaceEntry, task: Task, position: RankPosition, nextTo: string | undefined) {
  let other: Task | undefined;
  if ((position === "before" || position === "after") !== Boolean(nextTo)) {
    if (nextTo) return { ok: false as const, error: `«${task.title}» (${task.id}): next_to goes only with position before or after. Nothing was changed.` };
  }
  if (position === "before" || position === "after") {
    if (!nextTo) return { ok: false as const, error: `«${task.title}» (${task.id}): position ${position} needs next_to, the task to put it next to. Nothing was changed.` };
    const found = within<Task>(space, "task", nextTo);
    if (!found.ok) return found;
    other = found.value.entity;
  }
  return rankOps(space.sync.plan, task, position, other);
}

type TaskRank = RpcOutput<typeof tasksRankRpc>;

/** A person's move of a task among the tasks of its priority waiting to start (D21). */
export async function rankTask(ctx: WriteContext, input: RpcInput<typeof tasksRankRpc>): Promise<TaskRank> {
  const fail = (error: string, task?: Task): TaskRank => ({ ok: false, id: task?.id ?? "", changed: 0, error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space } = found.value;
  const placed = placeTask(space, task, input.position, input.next_to);
  if (!placed.ok) return fail(placed.error, task);
  if (!placed.ops.length) return { ok: true, id: task.id, changed: 0, error: "" };
  const outcomes = await record(ctx, space, placed.ops);
  const reasons = placed.ops.map((op) => refusal(outcomes.get(op.op_id))).filter(Boolean);
  const applied = placed.ops.length - reasons.length;
  if (reasons.length) {
    // Each rank is its own write: when some of a renumbering refuse, the others stand. The order stays
    // whole, only not the one asked for.
    const part = applied ? `${applied} of ${placed.ops.length} places were written, the rest refused` : "nothing was written";
    return { ok: false, id: task.id, changed: applied, error: `The order changed meanwhile (${reasons[0]}); ${part}. Look at the list again and move it once more.` };
  }
  return { ok: true, id: task.id, changed: placed.ops.length, error: "" };
}

// ---------------------------------------------------------------- ui.move

type TaskMove = RpcOutput<typeof uiMoveRpc>;

/**
 * "Move…": a task to another release, feature or project (line), or out of its feature or release.
 * The move refuses when the task is no longer where the dialog showed it, so a move someone else made
 * meanwhile is shown, not overwritten; the `set` operations' `expect` covers what a later fetch
 * brings in. The project changes only while no run ever claimed the task (`lineLocked`).
 */
export async function moveTask(ctx: WriteContext, input: RpcInput<typeof uiMoveRpc>): Promise<TaskMove> {
  const fail = (error: string, task?: Task): TaskMove => ({ ok: false, id: task?.id ?? "", changed: [], error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space } = found.value;
  const name = `«${task.title}» (${task.id})`;
  const place = { project: task.project ?? "", feature: refId(task.feature) ?? "", milestone: refId(task.milestone) ?? "" };
  const moved = (Object.keys(place) as (keyof typeof place)[]).filter((key) => place[key] !== input.from[key]);
  if (moved.length) {
    const now = moved.map((key) => `${key} is now ${place[key] || "none"}`).join(", ");
    return fail(`${name} was changed by someone else since this opened: ${now}. Nothing was changed; check the move again.`, task);
  }

  const wanted: Record<string, unknown> = {};
  if (input.project !== undefined) {
    const project = resolveProject(space, input.project);
    if (!project.ok) return fail(project.error, task);
    const locked = project.value !== place.project ? lineLocked(task) : "";
    if (locked) return fail(`${locked} Nothing was changed.`, task);
    wanted.project = project.value;
  }
  for (const type of ["feature", "milestone"] as const) {
    const asked = input[type];
    if (asked === undefined || asked === place[type]) continue;
    if (asked === "") {
      // null removes the field (03-model.md: the plugin writes only fields that have a value).
      wanted[type] = null;
      continue;
    }
    const target = link(space, type, asked);
    if (!target.ok) return fail(target.error, task);
    wanted[type] = target.value;
  }
  const { ops, fields } = changes(task, wanted);
  if (ops.length === 0) return { ok: true, id: task.id, changed: [], error: "" };

  const outcomes = await record(ctx, space, ops);
  const changed: string[] = [];
  const problems: string[] = [];
  ops.forEach((op, index) => {
    const reason = refusal(outcomes.get(op.op_id));
    if (reason) problems.push(`${fields[index]}: ${reason}`);
    else changed.push(fields[index]!);
  });
  const applied = problems.length && changed.length ? ` The other changes were made: ${changed.join(", ")}.` : "";
  return { ok: problems.length === 0, id: task.id, changed, error: problems.length ? `${problems.join("; ")}.${applied}` : "" };
}

// ---------------------------------------------------------------- tasks.start

type TaskStart = RpcOutput<typeof tasksStartRpc>;

export interface StartRequest extends StartOptions {
  /**
   * The hashes of the instruction parts the dashboard's confirmation showed: the start refuses when
   * the instructions changed since, and marks them seen when it goes on.
   */
  seen?: string[];
  /**
   * What the person starting the task added to its instructions in the dashboard's confirmation. It is
   * written to the task's `## Clarifications` before the claim, so later runs and `task_brief` read it
   * too, and the agent gets it in its first prompt. God Mode never sets it.
   */
  clarification?: string;
  /**
   * The project, branch, workspace, agent and issue (the agent's "Closes #N") the dashboard's
   * confirmation showed: its facts may be up to a minute old, so the start refuses when its own
   * decision differs. God Mode never sets it.
   */
  shown?: { project: string; branch: string; workspace: string; profile: string; issue: string; human?: string };
  /**
   * With `seen`: whether the start records the instructions as seen by the local user (default yes).
   * No for a start a read-back through ChatGPT covered: the user heard of the text, never saw it.
   */
  recordSeen?: boolean;
  /**
   * The caller's own checks, run by the claim on the plan it just fetched, after the start's checks:
   * why the start must not go on. The managed queue asks here again whether its limits still let it
   * start and whether the card still is what it planned (server/managed/queue.ts).
   */
  guard?: (fresh: Plan) => string | undefined;
}

const SHOWN_NAMES = { project: "project", branch: "branch", workspace: "workspace", profile: "agent", issue: "issue", human: "person's-work mark" } as const;

/**
 * Claims the task for a new run from this Mac (I5); the runner then creates the worktree and the
 * agent in the background.
 */
export async function startTask(ctx: WriteContext, input: RpcInput<typeof tasksStartRpc>, request: StartRequest = {}): Promise<TaskStart> {
  const fail = (error: string, id = "", branch = ""): TaskStart => ({ ok: false, id, state: "", branch, workspace: "", mode: "", effort: "", instructions: "", human: "", error });
  // meta.describe is not a permission system: a start that skips God Mode's confirmation is refused
  // here unless this machine's switch allows it now.
  if (input.without_asking && !startWithoutAsking(ctx.dashboard.dataDir)) {
    return fail("Starting a task from ChatGPT without asking is off on this Mac (Paseo Dash settings); nothing was started. Ask again: the start will be read back first.");
  }
  const plan = await planStart(ctx, input, request);
  if (!("found" in plan)) return fail(plan.error);
  const { found, branch } = plan;
  if (request.shown) {
    const changed = (Object.keys(SHOWN_NAMES) as (keyof typeof SHOWN_NAMES)[]).filter((key) => (request.shown![key] ?? "") !== plan.facts[key]);
    if (changed.length) {
      const said = changed.map((key) => `the ${SHOWN_NAMES[key]} is now ${plan.facts[key] || "none"}, not ${request.shown![key] || "none"}`).join("; ");
      return fail(`What the start would do changed after the confirmation showed it: ${said}. Check the start again.`, found.entity.id, branch);
    }
  }
  if (request.seen) {
    // The prompt below is built from the same reading as these hashes (the task's loaded file and
    // the template text in plan.parts), so the agent gets exactly what the confirmation showed.
    if (plan.instructions.some((part) => !request.seen!.includes(part.hash))) {
      return fail("The instructions changed after the confirmation showed them; check the start again.", found.entity.id, branch);
    }
    if (request.recordSeen !== false) for (const part of plan.parts) ctx.dashboard.seen?.mark(found.space.record.key, part);
  }
  const runId = opaqueId("r");
  const task = found.entity;
  const now = (ctx.now ?? (() => new Date()))();
  const person = (await found.space.sync.gitUser()) || userInfo().username;
  let loaded = found.loaded;
  const clarification = request.clarification?.trim();
  // A start tried again after its clarification was saved (and the confirmation showed it) adds nothing.
  if (clarification && !isLastClarification(loaded.clarifications, { by: person, text: clarification })) {
    const entry = { by: person, at: now.toISOString(), text: clarification };
    const op: Operation = { op_id: opaqueId("op"), kind: "clarify", id: task.id, ...entry };
    let outcome: Outcome | undefined;
    try {
      outcome = (await record(ctx, found.space, [op])).get(op.op_id);
    } catch (error) {
      if (!(error instanceof Unknown)) throw error;
      return fail(`${found.space.record.name}'s plan is busy syncing: the clarification is queued and nothing was started; start again once the task shows it.`, task.id, branch);
    }
    const reason = refusal(outcome);
    if (reason) return fail(`The clarification could not be saved (${reason}); nothing was started.`, task.id, branch);
    // An earlier start's queued clarification landed after this confirmation read the task.
    if (outcome?.status === "already") return fail("The clarification was saved by an earlier start meanwhile; nothing was started. Check the start again.", task.id, branch);
    // The file now ends its `## Clarifications` with this entry: the prompt and the seen record read it so.
    loaded = { ...loaded, clarifications: [loaded.clarifications, clarificationEntry(entry)].filter(Boolean).join("\n\n") };
    if (request.seen) {
      const text = taskInstructions(loaded.brief, loaded.acceptance.map((a) => a.text), loaded.handoff?.text, loaded.clarifications);
      ctx.dashboard.seen?.mark(found.space.record.key, { key: taskPartKey(task.id), text });
    }
  }
  const token = newToken();
  const tools = ctx.dashboard.bridge ? { ...ctx.dashboard.bridge.forRun(token), token } : undefined;
  const run = { run_id: runId, run_by: person, run_host: ctx.host ?? localHost(), run_branch: branch, run_started: now.toISOString() };
  // Everything the start sends is decided before the claim, so an unclear claim can still be launched
  // once a later fetch shows it landed (I5).
  const launch = {
    run_id: runId,
    space: found.space.record.key,
    task: task.id,
    title: agentTitle(task),
    project: task.project!,
    projectId: plan.projectId,
    branch,
    base: plan.base,
    workspace: plan.workspace,
    prompt: buildPrompt({
      template: plan.parts.find((part) => part.key === TEMPLATE_PART)?.text,
      plan: found.space.sync.plan,
      loaded,
      task,
      spaceName: found.space.record.name,
      branch,
      base: plan.base ?? "the project's default branch",
      tools: Boolean(tools),
      // A run on a released run's branch, or on an existing branch the person chose, continues its work (and its open PR/MR, if any).
      continues: task.run_branch === branch || (plan.continues ? "existing" : false),
      continuesPr: plan.continuesPr,
      merged: ctx.dashboard.merged.shown(found.space.sync.plan, task),
    }),
    settings: plan.settings,
    started: run.run_started,
    tools,
  };
  const claim = await found.space.sync.claim(task.id, run, (fresh) => startObjection(fresh, task.id, plan.previousRunId, request, plan.checked) ?? request.guard?.(fresh));
  if (claim.result === "won") {
    // The worktree and the agent follow in the background; `task` reads show how far it got.
    ctx.dashboard.starts?.launch(launch);
    return { ok: true, id: task.id, state: "launching", branch, workspace: plan.workspaceTitle, mode: plan.settings.mode, effort: plan.settings.effort, instructions: plan.facts.instructions, human: plan.facts.human, error: "" };
  }
  if (claim.result === "unknown") {
    ctx.dashboard.starts?.launch(launch, "undecided");
    throw new Unknown(claim.reason);
  }
  return fail(claim.reason, task.id, branch);
}

// ---------------------------------------------------------------- tasks.release

type TaskRelease = RpcOutput<typeof tasksReleaseRpc>;

export async function releaseTask(ctx: WriteContext, input: RpcInput<typeof tasksReleaseRpc>): Promise<TaskRelease> {
  const fail = (error: string, task?: Task): TaskRelease => ({ ok: false, id: task?.id ?? "", status: task?.status ?? "", agent: "", error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space } = found.value;
  if (!hasLiveRun(task)) return fail(`«${task.title}» (${task.id}) is ${task.status} and has no live run; nothing to release.${unheld(task) ? " Change its status with update_task (todo, done or canceled)." : ""}`, task);
  const now = (ctx.now ?? (() => new Date()))();
  const op: Operation = { op_id: opaqueId("op"), kind: "release", id: task.id, run_id: task.run_id!, to: input.to, at: now.toISOString() };
  const run = localRun(ctx.dashboard.runs, task);
  const outcomes = await record(ctx, space, [op]);
  const reason = refusal(outcomes.get(op.op_id));
  if (reason) return fail(reason, task);
  // The run is over: its agent stops (D23); its chat and workspace stay, archived by a separate button.
  let agent = "";
  if (run?.agentId && run.activity !== "stopped") {
    // Bounded, so the answer stays inside Paseo's 30 s with the write before it; a slower stop goes on.
    const stopping = ctx.dashboard.stopAgentOf(run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = await Promise.race([stopping, new Promise<undefined>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS, undefined)))]);
    clearTimeout(timer);
    agent = failed === undefined ? "its agent on this Mac is being stopped; its chat stays" : failed ? `its agent could not be stopped: ${failed}` : "its agent on this Mac is stopped; its chat stays";
  } else if (!run && task.run_host && task.run_host !== localHost()) {
    // Another machine cannot tell a release to done from a merge, so it stops only todo and canceled.
    agent = input.to === "done" ? `its agent on ${task.run_host} keeps running; stop it in its chat if it should` : `its agent on ${task.run_host} stops once that machine syncs`;
  }
  return { ok: true, id: task.id, status: input.to, agent, error: "" };
}

// ---------------------------------------------------------------- tasks.archive-workspace

type ArchiveWorkspace = RpcOutput<typeof tasksArchiveWorkspaceRpc>;

/**
 * "Archive workspace" (D23): archives the workspaces this Mac's ended runs of a task left in Paseo,
 * after the person asked. A live run's workspace is its run's: release it first. A workspace tracked
 * as the task (adopted) is the person's own and never archived from here.
 */
export async function archiveWorkspace(ctx: WriteContext, input: RpcInput<typeof tasksArchiveWorkspaceRpc>): Promise<ArchiveWorkspace> {
  const fail = (error: string, archived = 0): ArchiveWorkspace => ({ ok: false, archived, error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task } = found.value;
  if (hasLiveRun(task)) return fail(`«${task.title}» (${task.id}) still has a live run; release it first.`);
  if (task.status !== "done" && task.status !== "canceled") return fail(`«${task.title}» (${task.id}) is ${task.status}; its next start may reuse the workspace, so it is archived only once the task is done or canceled.`);
  const paseo = ctx.dashboard.paseo;
  if (!paseo) return fail("Paseo is not connected yet; try again in a moment.");
  const left = leftWorkspaces(ctx.dashboard, task.id);
  if (!left.length) return fail(`No workspace of «${task.title}» (${task.id}) is left on this Mac.`);
  const now = () => (ctx.now ?? (() => new Date()))().toISOString();
  let archived = 0;
  for (const { runs, workspaceId } of left) {
    // Archived in Paseo meanwhile (by hand, or after a merge), or gone from it: only remembered.
    let descriptor: { archivingAt?: string | null } | null;
    try {
      descriptor = (await paseo.workspaces.ref(workspaceId).refresh()) as { archivingAt?: string | null } | null;
    } catch (error) {
      return fail(`Could not read the workspace of run ${runs[0]!.run_id} in Paseo: ${String((error as Error)?.message ?? error)}`, archived);
    }
    if (descriptor && !descriptor.archivingAt) {
      try {
        await paseo.workspaces.archive(workspaceId);
      } catch (error) {
        return fail(`Could not archive the workspace of run ${runs[0]!.run_id}: ${String((error as Error)?.message ?? error)}`, archived);
      }
      archived += 1;
    }
    for (const run of runs) run.workspaceArchivedAt = now();
    ctx.dashboard.runs?.save();
  }
  return { ok: true, archived, error: "" };
}

// ---------------------------------------------------------------- tasks.continue

type TaskContinue = RpcOutput<typeof tasksContinueRpc>;

/** Review → in progress, by a person on the run's own machine (03-model.md, the transition table). */
export async function continueTask(ctx: WriteContext, input: RpcInput<typeof tasksContinueRpc>): Promise<TaskContinue> {
  const fail = (error: string, task?: Task): TaskContinue => ({ ok: false, id: task?.id ?? "", status: task?.status ?? "", error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task, space } = found.value;
  const name = `«${task.title}» (${task.id})`;
  if (!hasLiveRun(task) || task.status !== "review") return fail(`${name} is ${task.status}${hasLiveRun(task) ? "" : " without a live run"}; only a task in review continues.`, task);
  if (!localRun(ctx.dashboard.runs, task)) return fail(`${name} runs on ${task.run_host ?? "another machine"}; continue it there.`, task);
  const now = (ctx.now ?? (() => new Date()))();
  const op: Operation = { op_id: opaqueId("op"), kind: "transition", id: task.id, to: "in_progress", run_id: task.run_id!, at: now.toISOString() };
  const reason = refusal((await record(ctx, space, [op])).get(op.op_id));
  if (reason) return fail(reason, task);
  return { ok: true, id: task.id, status: "in_progress", error: "" };
}

// ---------------------------------------------------------------- tasks.archive

type TaskArchive = RpcOutput<typeof tasksArchiveRpc>;

/**
 * Archives done and canceled tasks, or puts them back on the board (03-model.md, Archive): one
 * operation per task, recorded per space, so each space's tasks land in one commit. An open task is
 * refused here and again when the operation applies (another machine may have reopened it meanwhile).
 */
export async function archiveTasks(ctx: WriteContext, input: RpcInput<typeof tasksArchiveRpc>): Promise<TaskArchive> {
  const fail = (error: string, refused: string[] = []): TaskArchive => ({ ok: false, changed: [], refused, error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const spaces = [...ctx.dashboard.spaces.values()];
  const targets: { space: SpaceEntry; task: Task }[] = [];
  const refused: string[] = [];
  if (input.tasks) {
    for (const id of new Set(input.tasks.map((asked) => asked.trim().toUpperCase()))) {
      const space = spaces.find((entry) => entry.sync.plan.entities.get(id)?.entity.type === "task");
      if (!space) refused.push(`${id} is not a task here`);
      else targets.push({ space, task: space.sync.plan.entities.get(id)!.entity as Task });
    }
  } else {
    if (!input.archived) return fail("Name the tasks to put back on the board.");
    const scope = input.finished_of ?? {};
    let within: SpaceEntry[];
    let feature: string | undefined;
    if (scope.feature) {
      const found = resolveEntity(scope.space ? spaces.filter((s) => s.record.key.toLowerCase() === scope.space!.toLowerCase()) : spaces, "feature", scope.feature);
      if (!found.ok) return fail(found.error);
      within = [found.value.space];
      feature = found.value.entity.id;
    } else {
      const found = resolveSpaces(ctx.dashboard, scope.space);
      if (!found.ok) return fail(found.error);
      within = found.value;
    }
    for (const space of within) {
      for (const task of tasksOf(space.sync.plan)) {
        if (closed(task) && !task.archived && (!feature || refId(task.feature) === feature)) targets.push({ space, task });
      }
    }
  }
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  const bySpace = new Map<SpaceEntry, { op: Operation; id: string }[]>();
  for (const { space, task } of targets) {
    if (input.archived && !closed(task)) {
      refused.push(`${task.id} is ${task.status}; only a done or canceled task is archived`);
      continue;
    }
    if (Boolean(task.archived) === input.archived) continue;
    const ops = bySpace.get(space) ?? [];
    ops.push({ id: task.id, op: { op_id: opaqueId("op"), kind: "archive", id: task.id, archived: input.archived, at: now } });
    bySpace.set(space, ops);
  }
  const changed: string[] = [];
  for (const [space, ops] of bySpace) {
    const outcomes = await record(ctx, space, ops.map((o) => o.op));
    for (const { op, id } of ops) {
      const reason = refusal(outcomes.get(op.op_id));
      if (reason) refused.push(`${id}: ${reason}`);
      else changed.push(id);
    }
  }
  const error = refused.length ? `${refused.length} not ${input.archived ? "archived" : "put back"}: ${refused.slice(0, 5).join("; ")}${refused.length > 5 ? "; …" : ""}` : "";
  return { ok: refused.length === 0, changed, refused, error };
}

// ---------------------------------------------------------------- tasks.seen

type TaskSeen = RpcOutput<typeof tasksSeenRpc>;

/**
 * The task screen showed the brief, acceptance, clarifications and handoff with this hash. They are marked seen only when
 * that is still what the task says, so a screen showing an older version marks nothing.
 */
export function markSeen(ctx: ReadContext, input: RpcInput<typeof tasksSeenRpc>): TaskSeen {
  const owner = ownerError(ctx);
  if (owner) return { ok: false, error: owner };
  if (!ctx.dashboard.seen) return { ok: false, error: "Paseo Dash has not started" };
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return { ok: false, error: found.error };
  const { space, loaded } = found.value;
  const text = taskInstructions(loaded.brief, loaded.acceptance.map((a) => a.text), loaded.handoff?.text, loaded.clarifications);
  if (hashText(text) !== input.hash) return { ok: false, error: "the brief, acceptance, clarifications or handoff changed since the screen read them" };
  ctx.dashboard.seen.mark(space.record.key, { key: taskPartKey(loaded.entity.id), text });
  return { ok: true, error: "" };
}

// ---------------------------------------------------------------- milestones and features

type EntityAnswer = RpcOutput<typeof milestonesCreateRpc>;

async function createEntity(
  ctx: WriteContext,
  askedSpace: string | undefined,
  type: "milestone" | "feature",
  title: string,
  build: (space: SpaceEntry) => Resolved<{ fields: Record<string, unknown>; body: string }>,
): Promise<EntityAnswer> {
  const fail = (error: string): EntityAnswer => ({ ok: false, id: "", title, error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const spaceFound = resolveCreateSpace(ctx.dashboard, askedSpace);
  if (!spaceFound.ok) return fail(spaceFound.error);
  const space = spaceFound.value;
  const built = build(space);
  if (!built.ok) return fail(built.error);
  const op = create(space, type, { title, ...built.value.fields }, built.value.body, space.sync.takenIds());
  const reason = refusal((await record(ctx, space, [op])).get(op.op_id));
  if (reason) return fail(reason);
  return { ok: true, id: (op as Extract<Operation, { kind: "create" }>).id, title, error: "" };
}

async function updateEntity<E extends Entity>(
  ctx: WriteContext,
  type: E["type"],
  asked: string,
  build: (found: FoundEntity<E>) => Resolved<Record<string, unknown>>,
): Promise<EntityAnswer> {
  const fail = (error: string, entity?: Entity): EntityAnswer => ({ ok: false, id: entity?.id ?? "", title: entity?.title ?? "", error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], type, asked) as Resolved<FoundEntity<E>>;
  if (!found.ok) return fail(found.error);
  const { entity, space } = found.value;
  const wanted = build(found.value);
  if (!wanted.ok) return fail(wanted.error, entity);
  const { ops, fields } = changes(entity, wanted.value);
  if (ops.length === 0) return { ok: true, id: entity.id, title: entity.title, error: "" };
  const outcomes = await record(ctx, space, ops);
  const problems = ops
    .map((op, index) => {
      const reason = refusal(outcomes.get(op.op_id));
      return reason ? `${fields[index]}: ${reason}` : "";
    })
    .filter(Boolean);
  const after = space.sync.plan.entities.get(entity.id)?.entity;
  return { ok: problems.length === 0, id: entity.id, title: after?.title ?? entity.title, error: problems.join("; ") };
}

function branchName(asked: string | undefined): Resolved<string | undefined> {
  if (asked === undefined) return { ok: true, value: undefined };
  return SAFE_BRANCH.test(asked) ? { ok: true, value: asked } : { ok: false, error: `${JSON.stringify(asked)} is not a usable branch name` };
}

export function createMilestone(ctx: WriteContext, input: RpcInput<typeof milestonesCreateRpc>): Promise<EntityAnswer> {
  return createEntity(ctx, input.space, "milestone", input.title, () => ({
    ok: true,
    value: { fields: { status: input.status ?? "planned", start: input.start, due: input.due }, body: "" },
  }));
}

export function updateMilestone(ctx: WriteContext, input: RpcInput<typeof milestonesUpdateRpc>): Promise<EntityAnswer> {
  return updateEntity<Milestone>(ctx, "milestone", input.milestone, () => ({
    ok: true,
    value: { title: input.title, start: input.start, due: input.due, status: input.status },
  }));
}

export function createFeature(ctx: WriteContext, input: RpcInput<typeof featuresCreateRpc>): Promise<EntityAnswer> {
  return createEntity(ctx, input.space, "feature", input.title, (space) => {
    const milestone = input.milestone ? link(space, "milestone", input.milestone) : undefined;
    if (milestone && !milestone.ok) return milestone;
    const branch = branchName(input.branch);
    if (!branch.ok) return branch;
    const projects: string[] = [];
    for (const asked of input.projects ?? []) {
      const project = resolveProject(space, asked);
      if (!project.ok) return project;
      projects.push(project.value);
    }
    return {
      ok: true,
      value: {
        fields: {
          status: "planned",
          milestone: milestone?.ok ? milestone.value : undefined,
          branch: branch.value,
          projects: projects.length ? projects : undefined,
        },
        body: input.brief ? `\n${briefText(input.brief.trim())}\n` : "",
      },
    };
  });
}

export function updateFeature(ctx: WriteContext, input: RpcInput<typeof featuresUpdateRpc>): Promise<EntityAnswer> {
  return updateEntity<Feature>(ctx, "feature", input.feature, ({ entity, space }) => {
    const milestone = input.milestone ? link(space, "milestone", input.milestone) : undefined;
    if (milestone && !milestone.ok) return milestone;
    const branch = branchName(input.branch);
    if (!branch.ok) return branch;
    return {
      ok: true,
      value: {
        title: input.title,
        milestone: milestone?.ok && refId(milestone.value) !== refId(entity.milestone) ? milestone.value : undefined,
        branch: branch.value,
        status: input.status,
      },
    };
  });
}
