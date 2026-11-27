import { closed, hasLiveRun, type Task } from "../../shared/model.ts";
import { normalLine } from "../api/similarity.ts";
import { tasksOf } from "../api/view.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";

/**
 * Confirmed duplicates among a project's open cards, by the cards' own facts only: both stand for the
 * same forge issue, or title, brief and acceptance say the same. A similar title or alike lines are
 * no duplicate: the ready review lists those as signals for a person (server/api/ready-review.ts).
 * Nothing here changes a card: the owner cancels the duplicate.
 */

export interface Duplicate {
  /** The card that stays. */
  of: string;
  why: string;
}

/** The one that stays: work under way first, then the furthest along, then the oldest. */
const STATUS_ORDER: Task["status"][] = ["review", "in_progress", "todo", "inbox"];

function first(a: Task, b: Task): number {
  return (
    Number(hasLiveRun(b)) - Number(hasLiveRun(a)) ||
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    (a.created ?? "~").localeCompare(b.created ?? "~") ||
    a.id.localeCompare(b.id)
  );
}

function issueKey(task: Task): string {
  return task.issue ? task.issue.trim().replace(/[/#?]+$/, "").toLowerCase() : "";
}

/** "" when the card says too little for two of them to be the same by their text. */
function textKey(loaded: LoadedEntity): string {
  const brief = normalLine(loaded.brief);
  const lines = loaded.acceptance.map((line) => normalLine(line.text)).filter(Boolean);
  return brief && lines.length ? JSON.stringify([normalLine(loaded.entity.title), brief, lines]) : "";
}

export function confirmedDuplicates(plan: Plan, project: string): Map<string, Duplicate> {
  const open = tasksOf(plan)
    .filter((task) => task.project === project && !closed(task))
    .sort(first);
  const seen = new Map<string, string>();
  const out = new Map<string, Duplicate>();
  for (const task of open) {
    const issue = issueKey(task);
    const text = textKey(plan.entities.get(task.id)!);
    const keys = [
      ...(issue ? [{ key: `issue:${issue}`, why: "both stand for the same issue" }] : []),
      ...(text ? [{ key: `text:${text}`, why: "title, brief and acceptance say the same" }] : []),
    ];
    const twin = keys.find(({ key }) => seen.has(key));
    if (twin) out.set(task.id, { of: seen.get(twin.key)!, why: twin.why });
    // A duplicate's own keys lead to the card that stays.
    for (const { key } of keys) if (!seen.has(key)) seen.set(key, out.get(task.id)?.of ?? task.id);
  }
  return out;
}
