import { refId, type Task } from "../../shared/model.ts";
import type { Plan } from "../plan/load.ts";
import type { CardFacts, PrFact } from "./facts.ts";

/**
 * What stands between an open PR/MR and its merge, each blocker apart: its checks, its review, whether
 * the forge would merge it, and the cards it depends on. Ready means the forge itself confirmed all
 * of them; a fact it did not give is a blocker, never a pass. `queue`: the open PR/MRs of the other
 * cards in the same list, so a dependency that has one says "merge it first"; `codeMerged`: a dependency
 * whose own PR/MRs are all merged no longer holds a merge back, whatever its QA says.
 */
export function mergeBlockers(plan: Plan, task: Task, facts: CardFacts, pr: PrFact, queue: Map<string, PrFact[]>, noChecksOk: boolean, codeMerged: (id: string) => boolean): string[] {
  const out: string[] = [];
  const checks = pr.checks;
  if (pr.state === "draft") out.push("it is a draft");
  if (facts.trunk && pr.base !== facts.trunk) out.push(`it targets ${pr.base || "an unknown branch"}, not ${facts.trunk}`);
  if (!checks) out.push("checks: not known");
  else if (checks.state === "failing") out.push(`checks fail: ${checks.failing.join(", ") || "failed"}`);
  else if (checks.state === "pending") out.push("checks are still running");
  else if (checks.state === "waiting") out.push("checks wait for a manual job");
  else if (checks.state === "none" && !noChecksOk) out.push("no check ran");
  if (pr.review === "changes requested") out.push("review: changes requested");
  else if (pr.review === "review required") out.push("review: required, not given");
  if (pr.merge.state !== "yes") out.push(`mergeability: ${pr.merge.why || "not confirmed by the forge"}`);
  for (const ref of task.depends_on) {
    const id = refId(ref) ?? ref;
    const other = plan.entities.get(id)?.entity;
    if (other?.type !== "task") out.push(`dependency ${id} is not in the plan`);
    // A dependency whose open PR/MR is this very one merges with it.
    else if (queue.get(id)?.some((other) => other.url !== pr.url)) out.push(`merge ${queue.get(id)!.find((other) => other.url !== pr.url)!.label} (${id}) first`);
    else if (queue.has(id)) continue;
    // Code merged is all a merge waits for: its QA and acceptance are another step (a merge accepts nothing).
    else if (other.status !== "done" && other.status !== "canceled" && !codeMerged(id)) out.push(`waits for ${id} (${other.status}, its code is not merged)`);
  }
  const unread = facts.unknown[0] ?? facts.limits[0]?.why;
  if (unread) out.push(`forge facts incomplete: ${unread}`);
  return out;
}
