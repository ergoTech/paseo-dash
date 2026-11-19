import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * What happened in the plan over a period, read from the plan repository's commits
 * (05-architecture.md, Recap): the Live tab's Recap block and God Mode's `recap`. Facts only; the
 * plugin never summarizes them with a model.
 */

/** How far back a recap reaches, in days: older history is not read. */
export const RECAP_MAX_DAYS = 31;
/** Without `since`, the recap covers this many days. */
export const RECAP_DEFAULT_DAYS = 7;
export const RECAP_DEFAULT_LIMIT = 50;
export const RECAP_MAX_LIMIT = 100;

/**
 * - `draft`: a new task in the inbox; `created`: a new task with any other status.
 * - `started`: a run claimed the task (`by` is who started it, `detail` the machine and branch).
 * - `review`, `done`: the task's status became that.
 * - `merged`: the task became done in the change that ended its run, with the run's PR/MR on record;
 *   `pr` is that PR/MR. The plan does not record the PR/MR's own state: usually it is the merge, but
 *   a person marking the task done while the PR/MR is still open reads the same.
 * - `released`: a run was ended with the task set back to todo or canceled.
 * - `blocked`: the run's progress note became a `blocked: …` one.
 * - `status`: any other change of status (accepting a draft, canceling, sending back, a hand edit);
 *   `detail` says from what to what.
 */
export const RECAP_KINDS = ["done", "merged", "review", "started", "blocked", "released", "created", "draft", "status"] as const;
export type RecapKind = (typeof RECAP_KINDS)[number];

export const recapInput = z.object({
  since: z
    .string()
    .trim()
    .optional()
    .describe(
      `ISO date, at most ${RECAP_MAX_DAYS} days ago; default ${RECAP_DEFAULT_DAYS}`,
    ),
  space: z.string().trim().optional(),
  kinds: z.array(z.enum(RECAP_KINDS)).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RECAP_MAX_LIMIT)
    .optional(),
});

export const recapEvent = z.object({
  kind: z.enum(RECAP_KINDS),
  task_id: z.string(),
  /** The task's title as of that change. */
  title: z.string(),
  space: z.string(),
  project: z.string(),
  /** When the change was committed to the plan (ISO 8601). */
  at: z.string(),
  /** Who: the person who started the run for `started`; else the commit's author (a person's name from the space when their email is known). */
  by: z.string(),
  /** The change in words: `todo → canceled`, the blocker, the machine and branch of a start. */
  detail: z.string(),
  /** The run's PR/MR at that change, or "". */
  pr: z.string(),
  /** The task's file in the plan repository on its forge; empty when the plan's remote has no web page or the task is gone. */
  link: z.string(),
  /** Made by hand (a commit without the dashboard's operation trailer), not through the dashboard. */
  by_hand: z.boolean(),
});
export type RecapEvent = z.output<typeof recapEvent>;

export const recapOutput = z.object({
  /** The start of the period read (ISO 8601). */
  since: z.string(),
  /** The period's events of the asked kinds, by kind, shown or not; kinds with none are left out. */
  counts: z.record(z.string(), z.number().int()),
  total: z.number().int(),
  /** More events match than were shown. */
  more: z.boolean(),
  /** Why the period is not covered in full (too many commits, a space that could not be read); "" when it is. */
  partial: z.string(),
  events: z.array(recapEvent),
  /** Why there is no answer (a bad since, an unknown space); "" when there is one. */
  error: z.string(),
});
export type Recap = z.output<typeof recapOutput>;

export const recapRpc = defineRpc({
  name: "plan.recap",
  input: recapInput,
  output: recapOutput,
});
