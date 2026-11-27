import type { Way } from "./ties.ts";

/**
 * What this Mac read about a card's work, kept in memory per card (server/reconcile/reconciler.ts):
 * its PR/MRs with how each is tied to the card, whether the card's scope moved since the merge, and,
 * for an app, which builds hold its changes. Every claim in it came from the forge, git or the plan's
 * history; what could not be read is in `unknown` or `limits`, never guessed.
 */

export type PrState = "open" | "draft" | "merged" | "closed";

export interface PrFact {
  url: string;
  label: string;
  state: PrState;
  title: string;
  base: string;
  head: string;
  headSha: string;
  mergeSha: string;
  mergedAt: string;
  createdAt: string;
  /** "none" also when every check was skipped or neutral: nothing ran that verifies the work. */
  checks: { state: "passing" | "failing" | "pending" | "waiting" | "none"; passed: number; failing: string[] } | null;
  review: string;
  merge: { state: "yes" | "no" | "unknown"; why: string };
  ways: Way[];
  /** Something names the card itself and nothing gives the PR/MR to another card (server/reconcile/ties.ts). */
  own: boolean;
  doubts: string[];
  /** The branch's tip when commits were pushed after the merge, "" when none were or it could not be told. */
  pushedAfter: string;
}

/** Ties by which a card names a PR/MR as part of its work, whether or not it is the card's alone. */
const NAMED: Way[] = ["run", "link", "branch", "id_in_branch", "closes_issue"];

/**
 * A PR/MR the card names as part of its work: every one of them must be merged and verified before the
 * card is complete, and a build covers the card only with all of them. An open one also counts when its
 * title names the card: a follow-up nobody linked is still work that is not in.
 */
export const named = (pr: Pick<PrFact, "own" | "ways" | "state">): boolean =>
  pr.own || pr.ways.some((way) => NAMED.includes(way)) || ((pr.state === "open" || pr.state === "draft") && pr.ways.includes("id_in_title"));

/** The card as it stood when its work merged, from the plan's history (server/reconcile/history.ts). */
export interface Scope {
  /** The scope then (history.ts scopeOf), compared with the card as it is now; undefined when not read. */
  then?: string;
  /** Why it was not read; "" when it was. */
  unknown: string;
  /** What someone did to the card's status since the merge, "" when nothing a person would decide. */
  acted: string;
}

/** A build's state for one variant of an app card. */
export interface ApkFact {
  variant: string;
  environment: string;
  state: "available" | "awaited" | "unknown";
  why: string;
  build?: { sha: string; url: string; version: string };
}

export interface CardFacts {
  /** What the facts were read for (the card's links, its branch, the builds recorded): a change makes them old. */
  key: string;
  /** When this Mac read them, ISO. */
  at: string;
  trunk: string;
  prs: PrFact[];
  /** What could not be read now (a forge that did not answer): read again soon. */
  unknown: string[];
  /** Part of the card's work that is not read as things stand, and what to do about it: waiting does not help. */
  limits: { why: string; advice: string }[];
  scope: Scope;
  apks: ApkFact[];
  /** What the builds were compared for (the project's recorded builds, the card's variants): another value, compare again. */
  apksKey: string;
}

export const merged = (facts: CardFacts) => facts.prs.filter((pr) => pr.state === "merged");
