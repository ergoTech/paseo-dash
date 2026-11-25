import type { PaseoApi } from "./paseo.ts";
import type { RunRecord, WaitingKind } from "./runner/runs.ts";
import { activityOf } from "./tracker/tracker.ts";

/**
 * What a run's agent waits on while it sits idle (06-god-mode.md, Waiting states; JOBBY-YV2QS part 4).
 * An agent that ended its turn is not by that alone waiting for the user: ERG-4WT1N's agent was idle
 * while a sub-agent it started ran its tests and review, and was listed as "needs you: answer". These
 * are the facts that tell it apart, read from Paseo and the forge, never from the agent's last words:
 *
 * - Paseo's child agents of the run's agent (the `paseo.parent-agent-id` label Paseo puts on an
 *   agent another agent created): one at work means the run works; one asking a question or a
 *   permission is the user's, whoever asks;
 * - the checks of the run's own open PR/MR, while they run (pending or waiting on the forge).
 *
 * Kept in memory per run, read again after each turn and on the tracker's reconcile pass; nothing is
 * written to the plan. A sub-agent call on the agent's own timeline is counted by the follower.
 */

/** Paseo's label on an agent created by another agent: the parent's id. */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

export interface WaitFacts {
  /** When this Mac read them, ms since the epoch. */
  at: number;
  /** Child agents at work (running or starting). */
  working: number;
  /** A child agent's question or permission request, the first one found. */
  asking?: { kind: WaitingKind; text: string; agentId: string };
  /** The state of the checks of the run's own open PR/MR, when read: pending, waiting, passing, failing, none. */
  checks?: string;
}

export interface WaitProbeOptions {
  paseo: () => PaseoApi | undefined;
  /** The checks of the run's own open PR/MR (server/tracker/details.ts); undefined when it has none or the forge did not answer. */
  checks?: (run: RunRecord) => Promise<string | undefined>;
  now?: () => number;
  log?: (message: string) => void;
}

/** A run's facts are read again no sooner than this after the last read, unless a turn just ended. */
const FRESH_MS = 60_000;
/** Child agents listed per run. */
const CHILDREN = 20;

export class WaitProbe {
  readonly facts = new Map<string, WaitFacts>();
  private readonly options: WaitProbeOptions;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: WaitProbeOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Reads a run's facts in the background; `force` after a turn ended, else not more often than FRESH_MS. */
  probe(run: RunRecord, force = false): Promise<void> {
    const running = this.inFlight.get(run.run_id);
    if (running) return running;
    const last = this.facts.get(run.run_id)?.at ?? 0;
    if (!force && this.now() - last < FRESH_MS) return Promise.resolve();
    const read = this.read(run)
      .catch((error: unknown) => this.options.log?.(`waits of ${run.run_id}: ${(error as Error).message}`))
      .finally(() => this.inFlight.delete(run.run_id));
    this.inFlight.set(run.run_id, read);
    return read;
  }

  forget(runId: string): void {
    this.facts.delete(runId);
  }

  private async read(run: RunRecord): Promise<void> {
    const paseo = this.options.paseo();
    if (!paseo || !run.agentId) return;
    const listed = (await paseo.agents.list({ filter: { labels: { [PARENT_AGENT_LABEL]: run.agentId }, includeBackground: true }, page: { limit: CHILDREN } } as never)) as {
      entries?: { agent?: Record<string, unknown> & { id?: string; archivedAt?: string | null } }[];
    };
    let working = 0;
    let asking: WaitFacts["asking"];
    for (const entry of listed.entries ?? []) {
      const agent = entry.agent;
      if (!agent?.id || agent.archivedAt) continue;
      const state = activityOf(agent as Parameters<typeof activityOf>[0]);
      if (state.activity === "working" || state.activity === "launching") working += 1;
      else if (state.activity === "needs_input" && !asking) asking = { kind: state.waitingKind ?? "permission", text: state.waitingFor ?? "a sub-agent waits for an answer", agentId: agent.id };
    }
    const checks = await this.options.checks?.(run).catch(() => undefined);
    this.facts.set(run.run_id, { at: this.now(), working, ...(asking ? { asking } : {}), ...(checks ? { checks } : {}) });
  }
}
