import type { RpcOutput } from "@getpaseo/plugin";
import type { spacesListRpc } from "../../shared/spaces.ts";
import type { Dashboard } from "../dashboard.ts";
import { planProblems } from "../plan/load.ts";

export function listSpaces(dashboard: Dashboard): RpcOutput<typeof spacesListRpc> {
  return {
    owner: dashboard.owner,
    reason: dashboard.ownerReason,
    warnings: dashboard.warnings,
    spaces: [...dashboard.spaces.values()].map(({ record, sync }) => ({
      key: record.key,
      name: record.name,
      remote: record.remote,
      branch: record.branch,
      last_sync: sync.state.lastFetchOk ?? "",
      pending: sync.state.pending,
      error: sync.state.error ?? "",
      conflicts: sync.state.conflicts.map(({ id, reason, at }) => ({ id, reason, at })),
      problems: planProblems(sync.plan),
      late_claims: sync.state.lateClaims.length,
      warnings: sync.state.warnings,
      tasks: [...sync.plan.entities.values()].filter((l) => l.entity.type === "task").length,
      mapping: Object.entries(record.mapping).map(([project, local]) => ({ project, local: local ?? "" })),
    })),
  };
}
