import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ENTITY_DIRS,
  type EntityType,
  closed,
  hasLiveRun,
  ID_PATTERN,
  lineLocked,
  PERSON_KEY_PATTERN,
  PLAN_STATUSES,
  type PlanStatus,
  refId,
  RUN_TRANSITIONS,
  type Task,
  type TaskStatus,
  startable,
} from "../../shared/model.ts";
import {
  addClarification,
  briefHash,
  demoteHeadings,
  isLastClarification,
  type EntityDocument,
  newEntity,
  parseEntity,
  replaceAcceptance,
  serializeEntity,
  setField,
  writeAcceptance,
  writeBrief,
  writeHandoff,
} from "../plan/document.ts";
import { entityFileName } from "../plan/ids.ts";
import { createRefusal, type DelegatedEdit, editRefusal, outsideRefusal, revisionOf, sameEdit, type Via } from "../delegation/rules.ts";
import {
  editSpace,
  type LabelFields,
  labelFields,
  ownProject,
  type PersonFields,
  personFields,
  type ProjectFields,
  projectFields,
} from "../plan/space-file.ts";
import { cleanLabel, findLabel, sameLabel } from "../../shared/labels.ts";
import { issueKey } from "../../shared/issues.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { type LoadedEntity, type Plan, readEntityFile, realPathInside, validateEntityText } from "../plan/load.ts";

/**
 * Operations: every write to the plan is one of these, recorded in the journal before it touches a
 * file and re-applied on top of whatever origin has (05-architecture.md, Operations and I1–I4).
 */
export type Operation =
  /** With `via`, a coordinator's draft (server/delegation/rules.ts). */
  | { op_id: string; kind: "create"; type: EntityType; id: string; fields: Record<string, unknown>; body: string; via?: Via }
  /**
   * A coordinator's change of one card under the owner's permission: all of it or none, only on the
   * revision it was made from, with the card's rules checked again at every apply and the permission
   * as SpaceSyncOptions.authorize says.
   */
  | { op_id: string; kind: "delegated"; id: string; via: Via; expect_rev: string; edit: DelegatedEdit }
  | { op_id: string; kind: "set"; id: string; field: string; value: unknown; expect: unknown }
  | { op_id: string; kind: "status"; id: string; to: TaskStatus; expect: TaskStatus }
  | { op_id: string; kind: "brief"; id: string; text: string; expect_hash: string }
  | { op_id: string; kind: "check"; id: string; line: string; done: boolean; run_id?: string }
  /**
   * With `create`, the task does not exist yet: it is created as `todo` and claimed in the same apply
   * (adopting a Paseo workspace, 05-architecture.md, Operations), so both land in one commit or neither.
   */
  | { op_id: string; kind: "claim"; id: string; run: RunFields; create?: { fields: Record<string, unknown>; body: string } }
  | {
      op_id: string;
      kind: "progress";
      id: string;
      run_id: string;
      /** Omitted: the acceptance ticks the file has when the operation applies (after the ticks before it). */
      done?: number;
      total?: number;
      note: string;
      at: string;
    }
  /**
   * `archived`: the run's own merge with acceptance lines left, after its workspace was archived on
   * its machine; the person ended the run, so the open lines do not hold the task back.
   */
  | { op_id: string; kind: "transition"; id: string; to: TaskStatus; run_id: string; run_pr?: string; at: string; archived?: true }
  /** Adds a person's clarification, given when starting the task, to its `## Clarifications`. */
  | { op_id: string; kind: "clarify"; id: string; by: string; text: string; at: string }
  /** Replaces the task's `## Handoff` with what this run's agent left for the next run. */
  | { op_id: string; kind: "handoff"; id: string; run_id: string; text: string; at: string }
  | { op_id: string; kind: "release"; id: string; run_id: string; to: "todo" | "canceled" | "done"; at: string }
  /**
   * Takes a done or canceled task off the board (`archived: true`, writing `archived: <at>`), or puts it
   * back (03-model.md, Archive). Nothing else of the task changes.
   */
  | { op_id: string; kind: "archive"; id: string; archived: boolean; at: string }
  /**
   * Adds, changes (`expect` is what it was) or, with a null value, removes a project of space.yaml.
   * With `pin`, it writes the default color a line drew, for the operation with that `op_id`: it
   * applies only right after that operation applied, and is dropped, never refused, otherwise.
   */
  | { op_id: string; kind: "project"; key: string; value: ProjectFields | null; expect: ProjectFields | null; pin?: string }
  /** Puts space.yaml's projects (the map's lines) in this order; `expect` is the order it was made from. */
  | { op_id: string; kind: "project_order"; order: string[]; expect: string[] }
  /** Adds one label to a task, or removes it: two machines labelling one task both land (I2). */
  | { op_id: string; kind: "label"; id: string; label: string; add: boolean }
  /**
   * Adds, changes (`expect` is what it was) or, with a null value, removes a label of space.yaml's
   * palette. With `if_absent`, it defines a label someone typed: any definition already there,
   * whatever its color, counts as applied.
   */
  | { op_id: string; kind: "label_def"; name: string; value: LabelFields | null; expect: LabelFields | null; if_absent?: boolean }
  /** Adds, changes or, with a null value, removes a person of space.yaml. */
  | { op_id: string; kind: "person"; key: string; value: PersonFields | null; expect: PersonFields | null }
  | {
      op_id: string;
      kind: "derived";
      id: string;
      to: "done" | "active";
      /** The feature status it was derived from; a different status means a person decided (D15). */
      expect?: PlanStatus;
      /** Origin's tip when it was derived; a status edit on origin after it drops the transition. */
      since?: string;
    };

