import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * What is going on across the plan: the main read, for the dashboard screen and for God Mode's
 * `overview` operation (docs/design/task-manager-v1/06-god-mode.md). `counts` has the totals; the
 * lists are short excerpts of them.
 */
export const overviewInput = z.object({
  space: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * What waits for the user, most urgent kind first: an agent's permission request (`permission`), its
 * questions to the user (`question`: Claude's AskUserQuestion, Codex's request_user_input), a
 * failed agent (`failed`), a space's plan changes that cannot be pushed (`sync`: `task` is empty and
 * `title` is the space's name), an agent that finished its turn while the task is in progress
 * (`answer`, often a question), an agent gone while it is (`stopped`, also a run this Mac holds but
 * has no record of), a tracked checkout on the trunk with no agent at work (`checkout`: its agent's
 * end is the normal one, not a failure, yet only a person moves the task on), and work to decide on:
 * a PR/MR `closed` without a merge, `merged` without the task done (`qa` instead when its agent is gone
 * and only a recorded QA card's run is left), `accept` for a task in review with no PR/MR. A task in review whose PR/MR is open waits for its merge on the forge and is listed under
 * `review` instead. In a project this machine reconciles (server/reconcile) the open PR/MRs are also one
 * `merge` list, in the order to merge them, each with its own blockers, and every other card the rule
 * left open is a `reconcile` group, cards that wait for the same thing together, each with the links to
 * what the decision rests on.
 */
export const NEEDS_KINDS = ["permission", "question", "failed", "sync", "answer", "stopped", "checkout", "closed", "merged", "accept", "qa", "merge", "reconcile"] as const;
export type NeedsKind = (typeof NEEDS_KINDS)[number];

/**
 * What a live run waits on (server/needs.ts waitState; 06-god-mode.md, Waiting states). Only
 * needs_user_question, approval, answer, blocked, failed, stopped, record_lost (this Mac lost the
 * record of its agent: not an ended run) and checkout wait for the user, and needs_you says what to
 * do; subagent_working, waiting_for_ci and waiting_for_review do not, nor do the rest.
 */
export const WAIT_STATES = [
  "launching",
  "working",
  "subagent_working",
  "waiting_for_ci",
  "waiting_for_review",
  "needs_user_question",
  "approval",
  "answer",
  "blocked",
  "failed",
  "stopped",
  "record_lost",
  "checkout",
  "elsewhere",
] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** A live run's agent as the reads say it (overview.running, autopilot.read's runs). */
export const RUN_ACTIVITIES = ["launching", "working", "waiting", "failed", "stopped"] as const;

/** One card of a `merge` list or a `reconcile` group, with where its decision comes from. */
export const needCard = z.object({
  task: z.string(),
  title: z.string(),
  /** What is left on this card: its diagnosis, or for a PR/MR in the merge list its blockers in a line. */
  note: z.string(),
  /** Where the decision rests: "#41 merged", "space.yaml defaults.human_labels", "phone APK abc1234". */
  source: z.string(),
  /** The evidence: the card's PR/MRs, the build. Kept whole, however many cards share a group. */
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  /** A merge list's place (1 merges first), whether it can merge now, and each blocker apart. */
  order: z.number().int().optional(),
  ready: z.boolean().optional(),
  blockers: z.array(z.string()).optional(),
  /** Other cards that name the same PR/MR of a merge list. */
  also: z.array(z.string()).optional(),
});

export const overviewOutput = z.object({
  needs_you: z.array(
    z.object({
      task: z.string(),
      title: z.string(),
      why: z.string(),
      chat_id: z.string(),
      kind: z.enum(NEEDS_KINDS),
      /** What the user can do about it now, one line (server/needs.ts). */
      next: z.string(),
      space: z.string(),
      /** Since when it waits, ISO time, where known; else "". */
      since: z.string(),
      /** The cards behind a `merge` list or a `reconcile` group, or the one a live run's need rests on. */
      cards: z.array(needCard).optional(),
    }),
  ),
  running: z.array(
    z.object({
      task: z.string(),
      title: z.string(),
      /**
       * `waiting` and `failed` are needs-you items, and so is `stopped`: no agent of this Mac works on
       * it (gone, or none known here). Another machine's run reads `working`: only it knows.
       */
      activity: z.enum(RUN_ACTIVITIES),
      /** What it waits on: an idle agent with a sub-agent at work or checks running does not wait for the user. */
      state: z.enum(WAIT_STATES),
      host: z.string(),
      chat_id: z.string(),
      /** When the run started, ISO time. */
      since: z.string(),
    }),
  ),
  /** Longest in review first. */
  review: z.array(z.object({ task: z.string(), title: z.string(), pr: z.string(), since: z.string() })),
  counts: z.object({
    needs_you: z.number().int(),
    running: z.number().int(),
    review: z.number().int(),
    inbox: z.number().int(),
    /** Unread task events (shared/events.ts) of this machine's runs. */
    events: z.number().int(),
  }),
  /** The newest task event id on this machine: a client that saw a lower one has new events. */
  events_latest: z.number().int(),
  milestones: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      due: z.string(),
      done: z.number().int(),
      total: z.number().int(),
      blocked: z.number().int(),
    }),
  ),
  spaces: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      synced: z.string(),
      conflicts: z.number().int(),
      problems: z.number().int(),
      /** How many `needs_you` items are this space's, whatever the excerpt shows. */
      needs_you: z.number().int(),
    }),
  ),
  /** Why the read could not answer (an unknown space name); empty when it did. */
  error: z.string(),
});

export type Overview = z.output<typeof overviewOutput>;

export const overviewRpc = defineRpc({
  name: "dashboard.overview",
  input: overviewInput,
  output: overviewOutput,
});

/**
 * Called by the client when its sidebar item mounts. The server receives `paseo` only with a hook
 * event or an RPC; from phase 1 on, this handler is where it keeps that client so reconciliation can
 * start as soon as any client connects. In phase 0 it only answers the version.
 */
export const helloRpc = defineRpc({
  name: "dashboard.hello",
  input: z.object({}),
  output: z.object({ version: z.string() }),
});
