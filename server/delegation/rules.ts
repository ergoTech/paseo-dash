import { createHash } from "node:crypto";
import type { DelegatedAction } from "../../shared/delegation.ts";
import { sameLabel } from "../../shared/labels.ts";
import { hasLiveRun, PRIORITIES, refId, type Task } from "../../shared/model.ts";
import { dependencyLoop } from "../plan/dependencies.ts";
import { demoteHeadings } from "../plan/document.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";

/**
 * What a delegated change may do to the plan. These checks run when the coordinator asks and again
 * every time its operation is applied on top of origin (server/sync/ops.ts), so a start, a person's
 * edit or a mark that reached the plan in between refuses it. Whether the permission itself still
 * stands is a separate check (server/delegation/store.ts, objection).
 */

/** The permission an operation was asked under; it travels with the operation in the journal. */
export interface Via {
  grant: string;
  agent: string;
  project: string;
  /** The rules' revision when it was asked: a revocation after it refuses it for good (store.ts). */
  revision: number;
}

type Priority = (typeof PRIORITIES)[number];

/** The fields a coordinator can change on an existing card; nothing else of a card is reachable. */
export interface DelegatedEdit {
  brief?: string;
  acceptance?: string[];
  priority?: Priority;
  /** The whole new list, as the plan stores references. */
  depends_on?: string[];
}

const EDIT_FIELDS = new Set(["brief", "acceptance", "priority", "depends_on"]);

export function actionsOf(edit: DelegatedEdit): DelegatedAction[] {
  const actions: DelegatedAction[] = [];
  if (edit.brief !== undefined || edit.acceptance !== undefined) actions.push("drafts");
  if (edit.priority !== undefined) actions.push("priority");
  if (edit.depends_on !== undefined) actions.push("dependencies");
  return actions;
}

/**
 * The card as a coordinator read it: every part of it except the times, which a replay of the same
 * changes on origin writes anew. A change names the revision it was made from.
 */
export function revisionOf(loaded: LoadedEntity): string {
  const { created: _created, updated: _updated, ...entity } = loaded.entity as Task;
  const state = [entity, loaded.brief, loaded.acceptance, loaded.notes, loaded.clarifications ?? "", loaded.handoff ?? null];
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

/** A dependency as the plan compares it: the id it points at, or the text of a reference to nothing. */
export const depKey = (reference: string): string => refId(reference) ?? reference;

/** Whether the card already reads as the change asks, so there is nothing to write. */
export function sameEdit(loaded: LoadedEntity, edit: DelegatedEdit): boolean {
  const task = loaded.entity as Task;
  if (edit.brief !== undefined && demoteHeadings(edit.brief) !== loaded.brief.trim()) return false;
  if (edit.acceptance !== undefined && JSON.stringify(edit.acceptance) !== JSON.stringify(loaded.acceptance.map((line) => line.text))) return false;
  if (edit.priority !== undefined && edit.priority !== task.priority) return false;
  if (edit.depends_on !== undefined && JSON.stringify(edit.depends_on.map(depKey)) !== JSON.stringify(task.depends_on.map(depKey))) return false;
  return true;
}

/** The card is outside the permission's project: said before anything about the card itself. */
export function outsideRefusal(task: Task, project: string): string | undefined {
  return task.project === project ? undefined : `${task.id} is not a card of project ${project}`;
}

/** Why no delegated change may touch this card now; undefined when some may. */
export function cardRefusal(plan: Plan, task: Task, project: string): string | undefined {
  if (!plan.space) return "space.yaml cannot be read, so the project and the marks of manual work are unknown";
  if (!Object.hasOwn(plan.space.projects, project)) return `project ${project} is no longer in the space`;
  const outside = outsideRefusal(task, project);
  if (outside) return outside;
  if (plan.duplicates.has(task.id)) return `${task.id} is claimed by two files; rename one first`;
  if (hasLiveRun(task)) return `${task.id} has an active run`;
  const marks = plan.space.defaults.human_labels;
  const mark = task.labels.find((label) => marks.some((m) => sameLabel(m, label)));
  if (mark) return `${task.id} is marked as a person's work («${mark}»)`;
  if (task.status !== "inbox" && task.status !== "todo") return `${task.id} is ${task.status}; only drafts and todo cards are prepared`;
  return undefined;
}

/** Why the brief or acceptance cannot change; whose draft it is is checked with the permission. */
export function textRefusal(task: Task): string | undefined {
  if (task.status !== "inbox") return `${task.id} is ${task.status}; only a draft's brief and acceptance are edited`;
  if (task.run_id) return `${task.id} was already started once`;
  return undefined;
}

function dependencyRefusal(plan: Plan, task: Task, next: string[], project: string): string | undefined {
  const before = new Set(task.depends_on.map(depKey));
  const after = next.map(depKey);
  if (new Set(after).size !== after.length) return "a dependency is listed twice";
  const removed = [...before].filter((key) => !after.includes(key));
  const added = after.filter((key) => !before.has(key));
  // Taking a dependency off a todo card can make it ready, and the autopilot may then start it.
  if (removed.length && task.status !== "inbox") return `${task.id} is ${task.status}; a dependency is removed from drafts only`;
  for (const key of [...removed, ...added]) {
    if (key === task.id) return "a card cannot depend on itself";
    const other = plan.entities.get(key)?.entity;
    if (other?.type !== "task" || other.project !== project || plan.duplicates.has(key)) {
      return `${key} is not a card of project ${project}; only dependencies between its cards are added or removed`;
    }
  }
  const loop = added.length ? dependencyLoop(plan, task.id, next) : undefined;
  if (loop) {
    // A loop may run through other projects: their cards are not named to this coordinator.
    const named = loop.map((id) => {
      const entity = plan.entities.get(id)?.entity;
      return entity?.type === "task" && entity.project === project ? id : "(a card of another project)";
    });
    return `${task.id} cannot wait for ${named.join(" → ")}: that is a loop of dependencies`;
  }
  return undefined;
}

/** Why this change is not allowed on this card as the plan has it now; undefined when it is. */
export function editRefusal(plan: Plan, loaded: LoadedEntity, edit: DelegatedEdit, project: string): string | undefined {
  const task = loaded.entity as Task;
  const card = cardRefusal(plan, task, project);
  if (card) return card;
  const unknown = Object.keys(edit).find((field) => !EDIT_FIELDS.has(field));
  if (unknown) return `${unknown} cannot be changed by delegation`;
  if (!actionsOf(edit).length) return "nothing to change";
  if (edit.brief !== undefined || edit.acceptance !== undefined) {
    const text = textRefusal(task);
    if (text) return text;
    if (edit.acceptance?.some((line) => !line.trim() || line !== line.trim() || /[\r\n\u2028\u2029]/.test(line))) return "an acceptance line is one line of text";
  }
  if (edit.priority !== undefined && !PRIORITIES.includes(edit.priority)) return `priority must be one of ${PRIORITIES.join(", ")}`;
  if (edit.depends_on !== undefined) return dependencyRefusal(plan, task, edit.depends_on, project);
  return undefined;
}

/** Why a delegated create is not one: only a bare Inbox draft of the permission's project. */
export function createRefusal(plan: Plan, type: string, fields: Record<string, unknown>, project: string): string | undefined {
  if (!plan.space || !Object.hasOwn(plan.space.projects, project)) return `project ${project} is not in the space`;
  const extra = Object.keys(fields).find((field) => !["title", "status", "project"].includes(field));
  if (type !== "task" || extra || fields.status !== "inbox" || fields.project !== project) {
    return `only an Inbox draft of project ${project} is created by delegation`;
  }
  return undefined;
}
