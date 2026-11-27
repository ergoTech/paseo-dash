import { RESPONSES, type ResponseName, type ResponseSizes } from "./response-sizes.ts";

/**
 * The size budget of ChatGPT's reads and the agents' plan tools on the large plan: measured sizes in bytes, 5% of room on top.
 * Raise a number only in a PR that says so, with the table of scripts/response-sizes.ts; a PR that
 * shrinks a reply lowers its number, or the room it freed can fill up again unnoticed.
 */
export const MEASURED: ResponseSizes = {
  "meta.describe": 23108,
  overview: 5837,
  tasks: 4906,
  tasks_query: 6895,
  task: 988,
  plan_tools: 881,
  plan_find: 782,
};

/**
 * Ceilings the budget itself may not pass: an agent's plan tools are paid for in every session that
 * gets them, so their list stays within 1 KB and a full page of plan_find within 1.5 KB.
 */
export const CEILING: Partial<Record<ResponseName, number>> = { plan_tools: 1024, plan_find: 1536 };

export const ROOM = 1.05;

/**
 * meta.describe stays within 23 KiB whatever the room says: God Mode reads it for every call and
 * shows ChatGPT each operation's arguments with every read. 16 KiB from JOBBY-NY4D4; raised by the
 * user for resume_task and its read-back (JOBBY-TGHP0), then for the reads and the batch action of
 * JOBBY-YV2QS (task_text, delivery, reconcile, start_candidates, tasks_profiles, update_tasks) and
 * update_task's requires, readiness_note and delivery. Raised from 21.5 KiB for the ready_review
 * read (JOBBY-8DW17), in the pull request that adds it. Raised from 22 KiB for the app facts
 * update_task records (variants, environment, builds, play) and the two lines overview and reconcile
 * say about the new Needs you items (JOBBY-G2SEY), in the pull request that adds them.
 */
export const DESCRIBE_CEILING = 23 * 1024;

export const budgetOf = (name: ResponseName): number => {
  const budget = Math.ceil(MEASURED[name] * ROOM);
  return name === "meta.describe" ? Math.min(budget, DESCRIBE_CEILING) : budget;
};

/** One line per response over its budget. */
export function overBudget(sizes: ResponseSizes): string[] {
  return RESPONSES.filter((name) => sizes[name] > budgetOf(name)).map(
    (name) => `${name}: ${sizes[name]} bytes, budget ${budgetOf(name)}`,
  );
}