/** A coordinator's operation: one that carries the permission it was asked under. */
export type DelegatedOperation =
  | Extract<Operation, { kind: "delegated" }>
  | (Extract<Operation, { kind: "create" }> & { via: Via });

export function delegationOf(op: Operation): DelegatedOperation | undefined {
  if (op.kind === "delegated") return op;
  return op.kind === "create" && op.via ? (op as DelegatedOperation) : undefined;
}

export interface RunFields {
  run_id: string;
  run_by: string;
  run_host: string;
  run_branch: string;
  run_started: string;
}

/**
 * - `applied`: the files changed.
 * - `already`: the effect is present, nothing to write (I2); `id` names the task that already
 *   carries a created draft's issue.
 * - `refused`: someone else changed the thing; reported to people.
 * - `dropped`: a run-scoped operation of a run that is no longer live, a derived transition whose
 *   condition no longer holds, or a pinned color that does not apply; logged only (I3).
 */
export type Outcome =
  | { status: "applied"; paths: string[]; tasksTouched: string[] }
  | { status: "already"; id?: string }
  | { status: "refused"; reason: string }
  | { status: "dropped"; reason: string };

/** Fields that only dedicated operations may write. */
const PROTECTED_FIELDS = new Set(["id", "type", "status", "created", "labels", "archived"]);
const PROTECTED_PREFIXES = ["run_", "progress_"];

/**
 * Status changes a person may make with `update_task` (03-model.md, the transition table). Anything
 * that starts or ends a run has its own operation. In progress is left this way only with no live run
 * (`unheld`): a live run is ended by a release, and the `status` operation refuses it.
 */
export const PERSON_STATUS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["todo", "canceled"],
  todo: ["inbox", "done", "canceled"],
  in_progress: ["todo", "done", "canceled"],
  review: [],
  done: ["todo"],
  canceled: ["todo"],
};

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === "" || (Array.isArray(v) && v.length === 0) ? undefined : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

class Workspace {
  readonly root: string;
  readonly plan: Plan;

  constructor(root: string, plan: Plan) {
    this.root = root;
    this.plan = plan;
  }

  entity(id: string): LoadedEntity | undefined {
    return this.plan.entities.get(id);
  }

  task(id: string): (LoadedEntity & { entity: Task }) | undefined {
    const found = this.plan.entities.get(id);
    return found?.entity.type === "task" ? (found as LoadedEntity & { entity: Task }) : undefined;
  }

  document(loaded: LoadedEntity): EntityDocument {
    return parseEntity(readFileSync(join(this.root, loaded.path), "utf8"));
  }

  /** Writes only a file that reads back as a valid entity of its type; never through a symlink. */
  save(path: string, document: EntityDocument, type: EntityType): void {
    const absolute = join(this.root, path);
    if (!realPathInside(this.root, path)) throw new Error(`${path} goes through a symlink; not written`);
    const text = serializeEntity(document);
    validateEntityText(text, type);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
    const loaded = readEntityFile(this.root, path, type);
    this.plan.entities.set(loaded.entity.id, loaded);
  }
}

