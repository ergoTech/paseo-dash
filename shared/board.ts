import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { spaceOfId } from "./across.ts";
import { taskRow } from "./api.ts";
import { liveNow, liveOverlap } from "./live.ts";

/**
 * The board (04-ux.md, The board): a space's tasks in columns by the section every task list cuts
 * them into (server/api/view.ts, taskSection), so a column holds what the Tasks tab heads with the
 * same name. Not described to God Mode: ChatGPT reads tasks and moves them with update_task.
 */

/** The columns, left to right. Canceled work has no column: it will not be done. Archived work is off the board. */
export const BOARD_COLUMNS = ["draft", "ready", "blocked", "running", "review", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** How many of the latest finished tasks the done column lists; the rest are only counted. */
export const BOARD_DONE_LIMIT = 50;
/** How many tasks any other column lists; the rest are only counted. */
export const BOARD_COLUMN_LIMIT = 200;

/**
 * A PR/MR that holds a task's work, merged after the task was created by a session the dashboard did
 * not start (03-model.md, Work merged outside the dashboard): the card offers "Mark done".
 */
export const mergedPr = z.object({ label: z.string(), url: z.string(), merged_at: z.string() });

/** A board card: a task row, with the work merged outside the dashboard when there is some. */
export const boardRow = taskRow.extend({
  merged: z.array(mergedPr).optional(),
  /** Archived: off the board until put back (03-model.md, Archive); shown only under the Archived filter. */
  archived: z.literal(true).optional(),
  /** In progress with no live run: a person closes it, puts it back to todo, or starts it again. */
  unheld: z.literal(true).optional(),
  /** The latest call of the task's agent on this machine, while it runs (shared/live.ts). */
  live: liveNow.optional(),
  /** Other tasks whose runs on this machine change some of the same files (shared/live.ts). */
  overlaps: z.array(liveOverlap).optional(),
});

export const uiBoardRpc = defineRpc({
  name: "ui.board",
  input: z.object({
    space: z.string().trim().min(1).optional().describe("Space key; empty: all spaces"),
    mine: z.boolean().optional(),
    label: z.string().trim().min(1).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    /** Only the archived tasks (done and canceled), in the done column; without it they are left out. */
    archived: z.boolean().optional(),
  }),
  output: z.object({
    columns: z.array(
      z.object({
        column: z.enum(BOARD_COLUMNS),
        /** Every task of the column under the filters; `tasks` may list fewer (the limits above). */
        total: z.number().int(),
        tasks: z.array(boardRow),
      }),
    ),
    /** The query as typed on the other keyboard layout, when that is what found these. */
    searched_for: z.string().optional(),
    error: z.string(),
  }),
});

/** Columns whose order a person sets (D21): the tasks waiting to start and the drafts. */
export const RANKED_COLUMNS: ReadonlySet<string> = new Set<BoardColumn>(["draft", "ready", "blocked"]);

/**
 * What dropping a card does. The board changes only what a person decides on its own: a draft is
 * accepted (inbox → todo) or an accepted task goes back to the drafts (todo → inbox), and the order
 * inside a column through tasks.rank. Running, review and done follow the task's run (03-model.md,
 * the transition table; I4), so their cards move only through the task's own actions.
 */
export type BoardMove =
  | { kind: "status"; to: "todo" | "inbox" }
  /** A draft without a project: accepting it needs one, so the accept form opens. */
  | { kind: "accept" }
  | { kind: "rank"; position: "before" | "after"; next_to: string }
  | { kind: "none"; why: string };

export interface BoardCard {
  id: string;
  section: string;
  /** Left out of a row when it has none. */
  project?: string;
}

export function boardMove(card: BoardCard, to: { column: string; card?: { id: string; section: string }; after?: boolean }): BoardMove {
  if (!RANKED_COLUMNS.has(card.section)) {
    return { kind: "none", why: card.section === "done" ? "A finished task reopens from its own page." : "A task with a run moves with its run; use the task's own actions." };
  }
  if (!RANKED_COLUMNS.has(to.column)) return { kind: "none", why: "Running, review and done follow the task's run; the board does not move a task there." };
  if (to.column === card.section) {
    if (!to.card || to.card.id === card.id || to.card.section !== card.section) return { kind: "none", why: "" };
    // A rank orders only its own space's tasks (D21).
    if (spaceOfId(to.card.id) !== spaceOfId(card.id)) return { kind: "none", why: "A task's place is among its own space's tasks; drop it next to one of them." };
    return { kind: "rank", position: to.after ? "after" : "before", next_to: to.card.id };
  }
  if (card.section === "draft") return card.project ? { kind: "status", to: "todo" } : { kind: "accept" };
  if (to.column === "draft") return { kind: "status", to: "inbox" };
  return { kind: "none", why: "Ready or blocked follows the task's dependencies, not the board." };
}
