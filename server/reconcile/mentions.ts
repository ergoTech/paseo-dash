import type { Task } from "../../shared/model.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import type { Dashboard } from "../dashboard.ts";
import { mentionOnly } from "../tracker/merged.ts";
import { mergedSince } from "./facts.ts";

/**
 * The merged PR/MRs that name a task in their description and nowhere else that ties them to it
 * (03-model.md, Mentions): a reference to show with its link, never the task's merged work.
 */

export interface MentionedPr {
  label: string;
  url: string;
}

/** Mentions named in one note; the rest are counted. */
const NAMED = 3;

/** From this Mac's last readings, the merged tracker's and the reconciliation's; asks no forge. */
export function mergedMentions(dashboard: Dashboard, space: SpaceEntry, task: Task): MentionedPr[] {
  const plan = space.sync.plan;
  const facts = dashboard.reconciler.latest(space, task)?.prs ?? [];
  // Whatever either reading ties by more than a mention is no mention: they are made at different times.
  const work = new Set([...dashboard.merged.shown(plan, task), ...facts.filter((pr) => !mentionOnly(pr.ways))].map((pr) => pr.url));
  const read = facts.filter((pr) => pr.state === "merged" && mentionOnly(pr.ways) && mergedSince(pr, task.created));
  const out = new Map<string, MentionedPr>();
  for (const { label, url } of [...dashboard.merged.mentioned(plan, task), ...read]) {
    if (!work.has(url)) out.set(url, { label, url });
  }
  return [...out.values()];
}

/** The mentions as one sentence, links included; "" without any. */
export function mentionText(id: string, mentions: MentionedPr[]): string {
  if (!mentions.length) return "";
  const named = mentions.slice(0, NAMED).map((pr) => `${pr.label} (${pr.url})`);
  const more = mentions.length > NAMED ? ` and ${mentions.length - NAMED} more` : "";
  return `Mentioned in ${named.join(", ")}${more}: only the description names ${id}, so it is not counted as its merged work.`;
}
