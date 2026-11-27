import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The owner's rule for automatic reconciliation, per project of a space and per machine
 * (server/reconcile/rules.ts): off (the default), report (diagnose and list what is left, close
 * nothing) or close (also close a card whose work is merged and every check holds). Settings screen
 * only: never described to God Mode, so ChatGPT cannot switch it on.
 */
export const RECONCILE_MODES = ["off", "report", "close"] as const;
export type ReconcileMode = (typeof RECONCILE_MODES)[number];

const rule = z.object({
  space: z.string(),
  project: z.string(),
  mode: z.enum(RECONCILE_MODES),
  /** A merged PR/MR with no check at all counts as verified: for a project without CI. */
  no_checks_ok: z.boolean(),
});

export const reconcileRulesRpc = defineRpc({
  name: "reconcile.rules",
  input: z.object({}),
  output: z.object({
    projects: z.array(rule.extend({ space_name: z.string() })),
    error: z.string(),
  }),
});

export const reconcileRulesSetRpc = defineRpc({
  name: "reconcile.rules.set",
  input: rule,
  output: rule.extend({ ok: z.boolean(), error: z.string() }),
});
