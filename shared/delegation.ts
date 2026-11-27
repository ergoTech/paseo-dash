import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Delegated planning (pilot, server/delegation/): the owner of this machine appoints one agent as a
 * coordinator of one project of a space, with a set of actions. The agent then gets the coordinator
 * tools; every other agent keeps what it had. Settings and task screens only: never described to God
 * Mode, so ChatGPT cannot grant, change or revoke a permission.
 */

/**
 * - `drafts`: add Inbox drafts of its own and edit the brief and acceptance of those.
 * - `priority`: set the priority of a draft or a todo card of the project.
 * - `dependencies`: add dependencies between cards of the project; remove them from drafts only.
 */
export const DELEGATED_ACTIONS = ["drafts", "priority", "dependencies"] as const;
export type DelegatedAction = (typeof DELEGATED_ACTIONS)[number];

export const delegationGrantShape = z.object({
  id: z.string(),
  /** The Paseo agent the permission was given to. */
  agent: z.string(),
  /** The agent's title when the permission was last saved. */
  title: z.string(),
  space: z.string(),
  project: z.string(),
  actions: z.array(z.enum(DELEGATED_ACTIONS)),
  granted_at: z.string(),
  updated_at: z.string(),
  /** By action, the rules' revision that took it back: a change asked before that is never pushed. */
  revoked: z.partialRecord(z.enum(DELEGATED_ACTIONS), z.number()).optional(),
});
export type DelegationGrant = z.output<typeof delegationGrantShape>;

/** One change a coordinator made, or was refused: who, when, what and under which permission. */
export const delegationEntryShape = z.object({
  op_id: z.string(),
  at: z.string(),
  agent: z.string(),
  title: z.string(),
  /** The permission it was asked under, and since when that permission stood. */
  grant: z.string(),
  granted_at: z.string(),
  actions: z.array(z.enum(DELEGATED_ACTIONS)),
  space: z.string(),
  project: z.string(),
  task: z.string(),
  task_title: z.string(),
  changes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
  status: z.enum(["queued", "applied", "refused"]),
  reason: z.string(),
});
export type DelegationEntry = z.output<typeof delegationEntryShape>;

/** An entry as a screen shows it: `pending` while the change is not on the plan repository yet. */
const shownEntry = delegationEntryShape.extend({ pending: z.boolean() });
export type ShownDelegationEntry = z.output<typeof shownEntry>;

const answer = z.object({ ok: z.boolean(), error: z.string() });

export const delegationReadRpc = defineRpc({
  name: "delegation.read",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    /** Counts the owner's changes of the rules: a permission is saved only from the one it was made from. */
    revision: z.number(),
    /** Why no permission counts right now although the pilot is on; empty otherwise. */
    paused: z.string(),
    grants: z.array(delegationGrantShape),
    /** The projects a permission can name. */
    projects: z.array(z.object({ space: z.string(), name: z.string(), project: z.string() })),
    /** Newest first. */
    changes: z.array(shownEntry),
    error: z.string(),
  }),
});

export const delegationEnableRpc = defineRpc({
  name: "delegation.enable",
  input: z.object({ enabled: z.boolean() }).strict(),
  output: answer,
});

/** Open agents working in the project's repository, the ones a permission can be given to. */
export const delegationAgentsRpc = defineRpc({
  name: "delegation.agents",
  input: z.object({ space: z.string().trim().min(1), project: z.string().trim().min(1) }),
  output: z.object({
    /** `mode`: the agent's permission mode, which decides whether a call asks; empty when Paseo says none. */
    agents: z.array(z.object({ id: z.string(), title: z.string(), provider: z.string(), mode: z.string(), cwd: z.string() })),
    error: z.string(),
  }),
});

/** Gives an agent its permission, replacing the one it had: one agent coordinates one project. */
export const delegationGrantRpc = defineRpc({
  name: "delegation.grant",
  input: z
    .object({
      agent: z.string().trim().min(1).max(200),
      space: z.string().trim().min(1),
      project: z.string().trim().min(1),
      actions: z.array(z.enum(DELEGATED_ACTIONS)).min(1),
      revision: z.number().int().describe("The revision delegation.read showed"),
    })
    .strict(),
  output: answer,
});

/** Takes one action out of a permission, or the whole permission without `action`. */
export const delegationRevokeRpc = defineRpc({
  name: "delegation.revoke",
  input: z.object({ grant: z.string().trim().min(1), action: z.enum(DELEGATED_ACTIONS).optional() }).strict(),
  output: answer,
});

/** What coordinators changed, or asked to change, on one task. */
export const delegationLogRpc = defineRpc({
  name: "delegation.log",
  input: z.object({ task: z.string().trim().min(1) }),
  output: z.object({ changes: z.array(shownEntry), error: z.string() }),
});
