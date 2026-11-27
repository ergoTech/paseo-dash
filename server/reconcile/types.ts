/**
 * What the automatic reconciliation says about a card (docs/design/task-manager-v1/03-model.md,
 * Automatic reconciliation): a verdict is either "close" (everything the owner's rule asks is
 * verified) or the holds that stand in the way, strongest first. Each hold says what is wrong, the
 * one next action, who acts and where the decision comes from.
 */

/** Strongest first: a verdict's diagnosis is its first hold. */
export const HOLD_ORDER = [
  "claim",
  "reopened",
  "draft",
  "review",
  "released",
  "forge",
  "no_pr",
  "tie",
  "open_pr",
  "closed_pr",
  "base",
  "pushed_after",
  "checks",
  "scope",
  "acceptance",
  "decision",
  "manual",
  "qa",
  "dependencies",
  "report",
] as const;
export type HoldCode = (typeof HOLD_ORDER)[number];

/** A place the decision rests on: a PR/MR, the card's file, space.yaml, the owner's rule. `url` is "" for a place with none. */
export interface Source {
  label: string;
  url: string;
}

export interface Hold {
  code: HoldCode;
  text: string;
  /** The one thing to do about it. */
  next: string;
  /** Who acts: the owner, an agent, or nobody yet (a check running, a build on its way). */
  by: "owner" | "agent" | "wait";
  source: Source;
  /** More places it rests on (a second variant's build), linked beside the source. */
  extra?: Source[];
  /** Cards that share it share the evidence behind it too: groups cards by it ("APK abc covers these"). */
  group?: string;
}

/**
 * How a person finishes a card by hand, as the plugin accepts it in the card's state: a card a live
 * run holds is released, never set done (update_task refuses that).
 */
export const finishWith = (liveRun: boolean): string => (liveRun ? "release it to done (release_task)" : "mark it done (update_task status done)");

export const byOrder = (a: Hold, b: Hold): number => HOLD_ORDER.indexOf(a.code) - HOLD_ORDER.indexOf(b.code);