/**
 * A creation time no other entity has: operations applied in one pass share `now`, and lists order
 * by creation time, so each later one of a batch takes the next millisecond and keeps its place.
 */
function distinctCreated(plan: Plan, now: string): string {
  const taken = new Set([...plan.entities.values()].map((loaded) => loaded.entity.created));
  let at = Date.parse(now);
  if (!Number.isFinite(at)) return now;
  let text = now;
  while (taken.has(text)) {
    at += 1;
    text = new Date(at).toISOString();
  }
  return text;
}

/** Whether a change of a task changes its feature's task set: its status or its feature (D15). */
function taskSetChanged(before: LoadedEntity["entity"], after: LoadedEntity["entity"] | undefined): boolean {
  if (before.type !== "task" || after?.type !== "task") return false;
  return before.status !== after.status || refId(before.feature) !== refId(after.feature);
}

function edit(
  ws: Workspace,
  loaded: LoadedEntity,
  now: string,
  change: (document: EntityDocument) => void,
): Outcome {
  const document = ws.document(loaded);
  change(document);
  setField(document, "updated", now);
  ws.save(loaded.path, document, loaded.entity.type);
  const after = ws.entity(loaded.entity.id)?.entity;
  return { status: "applied", paths: [loaded.path], tasksTouched: taskSetChanged(loaded.entity, after) ? [loaded.entity.id] : [] };
}

/**
 * Applies one operation to the checkout in `root`, keeping `plan` up to date. An operation either
 * applies fully, with every written file valid, or changes nothing and is refused with the reason.
 */
export function applyOperation(root: string, plan: Plan, op: Operation, now: string): Outcome {
  try {
    return apply(new Workspace(root, plan), plan, op, now);
  } catch (error) {
    return { status: "refused", reason: String((error as Error).message) };
  }
}

