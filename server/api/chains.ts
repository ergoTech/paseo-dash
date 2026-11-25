import { closed, refId, type Task } from "../../shared/model.ts";
import type { Plan } from "../plan/load.ts";
import { blockingTasks, tasksOf } from "./view.ts";

/**
 * Dependency chains of the open work, for the ready review: which task at the start of a chain holds
 * the most others back. A root is a task others wait for that itself waits for nothing; a reference
 * to no task is a root too, since only fixing it frees what waits for it.
 */

export interface Root {
  /** The task's id, or the reference as written when it names no task. */
  id: string;
  task: Task | undefined;
  /** Open tasks of the scope waiting for it, directly or through other tasks, nearest first. */
  blocked: string[];
  /** How many of them wait for it directly. */
  direct: number;
}

export interface Chains {
  /** Most blocked first. */
  roots: Root[];
  /** The roots each blocked task waits for, by task id. */
  rootsOf: Map<string, string[]>;
  /** Open tasks of the scope on a dependency cycle or behind one: finishing no root frees them. */
  cycles: string[];
}

/** The open tasks no order of finishing frees: those on a cycle, and those waiting for one of them. */
function stuckOn(waits: Map<string, string[]>, dependents: Map<string, string[]>): Set<string> {
  const left = new Map([...waits].map(([id, blockers]) => [id, blockers.length]));
  const free = [...new Set([...dependents.keys()].filter((id) => !left.get(id)))];
  while (free.length) {
    for (const next of dependents.get(free.pop()!) ?? []) {
      left.set(next, left.get(next)! - 1);
      if (!left.get(next)) free.push(next);
    }
  }
  return new Set([...left].filter(([, count]) => count > 0).map(([id]) => id));
}

/** `inScope`: whose waiting counts; a root itself may lie outside (another project of the space). */
export function chainsOf(plan: Plan, inScope: (task: Task) => boolean): Chains {
  const open = tasksOf(plan).filter((task) => !closed(task));
  const waits = new Map(open.map((task) => [task.id, [...new Set(blockingTasks(plan, task).map((b) => b.id))]]));
  const dependents = new Map<string, string[]>();
  for (const [id, blockers] of waits) {
    for (const blocker of blockers) dependents.set(blocker, [...(dependents.get(blocker) ?? []), id]);
  }
  const scoped = new Set(open.filter(inScope).map((task) => task.id));
  const stuck = stuckOn(waits, dependents);
  const roots: Root[] = [];
  const rootsOf = new Map<string, string[]>();
  for (const [id, first] of dependents) {
    if (waits.get(id)?.length) continue;
    // Breadth first: the nearest tasks are named first.
    const seen = new Set<string>([id]);
    const queue = [...first];
    const blocked: string[] = [];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      // A task on a cycle, and what waits for it, is not freed by this root.
      if (stuck.has(next)) continue;
      if (scoped.has(next)) blocked.push(next);
      queue.push(...(dependents.get(next) ?? []));
    }
    if (!blocked.length) continue;
    const entity = plan.entities.get(id)?.entity;
    roots.push({ id, task: entity?.type === "task" ? entity : undefined, blocked, direct: first.filter((d) => blocked.includes(d)).length });
    for (const task of blocked) rootsOf.set(task, [...(rootsOf.get(task) ?? []), id]);
  }
  roots.sort((a, b) => b.blocked.length - a.blocked.length || b.direct - a.direct || a.id.localeCompare(b.id));
  const cycles = [...scoped].filter((id) => stuck.has(id)).sort();
  return { roots, rootsOf, cycles };
}

/** Every task a task depends on, directly or not, done ones included. */
export function ancestorsOf(plan: Plan): (id: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  return (id) => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const entity = plan.entities.get(queue.pop()!)?.entity;
      if (entity?.type !== "task") continue;
      for (const ref of entity.depends_on) {
        const other = refId(ref);
        if (!other || other === id || out.has(other)) continue;
        out.add(other);
        queue.push(other);
      }
    }
    memo.set(id, out);
    return out;
  };
}
