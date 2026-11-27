import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { reconcileRulesRpc, reconcileRulesSetRpc } from "../../shared/reconcile.ts";
import type { Dashboard } from "../dashboard.ts";
import { allRules, ruleOf, writeRule } from "./rules.ts";

type Rules = RpcOutput<typeof reconcileRulesRpc>;
type Set = RpcOutput<typeof reconcileRulesSetRpc>;

/** Settings → Automatic closing: each project of each connected space with this machine's rule. */
export function readRules(dashboard: Dashboard): Rules {
  if (!dashboard.owner) return { projects: [], error: dashboard.ownerReason || "Paseo Dash has not started" };
  const rules = allRules(dashboard.dataDir);
  const projects: Rules["projects"] = [];
  for (const { record, sync } of dashboard.spaces.values()) {
    for (const project of Object.keys(sync.plan.space?.projects ?? {})) {
      const rule = rules.find((r) => r.space === record.key && r.project === project);
      projects.push({ space: record.key, space_name: record.name, project, mode: rule?.mode ?? "off", no_checks_ok: rule?.no_checks_ok ?? false });
    }
  }
  return { projects, error: "" };
}

export function writeRules(dashboard: Dashboard, input: RpcInput<typeof reconcileRulesSetRpc>): Set {
  const now = (error: string, ok = false): Set => {
    const rule = ruleOf(dashboard.dataDir, input.space, input.project);
    return { space: input.space, project: input.project, mode: rule?.mode ?? "off", no_checks_ok: rule?.no_checks_ok ?? false, ok, error };
  };
  if (!dashboard.owner) return now(dashboard.ownerReason || "Paseo Dash has not started");
  const space = dashboard.spaces.get(input.space);
  if (!space || !Object.hasOwn(space.sync.plan.space?.projects ?? {}, input.project)) return now(`no project ${input.project} in space ${input.space}`);
  try {
    writeRule(dashboard.dataDir, input);
  } catch (error) {
    return now(`not saved: ${String((error as Error)?.message ?? error)}`);
  }
  // A project just switched on is looked at now, not at the next sync.
  if (input.mode !== "off") void dashboard.reconciler.pass().catch(() => undefined);
  return now("", true);
}
