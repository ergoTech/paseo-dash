import { z } from "zod";

/**
 * The chats behind a task as the reads show them (06-god-mode.md, Stopped runs and their chats):
 * what became of the chat of a run whose agent is stopped, its sub-agents that are not archived, and
 * a sub-agent of another task's run that names this task. Only this machine's agents are known.
 */

/**
 * A stopped run's chat. `closed`: not archived, so a message continues it with its context;
 * `archived`; `gone`: Paseo has no such agent. Absent from a read while it is not known.
 */
export const CHAT_STATES = ["closed", "archived", "gone"] as const;
export type ChatState = (typeof CHAT_STATES)[number];

/**
 * What a read says of a run's agent that is stopped: «gone» only when Paseo has none. `undefined`: the
 * chat is not read (or this Mac has no record of the agent).
 */
export const chatSaid = (state: ChatState | undefined): string =>
  state === "closed" ? "its chat is closed" : state === "archived" ? "its chat is archived" : state === "gone" ? "its agent is gone" : "its agent is stopped";

/**
 * A sub-agent that is not archived, the one most in need of the user first. `closed` is like the run's
 * closed chat: nothing runs, and a message continues it. The others are open.
 */
export const SUB_AGENT_STATES = ["needs_input", "working", "idle", "failed", "closed"] as const;
export type SubAgentState = (typeof SUB_AGENT_STATES)[number];

export const subAgent = z.object({ id: z.string(), state: z.enum(SUB_AGENT_STATES), directory: z.string() });
export type SubAgent = z.output<typeof subAgent>;

/** The chat of a run whose agent is stopped; `id` is the run's agent. */
export const runChat = z.object({ id: z.string(), state: z.enum(CHAT_STATES), sub_agents: z.array(subAgent) });
export type RunChat = z.output<typeof runChat>;

/** The sub-agents of a stopped run that are open: work may go on there. */
export const openSubAgents = (chat: RunChat | undefined): SubAgent[] => (chat?.sub_agents ?? []).filter((sub) => sub.state !== "closed");

/**
 * Work in another run's chat: a sub-agent of another task's run whose title or labels name this task.
 * `via_task` is that run's task. Closed and archived chats are listed too: their work may be done or
 * half done.
 */
export const otherChat = z.object({ chat_id: z.string(), state: z.enum([...SUB_AGENT_STATES, "archived"]), directory: z.string(), via_task: z.string() });
export type OtherChat = z.output<typeof otherChat>;

/** How many sub-agents of one run, and chats naming one task, a read lists. */
export const CHATS_LISTED = 5;
