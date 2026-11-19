import { createHash } from "node:crypto";
import type { RpcOutput } from "@getpaseo/plugin";
import type { changesRpc } from "../shared/changes.ts";
import type { Dashboard } from "./dashboard.ts";
import type { LoadedEntity, Plan } from "./plan/load.ts";
import type { RunRecord } from "./runner/runs.ts";

/**
 * The token of `dashboard.changes`: a hash of the state itself, read from memory with no git and no
 * file. Hashing what the screens read, rather than counting writes, means no write path has to
 * remember to report, and a pass that changes nothing (a fetch reloads the whole plan each time) does
 * not move it.
 *
 * Covered: what says how work is going, which is the plans and their sync state, the runs, the task
 * events, the PR/MR and issue views, and how many run histories finished reading. A new store of that
 * kind goes in here too.
 *
 * Not covered, and shown on the reserve read or after this client's own change: settings-like state
 * (autopilot, display choices, the mirror and release stores, Laconote); when the last fetch succeeded,
 * and when the last landed reading or issue read was taken, so an idle token stands still; and Paseo's
 * workspaces on the map, which only a read of the map refreshes, so hashing them would add one more
 * full read per change.
 */

const hash = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);

/** Entries are replaced, never edited (space-sync.ts, `snapshot`), so an entry's hash holds for its life. */
const entityHashes = new WeakMap<LoadedEntity, string>();

function entityHash(loaded: LoadedEntity): string {
  let known = entityHashes.get(loaded);
  if (!known) {
    known = hash(JSON.stringify(loaded));
    entityHashes.set(loaded, known);
  }
  return known;
}

/** A plan's head: what it holds, whichever way that got there. */
function planHead(plan: Plan): string {
  const entities = [...plan.entities].map(([id, loaded]) => `${id}=${entityHash(loaded)}`).sort();
  return JSON.stringify([plan.space, entities, [...plan.duplicates].sort(), plan.problems]);
}

/** What a screen shows of a run: not its secret, its stored requests or the time of its landed reading. */
function runRevision({ token: _token, attempts, adopted, ...run }: RunRecord): unknown {
  const { at: _at, ...landed } = adopted?.landed ?? { at: "" };
  return { ...run, attempts: attempts.map((attempt) => attempt.state), adopted: adopted && { ...adopted, landed } };
}

const byKey = (a: [string, unknown] | unknown[], b: [string, unknown] | unknown[]) => String(a[0]).localeCompare(String(b[0]));

export function changesToken(dashboard: Dashboard): string {
  if (!dashboard.owner) return hash(`not the owner: ${dashboard.ownerReason}`);
  const spaces = [...dashboard.spaces.values()].map(({ record, sync }) => {
    const { pending, error, conflicts, lateClaims, warnings } = sync.state;
    return [record, planHead(sync.plan), pending, error ?? "", conflicts.length, lateClaims.length, warnings.length];
  });
  const runs = [...(dashboard.runs?.runs.values() ?? [])].map(runRevision);
  const events = (dashboard.events?.events ?? []).map(({ id, read_at, summary }) => [id, read_at ?? "", summary]);
  const prs = [...dashboard.prs.seen].sort(byKey);
  const issues = [...dashboard.issues.seen].map(([key, { at: _at, ...view }]) => [key, view]).sort(byKey);
  const merged = [...dashboard.merged.seen].map(([key, { at: _at, ...view }]) => [key, view]).sort(byKey);
  return hash(
    JSON.stringify([spaces, runs, events, dashboard.events?.latest ?? 0, prs, issues, merged, dashboard.runHistory.settled, dashboard.warnings.length, dashboard.follower.revision]),
  );
}

/** How old a tracked trunk checkout's landed reading may be before the poll asks git again. */
const LANDED_POLL_MS = 60_000;

/**
 * The poll's answer. An open screen no longer reads the overview every few seconds, so the PR/MR pass
 * that read started starts here, at its limit of once a minute; so does a landed reading of each live
 * tracked trunk checkout, which runs git there. None is waited for.
 */
export function readChanges(dashboard: Dashboard): RpcOutput<typeof changesRpc> {
  dashboard.peekPrs();
  for (const run of dashboard.runs?.runs.values() ?? []) if (run.adopted?.trunk && dashboard.isLive(run)) dashboard.peekLanded(run, LANDED_POLL_MS);
  return { token: changesToken(dashboard) };
}
