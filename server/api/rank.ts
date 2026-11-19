import { hasLiveRun, type Task } from "../../shared/model.ts";
import type { Operation } from "../sync/ops.ts";
import type { Plan } from "../plan/load.ts";
import { opaqueId } from "../plan/ids.ts";
import { describe } from "./resolve.ts";
import { priorityRank, sortTasks, taskSection } from "./view.ts";

/**
 * A person's moves of a task among the tasks waiting to start (D21): up, down, to the top or the
 * bottom, or next to another task, always inside its own space, section (ready, blocked or drafts)
 * and priority. Getting above a task of another priority is a change of priority, not a move.
 *
 * Ranks are numbers, lower first, a step apart. A move writes only the moved task's rank when it fits
 * between its new neighbours; when a neighbour has no rank yet, or the gap is used up, every task of
 * the group gets a rank in the new order, in the same commit. Each write is a `set` with the rank it
 * replaces, so a move someone else made meanwhile refuses instead of being overwritten.
 */

export const RANK_POSITIONS = ["top", "bottom", "up", "down", "before", "after"] as const;
export type RankPosition = (typeof RANK_POSITIONS)[number];

export const RANK_STEP = 1000;
/** Below this gap a midpoint is no longer distinct enough: the group is numbered again. */
const MIN_GAP = 1e-6;

type Answer = { ok: true; ops: Operation[]; changed: number } | { ok: false; error: string };

/** Whether a task has a place a person can change: it waits to start (todo, no live run) or is a draft. */
export function rankable(task: Task): boolean {
  return (task.status === "todo" && !hasLiveRun(task)) || task.status === "inbox";
}

/** The tasks a task is ordered among: its section and its priority in its own space, in list order. */
export function rankGroup(plan: Plan, task: Task): Task[] {
  const section = taskSection(plan, task);
  const priority = priorityRank(plan, task);
  const own = [...plan.entities.values()]
    .map((loaded) => loaded.entity)
    .filter((e): e is Task => e.type === "task" && rankable(e) && taskSection(plan, e) === section && priorityRank(plan, e) === priority);
  return sortTasks(own.map((t) => ({ plan, task: t }))).map(({ task: t }) => t);
}

/** The operations that move `task` to `position` (`other` for before/after); none when it is there already. */
export function rankOps(plan: Plan, task: Task, position: RankPosition, other?: Task): Answer {
  const name = `«${task.title}» (${task.id})`;
  if (!rankable(task)) return { ok: false, error: `${name} is ${task.status}${hasLiveRun(task) ? " with a live run" : ""}; only tasks waiting to start and drafts have a place to move to.` };
  const group = rankGroup(plan, task);
  const from = group.findIndex((t) => t.id === task.id);
  const rest = group.filter((t) => t.id !== task.id);
  let to: number;
  switch (position) {
    case "top":
      to = 0;
      break;
    case "bottom":
      to = rest.length;
      break;
    case "up":
      to = Math.max(0, from - 1);
      break;
    case "down":
      to = Math.min(rest.length, from + 1);
      break;
    default: {
      if (!other) return { ok: false, error: `Name the task to put ${name} ${position}.` };
      if (other.id === task.id) return { ok: false, error: `${name} cannot go ${position} itself.` };
      const at = rest.findIndex((t) => t.id === other.id);
      if (at < 0) {
        const why = !rankable(other)
          ? `it is ${other.status}${hasLiveRun(other) ? " with a live run" : ""}`
          : taskSection(plan, other) !== taskSection(plan, task)
            ? `it is ${taskSection(plan, other)} and ${task.id} is ${taskSection(plan, task)}`
            : priorityRank(plan, other) !== priorityRank(plan, task)
              ? `its priority is ${other.priority ?? "the default"} and ${task.id}'s is ${task.priority ?? "the default"}; change the priority to move between them`
              : "it is in another space";
        return { ok: false, error: `${name} cannot go ${position} ${describe(other)}: ${why}. Nothing was changed.` };
      }
      to = position === "before" ? at : at + 1;
    }
  }
  const order = [...rest.slice(0, to), task, ...rest.slice(to)];
  if (order.every((t, i) => t.id === group[i]!.id) && task.rank !== undefined) return { ok: true, ops: [], changed: 0 };
  const before = order[to - 1];
  const after = order[to + 1];
  const set = (t: Task, value: number): Operation => ({ op_id: opaqueId("op"), kind: "set", id: t.id, field: "rank", value, expect: t.rank ?? null });
  // Only the moved task when its new neighbours have ranks and leave room between them.
  const low = before ? before.rank : undefined;
  const high = after ? after.rank : undefined;
  const fits = (!before || low !== undefined) && (!after || high !== undefined);
  if (fits) {
    const value = low === undefined && high === undefined ? RANK_STEP : low === undefined ? high! - RANK_STEP : high === undefined ? low + RANK_STEP : (low + high) / 2;
    if ((low === undefined || value - low > MIN_GAP) && (high === undefined || high - value > MIN_GAP)) {
      return { ok: true, ops: [set(task, value)], changed: 1 };
    }
  }
  // Number the whole group in its new order.
  const ops = order.flatMap((t, i) => (t.rank === (i + 1) * RANK_STEP ? [] : [set(t, (i + 1) * RANK_STEP)]));
  return { ok: true, ops, changed: ops.length };
}
