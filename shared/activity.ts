import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Work in Paseo that the plan does not hold (04-ux.md, "In Paseo, not on the plan"): workspaces of a
 * space's projects that no dashboard task runs in, live first, and archived ones as the line's past.
 * Without a space, every space's projects in turn; one Paseo project can be mapped from several
 * spaces, so there a workspace is listed once, under the first space's project that has it. A dashboard screen
 * action; God Mode is not offered it.
 */

/** Paseo's workspace status buckets; the first four mean an agent is at work or waits for you. */
export const WORKSPACE_STATUSES = ["needs_input", "failed", "attention", "running", "done"] as const;
export const BUSY_STATUSES: readonly string[] = ["needs_input", "failed", "attention", "running"];

const workspace = z.object({
  workspace_id: z.string(),
  title: z.string(),
  branch: z.string(),
  status: z.enum(WORKSPACE_STATUSES),
  /** When it entered that status, or was created; empty when Paseo does not say. */
  since: z.string(),
  pr_url: z.string(),
  pr_state: z.string(),
});

const past = z.object({
  workspace_id: z.string(),
  title: z.string(),
  branch: z.string(),
  archived_at: z.string(),
});

export const activityRpc = defineRpc({
  name: "activity.list",
  input: z.object({
    space: z.string().trim().optional().describe("Space key; empty: all spaces"),
    project: z.string().trim().optional().describe("Only this project key"),
  }),
  output: z.object({
    projects: z.array(
      z.object({
        /** The space whose project this is. */
        space: z.string(),
        project: z.string(),
        /** The project's trunk from space.yaml; empty when it names none (the checkout's default then applies). */
        trunk: z.string(),
        /** Open workspaces: waiting for you or failed first, then working, then idle; newest first within each. */
        active: z.array(workspace),
        /** Archived workspaces, newest first: the most recent ones only (server/activity.ts, PAST_LIMIT). */
        past: z.array(past),
      }),
    ),
    /** When Paseo was last asked; empty before the first answer. */
    read_at: z.string(),
    error: z.string(),
  }),
});

export type ActiveWorkspace = z.output<typeof workspace>;
export type PastWorkspace = z.output<typeof past>;

/**
 * "Track as task" (05-architecture.md, Tracking a Paseo workspace as a task): takes an open workspace
 * of a line into the plan as a task held by a run of this machine. A workspace already tracked here
 * answers its task with `existing`. A dashboard screen action; God Mode is not offered it.
 */
export const activityTrackRpc = defineRpc({
  name: "activity.track",
  input: z.object({
    space: z.string().trim().min(1).describe("Space key"),
    project: z.string().trim().min(1).describe("Project key of the line"),
    workspace_id: z.string().trim().min(1).describe("Paseo workspace id"),
    title: z.string().trim().max(200).optional().describe("Task title; the workspace's title when empty"),
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.string(),
    /** The workspace was tracked before: `id` is that task. */
    existing: z.boolean(),
    /** `branch`: its PR/MR is followed; `trunk`: a checkout on the trunk, whose "landed" is read. */
    kind: z.enum(["branch", "trunk", ""]),
    error: z.string(),
  }),
});
