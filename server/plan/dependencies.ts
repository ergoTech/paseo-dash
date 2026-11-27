import { refId } from "../../shared/model.ts";
import type { Plan } from "./load.ts";

/**
 * The chain back to `self` that waiting for `deps` would close, as ids (`B → C → self`), or undefined:
 * a loop of dependencies blocks every task in it for good.
 */
export function dependencyLoop(plan: Plan, self: string, deps: string[]): string[] | undefined {
  const waitsFor = (id: string) => {
    const entity = plan.entities.get(id)?.entity;
    return entity?.type === "task" ? entity.depends_on.map((ref) => refId(ref)).filter((d): d is string => Boolean(d)) : [];
  };
  for (const start of deps.map((d) => refId(d)).filter((d): d is string => Boolean(d))) {
    const seen = new Set<string>();
    const walk = (id: string, path: string[]): string[] | undefined => {
      if (id === self) return path;
      if (seen.has(id)) return undefined;
      seen.add(id);
      for (const next of waitsFor(id)) {
        const found = walk(next, [...path, next]);
        if (found) return found;
      }
      return undefined;
    };
    const found = walk(start, [start]);
    if (found) return found;
  }
  return undefined;
}
