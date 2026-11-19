import type { Dashboard } from "../dashboard.ts";
import type { LoadedEntity } from "../plan/load.ts";
import type { PlanRun } from "../plan/run-history.ts";
import type { RunRecord } from "../runner/runs.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { cut } from "./view.ts";

/** A task's run history as the task screen and God Mode's task read show it (server/plan/run-history.ts). */

export function historyOf(dashboard: Dashboard, sync: SpaceSync, loaded: LoadedEntity): Promise<PlanRun[]> {
  return dashboard.runHistory.read(sync.gitRunner, sync.root, loaded.entity.id, loaded.path);
}

/** How long a read waits for the history; Paseo stops waiting for an RPC after 30 s. */
export const HISTORY_WAIT_MS = 10_000;

/**
 * The history, or why there is none to show: a read that takes longer goes on and fills the cache,
 * so asking again shortly answers from it.
 */
export async function historyWithin(dashboard: Dashboard, sync: SpaceSync, loaded: LoadedEntity, waitMs = HISTORY_WAIT_MS): Promise<{ runs: PlanRun[]; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ runs: PlanRun[]; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ runs: [], error: "The run history is still being read from git; ask again shortly." }), waitMs);
  });
  const read = historyOf(dashboard, sync, loaded).then(
    (runs) => ({ runs, error: "" }),
    (error: unknown) => ({ runs: [], error: `The run history could not be read: ${String((error as Error)?.message ?? error)}` }),
  );
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** This machine's record of a run of this task; a run_id copied into another task's file finds none. */
export function localRecord(dashboard: Dashboard, run: PlanRun, taskId: string): RunRecord | undefined {
  const record = dashboard.runs?.runs.get(run.run_id);
  return record?.task === taskId ? record : undefined;
}

/** What became of a run, as a person reads it. */
export function resultText(run: PlanRun): string {
  switch (run.result) {
    case "live":
      return "holds the task now";
    case "todo":
      return "released back to todo";
    case "replaced":
      return "no end recorded: a later claim or a hand edit replaced it";
    default:
      return `ended: ${run.result}`;
  }
}

/** What became of a run, with why a start that released its own claim failed (this machine knows it). */
export function runResult(run: PlanRun, record: RunRecord | undefined): string {
  const result = resultText(run);
  return run.result === "todo" && record?.released && record.error ? `${result} after a failed start: ${cut(record.error, 300)}` : result;
}

/** `3 of 5 · Recovery codes next`, or the note alone. */
export function runProgress(run: PlanRun): string {
  const head = run.progress_total ? `${run.progress_done ?? 0} of ${run.progress_total}` : "";
  return [head, run.progress_note].filter(Boolean).join(" · ");
}

/** Where a run's agent is when this machine has no record of it. */
export function elsewhereText(run: PlanRun, host: string): string {
  if (run.host && run.host === host) return "Started on this Mac, but this Mac no longer knows its agent.";
  return `Its agent ran on ${run.host || "another machine"}, not on this Mac.`;
}
