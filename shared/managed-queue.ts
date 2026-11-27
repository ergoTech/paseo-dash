import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The managed queue (pilot, server/managed/): the owner of this machine sets the limits of one
 * project's queue once, and the autopilot then starts its ready cards within them. Settings and Live
 * only: never described to God Mode, so nothing read from a card and nothing ChatGPT says can turn a
 * queue on, resume it or raise its limit.
 */

/** Starts a queue may be given per window at most. */
export const MAX_QUEUE_STARTS = 20;
export const DEFAULT_QUEUE_STARTS = 3;
/** The window the starts are counted in. */
export const QUEUE_WINDOW_HOURS = 24;
/** Labels a queue can be narrowed to. */
export const MAX_QUEUE_LABELS = 10;
/** Cards one preview lists. */
export const QUEUE_CARDS = 100;

export const queuePolicyShape = z.object({
  space: z.string(),
  project: z.string(),
  enabled: z.boolean(),
  /** Why the queue is paused, by the owner or after a start it made went wrong; "" while it is not. */
  paused: z.string(),
  /** Starts the queue may make in any window of QUEUE_WINDOW_HOURS. */
  max_starts: z.number().int().min(1).max(MAX_QUEUE_STARTS),
  /** Only cards carrying one of these labels are the queue's; none: every card of the project. */
  labels: z.array(z.string()),
  updated_at: z.string(),
});
export type QueuePolicy = z.output<typeof queuePolicyShape>;

/**
 * What the queue does with a card:
 * - next: the first card it would start, once nothing holds the queue;
 * - queued: it starts after the ones before it, as places and the limit allow;
 * - read_first: its merged PR/MRs are not fully read here; the queue asks the forge before any start;
 * - after_dependency: it enters the queue by itself once what it waits for is done;
 * - duplicate: the same work as another open card, proved by the cards' own facts; not started;
 * - needs_owner: it waits for the owner (`needs` says for what).
 */
export const QUEUE_ACTIONS = ["next", "queued", "read_first", "after_dependency", "duplicate", "needs_owner"] as const;
export type QueueAction = (typeof QUEUE_ACTIONS)[number];

export const QUEUE_NEEDS = [
  "",
  /** An Inbox draft nobody accepted. */
  "draft",
  /** In progress with no run: a person decides what became of it. */
  "unheld",
  /** It ran before: the queue starts a card once. */
  "ran_before",
  /** A label marks it as a person's work, or reads like one. */
  "person_work",
  /** An owner's requirement. */
  "decision",
  /** A missing access, device, environment or QA, or a failed QA. */
  "access_qa",
  /** An open question in its brief. */
  "question",
  /** A dependency that is not found, or a loop of them. */
  "dependency",
  /** Its work is merged already. */
  "merged",
  /** Its own facts show earlier work: ticked lines, a PR/MR, a handoff. */
  "covered",
  /** It reads like another card: a signal to compare, not a duplicate. */
  "similar",
  /** Data about it could not be read or compared. */
  "incomplete",
  /** Its instructions were never seen by the owner. */
  "unseen",
  /** Its instructions changed since the owner saw them. */
  "changed",
  /** Its project is not mapped on this Mac. */
  "not_here",
  /** A start of it would be refused. */
  "refused",
] as const;
export type QueueNeed = (typeof QUEUE_NEEDS)[number];

const answer = z.object({ ok: z.boolean(), error: z.string() });
const projectRef = { space: z.string().trim().min(1).max(100), project: z.string().trim().min(1).max(100) };

export const queueReadRpc = defineRpc({
  name: "queue.read",
  input: z.object({}),
  output: z.object({
    /** Counts the owner's changes: a change that gives something is saved only from the one it was made from. */
    revision: z.number().int(),
    /** Why no queue counts right now; "" normally. */
    paused: z.string(),
    policies: z.array(queuePolicyShape.extend({ starts_used: z.number().int() })),
    /** The projects a queue can be set for. */
    projects: z.array(z.object({ space: z.string(), name: z.string(), project: z.string() })),
    error: z.string(),
  }),
});

/** Sets one project's queue; a field left out stays as it is. */
export const queueSetRpc = defineRpc({
  name: "queue.set",
  input: z
    .object({
      ...projectRef,
      enabled: z.boolean().optional(),
      paused: z.boolean().optional(),
      max_starts: z.number().int().min(1).max(MAX_QUEUE_STARTS).optional(),
      labels: z.array(z.string().trim().min(1).max(100)).max(MAX_QUEUE_LABELS).optional(),
      revision: z.number().int().describe("The revision queue.read showed"),
    })
    .strict(),
  output: answer,
});

const queueCard = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  action: z.enum(QUEUE_ACTIONS),
  needs: z.enum(QUEUE_NEEDS),
  /** Why the queue proposes this. */
  reason: z.string(),
  /** What happens next, or what the owner does. */
  step: z.string(),
  waits_for: z.array(z.string()),
  /** What a start would use; "" for a card the queue would not start. */
  start_with: z.string(),
});
export type QueueCard = z.output<typeof queueCard>;

/** What the queue of one project would do now, whether it is on or not. Read only: it starts nothing. */
export const queuePreviewRpc = defineRpc({
  name: "queue.preview",
  input: z.object(projectRef),
  output: z.object({
    state: z.enum(["off", "paused", "on"]),
    /** Why the queue starts nothing now; "" when it may start its next card. */
    hold: z.string(),
    limits: z.object({
      /** This Mac's places (Settings → Autopilot), shared with every other start the autopilot makes. */
      max_running: z.number().int(),
      running: z.number().int(),
      max_starts: z.number().int(),
      starts_used: z.number().int(),
      window_hours: z.number().int(),
    }),
    /** Who may prepare the project's cards (Delegated planning). */
    preparer: z.string(),
    /** The card the queue starts next; "" when none is ready for it. */
    next: z.string(),
    /** In the order the queue takes them, then the ones that wait. */
    cards: z.array(queueCard),
    total: z.number().int(),
    /** Cards by action. */
    counts: z.record(z.string(), z.number().int()),
    /** The queue's starts in the window, newest first. */
    started: z.array(z.object({ task: z.string(), title: z.string(), at: z.string() })),
    error: z.string(),
  }),
});