function apply(ws: Workspace, plan: Plan, op: Operation, now: string): Outcome {
  if (op.kind === "project" || op.kind === "project_order") return applySpaceEdit(ws, plan, op);
  if (op.kind === "label_def") return applyLabelDef(ws, plan, op);
  if (op.kind === "person") return applyPerson(ws, plan, op);
  if (op.kind !== "create" && plan.duplicates.has(op.id)) {
    return { status: "refused", reason: `${op.id} is claimed by two files; rename one first` };
  }

  switch (op.kind) {
    case "create": {
      if (!ID_PATTERN.test(op.id)) return { status: "refused", reason: `${op.id} is not a valid id` };
      const forbidden = op.via ? createRefusal(plan, op.type, op.fields, op.via.project) : undefined;
      if (forbidden) return { status: "refused", reason: forbidden };
      // A task for an issue some task already carries is that task: two machines importing one
      // issue make one draft (I2 applied to provenance instead of id; 09-forge-issues.md, option a).
      const issue = op.type === "task" && typeof op.fields.issue === "string" ? issueKey(op.fields.issue) : undefined;
      const carrier = issue ? taskWithIssue(plan, issue) : undefined;
      if (carrier) return { status: "already", id: carrier.id };
      if (ws.entity(op.id) || plan.duplicates.has(op.id)) return { status: "refused", reason: `id ${op.id} is taken` };
      const path = `${ENTITY_DIRS[op.type]}/${entityFileName(op.id, String(op.fields.title ?? ""))}`;
      if (existsSync(join(ws.root, path))) return { status: "refused", reason: `${path} already exists` };
      const { id: _id, type: _type, created: _c, updated: _u, ...fields } = op.fields;
      const created = distinctCreated(plan, now);
      const document = newEntity({ id: op.id, type: op.type, ...fields, created, updated: created }, op.body);
      ws.save(path, document, op.type);
      return { status: "applied", paths: [path], tasksTouched: op.type === "task" ? [op.id] : [] };
    }

    case "set": {
      const loaded = ws.entity(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} no longer exists` };
      if (PROTECTED_FIELDS.has(op.field) && !(op.field === "status" && loaded.entity.type !== "task")) {
        return { status: "refused", reason: `${op.field} cannot be set directly` };
      }
      if (PROTECTED_PREFIXES.some((prefix) => op.field.startsWith(prefix))) {
        return { status: "refused", reason: `${op.field} is written by runs only` };
      }
      if (op.field === "status" && !PLAN_STATUSES.includes(op.value as PlanStatus)) {
        return { status: "refused", reason: `status must be one of ${PLAN_STATUSES.join(", ")}` };
      }
      const current = (loaded.entity as Record<string, unknown>)[op.field];
      if (same(current, op.value)) return { status: "already" };
      if (!same(current, op.expect)) {
        return { status: "refused", reason: `${op.field} of ${op.id} is now ${JSON.stringify(current ?? null)}` };
      }
      // A claim that landed first (from any machine) fixes the task's repository.
      if (op.field === "project" && loaded.entity.type === "task") {
        const locked = lineLocked(loaded.entity);
        if (locked) return { status: "refused", reason: locked };
      }
      return edit(ws, loaded, now, (document) => setField(document, op.field, op.value));
    }

    case "delegated": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const outside = outsideRefusal(loaded.entity, op.via.project);
      if (outside) return { status: "refused", reason: outside };
      if (sameEdit(loaded, op.edit)) return { status: "already" };
      const forbidden = editRefusal(plan, loaded, op.edit, op.via.project);
      if (forbidden) return { status: "refused", reason: forbidden };
      if (revisionOf(loaded) !== op.expect_rev) return { status: "refused", reason: `${op.id} changed meanwhile` };
      const { brief, acceptance, priority, depends_on } = op.edit;
      return edit(ws, loaded, now, (document) => {
        if (brief !== undefined) document.body = writeBrief(document.body, demoteHeadings(brief));
        if (acceptance !== undefined) document.body = replaceAcceptance(document.body, acceptance);
        if (priority !== undefined && priority !== loaded.entity.priority) {
          setField(document, "priority", priority);
          // A rank is a place among the tasks of one priority: a new priority drops it.
          setField(document, "rank", undefined);
        }
        if (depends_on !== undefined) setField(document, "depends_on", depends_on);
      });
    }

    case "status": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const task = loaded.entity;
      if (task.status === op.to) return { status: "already" };
      if (hasLiveRun(task)) {
        return {
          status: "refused",
          reason: `${op.id} is held by ${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"}; release it first`,
        };
      }
      if (task.status !== op.expect) return { status: "refused", reason: `${op.id} is now ${task.status}` };
      if (!PERSON_STATUS[task.status].includes(op.to)) {
        return { status: "refused", reason: `${task.status} → ${op.to} is not allowed here` };
      }
      if (op.to === "todo" && task.status === "inbox" && !task.project) {
        return { status: "refused", reason: `${op.id} needs a project before it is accepted` };
      }
      return edit(ws, loaded, now, (document) => {
        setField(document, "status", op.to);
        // A person's status change leaves a closed task only for an open one (a reopen: back on the board),
        // and an open task's `archived` is a stale one an edit left: either way it goes (03-model.md, Archive).
        if (task.archived) setField(document, "archived", undefined);
      });
    }

    case "brief": {
      const loaded = ws.entity(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} no longer exists` };
      if (loaded.brief.trim() === op.text.trim()) return { status: "already" };
      if (loaded.briefHash !== op.expect_hash) return { status: "refused", reason: `the brief of ${op.id} changed meanwhile` };
      return edit(ws, loaded, now, (document) => {
        document.body = writeBrief(document.body, op.text);
      });
    }

    case "check": {
      const loaded = ws.entity(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} no longer exists` };
      if (op.run_id) {
        const task = ws.task(op.id)?.entity;
        if (!task || task.run_id !== op.run_id || !hasLiveRun(task)) return { status: "dropped", reason: "run not live" };
      }
      const line = loaded.acceptance.find((item) => item.text === op.line.trim());
      if (!line) return { status: "refused", reason: `no acceptance line «${op.line}» in ${op.id}` };
      if (line.done === op.done) return { status: "already" };
      return edit(ws, loaded, now, (document) => {
        document.body = writeAcceptance(document.body, op.line, op.done) ?? document.body;
      });
    }

    case "claim": {
      if (op.create) {
        const existing = ws.task(op.id)?.entity;
        if (existing?.run_id === op.run.run_id) return { status: "already" };
        // The task is new: no run or progress field comes from the create, only from the claim below.
        const fields = Object.fromEntries(
          Object.entries(op.create.fields).filter(([field]) => !PROTECTED_PREFIXES.some((prefix) => field.startsWith(prefix))),
        );
        const created = apply(ws, plan, { op_id: op.op_id, kind: "create", type: "task", id: op.id, fields: { ...fields, status: "todo" }, body: op.create.body }, now);
        // An adopted task is new work, never an earlier task that carries the same issue.
        if (created.status === "already") return { status: "refused", reason: `${created.id ?? "another task"} already carries this issue` };
        if (created.status !== "applied") return created;
        const claimed = apply(ws, plan, { op_id: op.op_id, kind: "claim", id: op.id, run: op.run }, now);
        if (claimed.status !== "applied") {
          // Never one without the other: the file just written goes again.
          for (const path of created.paths) rmSync(join(ws.root, path), { force: true });
          plan.entities.delete(op.id);
          return claimed.status === "already" ? { status: "refused", reason: `${op.id} could not be claimed` } : claimed;
        }
        return { status: "applied", paths: created.paths, tasksTouched: [op.id] };
      }
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const task = loaded.entity;
      if (task.run_id === op.run.run_id) return { status: "already" };
      if (hasLiveRun(task)) {
        return {
          status: "refused",
          reason: `already started by ${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"} at ${task.run_started ?? "?"}`,
        };
      }
      // In progress with no live run (unheld) is claimed as todo is: a person started it again.
      if (!startable(task)) return { status: "refused", reason: `${op.id} is ${task.status}, not todo` };
      return edit(ws, loaded, now, (document) => {
        const links = task.run_pr && !task.links.includes(task.run_pr) ? [...task.links, task.run_pr] : task.links;
        setField(document, "links", links);
        for (const field of ["run_pr", "run_ended", "run_review_at", "progress_done", "progress_total", "progress_note", "progress_at"]) {
          setField(document, field, undefined);
        }
        for (const [field, value] of Object.entries(op.run)) setField(document, field, value);
        setField(document, "status", "in_progress");
        if (task.archived) setField(document, "archived", undefined);
      });
    }

    case "progress": {
      const loaded = ws.task(op.id);
      if (!loaded || loaded.entity.run_id !== op.run_id || !hasLiveRun(loaded.entity)) {
        return { status: "dropped", reason: "run not live" };
      }
      const task = loaded.entity;
      const done = op.done ?? loaded.acceptance.filter((a) => a.done).length;
      const total = op.total ?? loaded.acceptance.length;
      if (task.progress_done === done && task.progress_total === total && task.progress_note === op.note) {
        return { status: "already" };
      }
      return edit(ws, loaded, now, (document) => {
        setField(document, "progress_done", done);
        setField(document, "progress_total", total);
        setField(document, "progress_note", op.note);
        setField(document, "progress_at", op.at);
      });
    }

    case "handoff": {
      const loaded = ws.task(op.id);
      if (!loaded || loaded.entity.run_id !== op.run_id || !hasLiveRun(loaded.entity)) {
        return { status: "dropped", reason: "run not live" };
      }
      const current = loaded.handoff;
      if (current?.run_id === op.run_id && current.text === demoteHeadings(op.text)) return { status: "already" };
      return edit(ws, loaded, now, (document) => {
        document.body = writeHandoff(document.body, { run_id: op.run_id, at: op.at, text: op.text });
      });
    }

    case "clarify": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} no longer exists` };
      if (isLastClarification(loaded.clarifications, op)) return { status: "already" };
      return edit(ws, loaded, now, (document) => {
        document.body = addClarification(document.body, op);
      });
    }

    case "transition": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "dropped", reason: "no such task" };
      const task = loaded.entity;
      // The run's own merge ended it: the same transition recorded again is already applied.
      if (task.run_id === op.run_id && task.status === op.to && (op.to !== "done" || task.run_ended)) {
        // Already in review (its agent said done) when its PR/MR is first seen: only the link is new.
        if (op.run_pr && task.run_pr !== op.run_pr && hasLiveRun(task)) {
          return edit(ws, loaded, now, (document) => setField(document, "run_pr", op.run_pr));
        }
        return { status: "already" };
      }
      if (task.run_id !== op.run_id || !hasLiveRun(task)) return { status: "dropped", reason: "run not live" };
      // The same PR/MR already moved the task to review once, and a person sent it back to work since:
      // a machine replaying that move late does not overrule them (05-architecture.md).
      if (op.to === "review" && op.run_pr && task.run_pr === op.run_pr && task.status === "in_progress") return { status: "already" };
      if (!RUN_TRANSITIONS[task.status].includes(op.to)) return { status: "dropped", reason: `${task.status} → ${op.to} is not a run transition` };
      // A merge ends the run only with the whole acceptance ticked, also when a machine decided on
      // an older copy of the plan: a merged PR/MR may hold only part of the work. A run whose
      // workspace its person archived is over all the same.
      if (op.to === "done" && !op.archived && loaded.acceptance.some((line) => !line.done)) return { status: "dropped", reason: "acceptance lines are not all ticked" };
      return edit(ws, loaded, now, (document) => {
        if (op.run_pr) setField(document, "run_pr", op.run_pr);
        if (op.to === "done") setField(document, "run_ended", op.at);
        if (op.to === "review") setField(document, "run_review_at", op.at);
        setField(document, "status", op.to);
      });
    }

    case "release": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const task = loaded.entity;
      if (task.run_id === op.run_id && task.run_ended) return { status: "already" };
      if (task.run_id !== op.run_id || !hasLiveRun(task)) {
        return { status: "refused", reason: `the run of ${op.id} you meant to release is no longer its live run` };
      }
      return edit(ws, loaded, now, (document) => {
        setField(document, "run_ended", op.at);
        setField(document, "status", op.to);
      });
    }

    case "archive": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const task = loaded.entity;
      if (!op.archived) {
        if (!task.archived) return { status: "already" };
        return edit(ws, loaded, now, (document) => setField(document, "archived", undefined));
      }
      if (!closed(task)) return { status: "refused", reason: `${op.id} is ${task.status}; only a done or canceled task is archived` };
      if (task.archived) return { status: "already" };
      return edit(ws, loaded, now, (document) => setField(document, "archived", op.at));
    }

    case "label": {
      const loaded = ws.task(op.id);
      if (!loaded) return { status: "refused", reason: `${op.id} is not a task` };
      const labels = loaded.entity.labels;
      const present = labels.some((label) => sameLabel(label, op.label));
      if (present === op.add) return { status: "already" };
      // A label the palette spells some other way (written by hand) may still be added as spelled there.
      if (op.add && cleanLabel(op.label) !== op.label && !findLabel(plan.space?.labels ?? {}, op.label)) {
        return { status: "refused", reason: `«${op.label}» is not a usable label` };
      }
      // Written as the palette spells it when it applies, whoever typed it in which case.
      const spelled = findLabel(plan.space?.labels ?? {}, op.label)?.[0] ?? op.label;
      return edit(ws, loaded, now, (document) =>
        setField(document, "labels", op.add ? [...labels, spelled] : labels.filter((label) => !sameLabel(label, op.label))),
      );
    }

    case "derived": {
      const loaded = ws.entity(op.id);
      if (!loaded || loaded.entity.type !== "feature") return { status: "dropped", reason: "no such feature" };
      if (loaded.entity.status === op.to) return { status: "already" };
      if (op.expect && loaded.entity.status !== op.expect) return { status: "dropped", reason: "the feature's status changed meanwhile" };
      if (derivedFeatureStatus(plan, op.id) !== op.to) return { status: "dropped", reason: "condition no longer holds" };
      return edit(ws, loaded, now, (document) => setField(document, "status", op.to));
    }
  }
}

const OPEN_STATUSES = new Set<TaskStatus>(["inbox", "todo", "in_progress", "review"]);

/** The task (any status) whose `issue` is this issue key (shared/issues.ts), if any. */
export function taskWithIssue(plan: Plan, key: string): Task | undefined {
  for (const loaded of plan.entities.values()) {
    const entity = loaded.entity;
    if (entity.type === "task" && entity.issue && issueKey(entity.issue) === key) return entity;
  }
  return undefined;
}

/** Tasks not done or canceled that name the project. */
export function openTasksOf(plan: Plan, project: string): Task[] {
  return [...plan.entities.values()]
    .map((l) => l.entity)
    .filter((e): e is Task => e.type === "task" && e.project === project && OPEN_STATUSES.has(e.status));
}

type SpaceEdit = Extract<Operation, { kind: "project" | "project_order" }>;

/**
 * Whether a change of space.yaml's projects would be refused or is already there, read from `plan`
 * without writing anything; undefined when it would apply.
 */
export function checkSpaceEdit(plan: Plan, op: SpaceEdit): Extract<Outcome, { status: "refused" | "already" }> | undefined {
  if (!plan.space) return { status: "refused", reason: "space.yaml cannot be read; fix it first" };
  const projects = plan.space.projects;
  if (op.kind === "project_order") {
    const keys = Object.keys(projects);
    if (same(keys, op.order)) return { status: "already" };
    if (!same(keys, op.expect)) return { status: "refused", reason: "the list of projects changed meanwhile" };
    return undefined;
  }
  const current = projectFields(ownProject(projects, op.key));
  const value = projectFields(op.value);
  if (same(current, value)) return { status: "already" };
  if (!same(current, projectFields(op.expect))) {
    if (!op.expect) return { status: "refused", reason: `project ${op.key} already exists` };
    if (!current) return { status: "refused", reason: `project ${op.key} no longer exists` };
    return { status: "refused", reason: `project ${op.key} changed meanwhile` };
  }
  if (value === null) {
    const open = openTasksOf(plan, op.key);
    if (open.length) return { status: "refused", reason: `${open.length} open task(s) use ${op.key}: ${open.slice(0, 3).map((t) => t.id).join(", ")}` };
    return undefined;
  }
  const remote = normalizeRemote(value.remote);
  const twin = Object.entries(projects).find(([key, p]) => key !== op.key && normalizeRemote(p.remote) === remote);
  if (twin) return { status: "refused", reason: `${value.remote} is already listed as ${twin[0]}` };
  return undefined;
}

function applySpaceEdit(ws: Workspace, plan: Plan, op: SpaceEdit): Outcome {
  const check = checkSpaceEdit(plan, op);
  // A pinned color is never anyone's conflict: someone named a color meanwhile, or the line changed.
  if (check?.status === "refused" && op.kind === "project" && op.pin) return { status: "dropped", reason: check.reason };
  if (check) return check;
  const value = op.kind === "project" ? projectFields(op.value) : null;
  if (op.kind === "project_order") editSpace(ws.root, plan, { kind: "order", order: op.order });
  else if (value === null) editSpace(ws.root, plan, { kind: "remove", key: op.key });
  else editSpace(ws.root, plan, { kind: "put", key: op.key, fields: value });
  return { status: "applied", paths: ["space.yaml"], tasksTouched: [] };
}

/** The tasks of a feature (by reference, any form). */
export function featureTasks(plan: Plan, featureId: string): Task[] {
  return [...plan.entities.values()]
    .map((loaded) => loaded.entity)
    .filter((entity): entity is Task => entity.type === "task" && refId(entity.feature) === featureId);
}

/**
 * What the feature's status should become after a change of its tasks (D15), or undefined when it
 * stays: all tasks that are neither canceled nor drafts done (at least one) → done; a done feature with
 * such a task not done → active. A canceled feature never changes by itself.
 */
export function derivedFeatureStatus(plan: Plan, featureId: string): "done" | "active" | undefined {
  const feature = plan.entities.get(featureId)?.entity;
  if (!feature || feature.type !== "feature" || feature.status === "canceled") return undefined;
  // Drafts are not accepted work yet: like canceled tasks, they neither hold a feature open nor reopen it.
  const open = featureTasks(plan, featureId).filter((task) => task.status !== "canceled" && task.status !== "inbox");
  if (open.length > 0 && open.every((task) => task.status === "done")) return feature.status === "done" ? undefined : "done";
  if (feature.status === "done" && open.some((task) => task.status !== "done")) return "active";
  return undefined;
}

/** Tasks that carry a label (any status), by id. */
export function tasksLabelled(plan: Plan, label: string): string[] {
  return [...plan.entities.values()]
    .map((l) => l.entity)
    .filter((e): e is Task => e.type === "task" && e.labels.some((l) => sameLabel(l, label)))
    .map((t) => t.id);
}

type LabelDef = Extract<Operation, { kind: "label_def" }>;

/** Whether a change of the label palette would be refused or is already there; undefined when it would apply. */
export function checkLabelDef(plan: Plan, op: LabelDef): Extract<Outcome, { status: "refused" | "already" }> | undefined {
  if (!plan.space) return { status: "refused", reason: "space.yaml cannot be read; fix it first" };
  const found = findLabel(plan.space.labels, op.name);
  const current = labelFields(found?.[1]);
  const value = labelFields(op.value);
  if (op.if_absent && current) return { status: "already" };
  if (same(current, value)) return { status: "already" };
  if (!same(current, labelFields(op.expect))) {
    if (!op.expect) return { status: "refused", reason: `label ${op.name} already exists` };
    if (!current) return { status: "refused", reason: `label ${op.name} no longer exists` };
    return { status: "refused", reason: `label ${op.name} changed meanwhile` };
  }
  if (value === null) {
    const using = tasksLabelled(plan, op.name);
    if (using.length) return { status: "refused", reason: `${using.length} task(s) carry ${op.name}: ${using.slice(0, 3).join(", ")}` };
    return undefined;
  }
  if (!found && cleanLabel(op.name) !== op.name) return { status: "refused", reason: `«${op.name}» is not a usable label` };
  return undefined;
}

function applyLabelDef(ws: Workspace, plan: Plan, op: LabelDef): Outcome {
  const check = checkLabelDef(plan, op);
  if (check) return check;
  const key = findLabel(plan.space!.labels, op.name)?.[0] ?? op.name;
  const value = labelFields(op.value);
  editSpace(ws.root, plan, value === null ? { kind: "drop", section: "labels", key } : { kind: "label", key, fields: value });
  return { status: "applied", paths: ["space.yaml"], tasksTouched: [] };
}

type PersonOp = Extract<Operation, { kind: "person" }>;

/** Whether a change of space.yaml's people would be refused or is already there; undefined when it would apply. */
export function checkPerson(plan: Plan, op: PersonOp): Extract<Outcome, { status: "refused" | "already" }> | undefined {
  if (!plan.space) return { status: "refused", reason: "space.yaml cannot be read; fix it first" };
  const people = plan.space.people;
  const current = personFields(Object.hasOwn(people, op.key) ? people[op.key] : undefined);
  const value = personFields(op.value);
  if (same(current, value)) return { status: "already" };
  if (!same(current, personFields(op.expect))) {
    if (!op.expect) return { status: "refused", reason: `person ${op.key} already exists` };
    if (!current) return { status: "refused", reason: `person ${op.key} no longer exists` };
    return { status: "refused", reason: `person ${op.key} changed meanwhile` };
  }
  if (value === null) {
    const open = [...plan.entities.values()]
      .map((l) => l.entity)
      .filter((e): e is Task => e.type === "task" && OPEN_STATUSES.has(e.status) && e.assignee === op.key);
    if (open.length) return { status: "refused", reason: `${open.length} open task(s) are assigned to ${op.key}: ${open.slice(0, 3).map((t) => t.id).join(", ")}` };
    return undefined;
  }
  if (!current && !PERSON_KEY_PATTERN.test(op.key)) return { status: "refused", reason: `${JSON.stringify(op.key)} is not a person key` };
  const twin = current ? undefined : Object.keys(people).find((key) => key.toLowerCase() === op.key.toLowerCase());
  if (twin) return { status: "refused", reason: `person ${twin} already exists` };
  return undefined;
}

function applyPerson(ws: Workspace, plan: Plan, op: PersonOp): Outcome {
  const check = checkPerson(plan, op);
  if (check) return check;
  const value = personFields(op.value);
  editSpace(ws.root, plan, value === null ? { kind: "drop", section: "people", key: op.key } : { kind: "person", key: op.key, fields: value });
  return { status: "applied", paths: ["space.yaml"], tasksTouched: [] };
}

/** The features whose task set a change of these tasks touches (before and after the change). */
export function featuresOf(plan: Plan, taskIds: string[], before: Map<string, string | undefined>): string[] {
  const ids = new Set<string>();
  for (const id of taskIds) {
    const now = plan.entities.get(id)?.entity;
    if (now?.type === "task" && refId(now.feature)) ids.add(refId(now.feature)!);
    const earlier = before.get(id);
    if (earlier) ids.add(earlier);
  }
  return [...ids];
}

export { briefHash };
