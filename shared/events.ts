import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Task events of this machine's runs (05-architecture.md, Task events): an agent finished its turn,
 * failed, waits for the user's permission, or asks the user questions. Each change of a run's
 * activity into one of these makes one event with an increasing id; reads never consume them, and an
 * event stays unread until someone marks it read (the Live tab, or God Mode's `mark_events_read`) or
 * its run is over (the task done, released or claimed again). Read by God Mode's `events`.
 */

export const EVENT_KINDS = ["finished", "failed", "needs_input", "question"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const taskEvent = z.object({
  /** Increasing on this machine; `after` and `through` take it. */
  id: z.number().int(),
  kind: z.enum(EVENT_KINDS),
  task_id: z.string(),
  /** The task's title now, or when the event was made if the plan no longer has the task. */
  title: z.string(),
  space: z.string(),
  project: z.string(),
  /** The task's agent: God Mode's chat id for read_chat, send_message, answer_approval and, for a question, read_approval and answer_questions. */
  chat_id: z.string(),
  workspace_id: z.string(),
  /** When the run's activity changed (ISO 8601). */
  at: z.string(),
  /** finished: the agent's last reply, cut short (empty until it is read); failed: the error; needs_input: the permission it asks for; question: its questions by name. */
  summary: z.string(),
  /** The task's file in the plan repository on its forge; empty when the plan's remote has no web page. */
  link: z.string(),
  /** The run's PR/MR, when one is known. */
  pr: z.string(),
  /** The task's status now. */
  status: z.string(),
  unread: z.boolean(),
});
export type TaskEvent = z.output<typeof taskEvent>;

export const eventsListInput = z.object({
  space: z.string().trim().optional(),
  after: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Empty: the unread ones"),
  history: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const eventsListRpc = defineRpc({
  name: "events.list",
  input: eventsListInput,
  output: z.object({
    events: z.array(taskEvent),
    /** Unread events in the asked spaces, shown or not. */
    unread: z.number().int(),
    /** The newest event id on this machine (0 before the first one). */
    latest: z.number().int(),
    /** More events match than were shown. */
    more: z.boolean(),
    /**
     * What ChatGPT does once it told the events: mark them read through the last one shown and, with
     * a question among them, how the user answers it. Left out when nothing was shown.
     */
    next: z.string().optional(),
    error: z.string(),
  }),
});

export const eventsSeenInput = z.object({
  through: z.number().int().min(0),
  space: z.string().trim().optional(),
});

export const eventsSeenRpc = defineRpc({
  name: "events.seen",
  input: eventsSeenInput,
  output: z.object({ ok: z.boolean(), marked: z.number().int(), unread: z.number().int(), error: z.string() }),
});
