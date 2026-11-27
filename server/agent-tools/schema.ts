import { z } from "zod";
import { PRIORITIES } from "../../shared/model.ts";

/**
 * The input of `task_report`. The same schema checks a call and renders the tool's `inputSchema` that
 * the agent sees, so the agent is never offered a field or a length the handler refuses.
 */

/** Longest handoff an agent may leave, in characters. */
export const HANDOFF_MAX = 2000;

export const reportSchema = z
  .object({
    note: z.string().trim().max(300).optional().describe("One line on where you are"),
    done: z
      .array(z.union([z.string().trim().min(1).max(500), z.number().int().positive()]))
      .max(50)
      .optional()
      .describe("Acceptance lines finished, by text or number (1 is the first)"),
    state: z.enum(["working", "blocked", "done"]).optional(),
    blocker: z.string().trim().max(300).optional().describe("What blocks you, when state is blocked"),
    waiting_for: z
      .enum(["ci", "review", "subagent", "user"])
      .optional()
      .describe("When you end your turn to wait: for CI, a review, your sub-agents, or the user's answer"),
    pr_url: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, "an https URL")
      .optional()
      .describe("URL of the merge request (pull request) of this task's branch"),
    handoff: z
      .string()
      .trim()
      .min(1)
      .max(HANDOFF_MAX)
      .optional()
      .describe(
        "For the agent that continues this task after you: short lines Done, Left, Decisions, Open questions, How to verify. Replaces your previous handoff. No secrets.",
      ),
  })
  .strict();

/** A zod schema as the JSON Schema of an MCP tool's input. */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

/**
 * The inputs of the plan tools any agent of a mapped project gets (server/agent-tools/plan.ts). Their
 * descriptions are kept short: every agent pays for the tool list in its context, and the list stays
 * within fixtures/response-budget.ts.
 */

/** Most rows plan_find returns; also its default. */
export const FIND_LIMIT = 20;

export const findSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(FIND_LIMIT).optional(),
  })
  .strict();

export const taskSchema = z.object({ id: z.string().trim().min(1).max(40) }).strict();

export const draftSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * The inputs of the coordinator tools (server/delegation/tools.ts), which only an agent with a
 * delegated permission gets. No field names a space, a project, a status, a label or a requirement:
 * what a coordinator cannot change it cannot ask for.
 */

/** Most rows coordinate_find returns; also its default. */
export const COORDINATE_LIMIT = 50;
export const DELEGATED_BRIEF_MAX = 8000;

const cardId = z.string().trim().min(1).max(40);
const revision = z.string().trim().min(1).max(40).describe("The revision coordinate_task showed");

export const coordinateFindSchema = z
  .object({ query: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(COORDINATE_LIMIT).optional() })
  .strict();

export const coordinateTaskSchema = z.object({ id: cardId }).strict();

export const coordinateDraftSchema = z
  .object({
    id: cardId.optional().describe("A draft you created, to edit it; leave out to add a new draft"),
    revision: revision.optional(),
    title: z.string().trim().min(1).max(200).optional().describe("For a new draft only"),
    brief: z.string().trim().min(1).max(DELEGATED_BRIEF_MAX).optional().describe("Replaces the whole brief"),
    acceptance: z
      .array(z.string().trim().min(1).max(300).regex(/^[^\r\n\u2028\u2029]*$/, "one line"))
      .max(30)
      .optional()
      .describe("Replaces all acceptance lines"),
  })
  .strict();

export const coordinatePlanSchema = z
  .object({
    id: cardId,
    revision,
    priority: z.enum(PRIORITIES).optional(),
    depends_on: z.array(cardId).max(30).optional().describe("The whole new list of task IDs this card waits for"),
  })
  .strict();
