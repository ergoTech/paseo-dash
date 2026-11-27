import type { Task } from "../../shared/model.ts";
import { plannedBranch, tasksOf } from "../api/view.ts";
import type { Plan } from "../plan/load.ts";
import { prKey } from "../tracker/forge.ts";
import { type MatchedBy, namedIds } from "../tracker/merged.ts";

/**
 * Whose work a PR/MR is, for closing a card by rule. Looser than showing it: the review of the open
 * cards (server/api/ready-review.ts) says "a signal, not proof" and lets a person look; a closure has
 * no person looking, so a PR/MR is a card's own only when something names the card itself and nothing
 * gives it to another: no other card's run reported it, it names no other card, no other card links it
 * or plans on its branch. A mention in a description is never enough.
 */

export type Way = MatchedBy | "run";

export interface TieIndex {
  /** PR/MR (by prKey) → the cards whose run reported it, and those that link it. */
  claims: Map<string, string[]>;
  links: Map<string, string[]>;
  /** `<project>\n<branch>` → the cards that plan or ran on it. */
  branches: Map<string, string[]>;
  tasks: Set<string>;
}

const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);

export function tieIndex(plan: Plan): TieIndex {
  const index: TieIndex = { claims: new Map(), links: new Map(), branches: new Map(), tasks: new Set() };
  for (const task of tasksOf(plan)) {
    index.tasks.add(task.id);
    if (task.run_pr) add(index.claims, prKey(task.run_pr), task.id);
    for (const link of new Set(task.links.map(prKey))) add(index.links, link, task.id);
    if (task.project && task.status !== "canceled") add(index.branches, `${task.project}\n${task.run_branch ?? plannedBranch(plan, task)}`, task.id);
  }
  return index;
}

export interface Tie {
  own: boolean;
  /** Why it is not the card's own, or what is shared; empty when nothing doubts it. */
  doubts: string[];
  /**
   * Another card's work that only a shared branch brings to this one: the branch is the sole tie, other
   * cards plan on it, another card's run reported it or it names another card, and neither its title
   * nor its branch names this one.
   */
  theirs: boolean;
}

export function judgeTie(index: TieIndex, task: Task, pr: { url: string; head: string; title: string }, ways: Way[]): Tie {
  const key = prKey(pr.url);
  const others = (ids: string[] | undefined) => (ids ?? []).filter((id) => id !== task.id);
  const listed = (ids: string[]) => ids.slice(0, 3).join(", ");
  const claimed = others(index.claims.get(key));
  const linked = others(index.links.get(key));
  const said = namedIds(`${pr.title}\n${pr.head}`);
  const names = others(said).filter((id) => index.tasks.has(id));
  const sharing = pr.head ? others(index.branches.get(`${task.project ?? ""}\n${pr.head}`)) : [];
  const has = (way: Way) => ways.includes(way);
  const run = has("run");
  const doubts = [
    claimed.length ? `it is the PR/MR of ${listed(claimed)}` : "",
    names.length && !run ? `it names ${listed(names)}` : "",
    has("link") && linked.length ? `${listed(linked)} links it too` : "",
    has("branch") && sharing.length ? `its branch is shared with ${listed(sharing)}` : "",
  ].filter(Boolean);
  const names_ok = run || !names.length;
  const own =
    !claimed.length &&
    names_ok &&
    (run || has("closes_issue") || has("id_in_branch") || (has("link") && !linked.length) || (has("branch") && !sharing.length));
  // Anything else that points here (a mention of this card, even in a description) keeps it this card's
  // to verify too. The branch listing carries no mention, so the title and branch are read here as well.
  const onlyBranch = has("branch") && ways.every((way) => way === "branch") && !said.includes(task.id);
  const theirs = onlyBranch && sharing.length > 0 && claimed.length + names.length > 0;
  return { own, doubts, theirs };
}
