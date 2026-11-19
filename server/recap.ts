import type { RpcInput } from "@getpaseo/plugin";
import {
  RECAP_DEFAULT_DAYS,
  RECAP_DEFAULT_LIMIT,
  RECAP_KINDS,
  RECAP_MAX_DAYS,
  type Recap,
  type RecapEvent,
  type recapRpc,
} from "../shared/recap.ts";
import type { Dashboard, SpaceRecord } from "./dashboard.ts";
import { planFileUrl, spacesOf } from "./events.ts";
import type { ChangesRead, PlanChange } from "./plan/recap.ts";
import type { SpaceSync } from "./sync/space-sync.ts";

/**
 * A recap of the plan over a period (shared/recap.ts): every connected space's task changes from its
 * clone's commits, newest first, with who, when and a link. Read when asked, never stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a read waits for a space's history; Paseo stops waiting for an RPC after 30 s. */
export const RECAP_WAIT_MS = 10_000;
/**
 * The answer as JSON stays under this many characters, whatever `limit` asks: the events that do
 * not fit are left out and `more` says so. God Mode speaks only the first 1,500 characters; the rest
 * reaches ChatGPT as structured data.
 */
export const RECAP_MAX_CHARS = 32_000;

/** The start of the period: a date is midnight on this machine; at most RECAP_MAX_DAYS days back. */
export function parseSince(text: string | undefined, now: Date): Date | string {
  if (!text) return new Date(now.getTime() - RECAP_DEFAULT_DAYS * DAY_MS);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const since = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(text);
  // A date that does not exist (2026-02-30) would roll over into the next month.
  const real = !day || (since.getMonth() === Number(day[2]) - 1 && since.getDate() === Number(day[3]));
  if (Number.isNaN(since.getTime()) || !real) return `since «${text}» is not a date: use 2026-10-23 or 2026-10-23T09:00:00Z`;
  if (since.getTime() > now.getTime()) return `since «${text}» is in the future`;
  // By the calendar, so that "31 days ago" as a date is still inside the window.
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - RECAP_MAX_DAYS);
  if (since.getTime() < earliest.getTime()) return `since «${text}» is more than ${RECAP_MAX_DAYS} days ago; a recap reaches back ${RECAP_MAX_DAYS} days at most`;
  return since;
}

type Read = { ok: true; read: ChangesRead } | { ok: false; why: string };

function readWithin(dashboard: Dashboard, sync: SpaceSync, since: Date, waitMs: number): Promise<Read> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Read>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, why: "its history is still being read from git; ask again shortly" }), waitMs);
  });
  const read = dashboard.recap.read(sync.gitRunner, sync.root, since).then(
    (value): Read => ({ ok: true, read: value }),
    (error: unknown): Read => ({ ok: false, why: `its history could not be read: ${String((error as Error)?.message ?? error)}` }),
  );
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** The person a commit names: their name in the space when their email is listed there. */
function personOf(sync: SpaceSync, change: PlanChange): string {
  if (change.kind === "started" && change.run_by) return change.run_by;
  const email = change.email.toLowerCase();
  const people = Object.values(sync.plan.space?.people ?? {});
  const person = email ? people.find((p) => p.emails.some((e) => e.toLowerCase() === email)) : undefined;
  return person?.name || change.author || change.email;
}

function eventOf(record: SpaceRecord, sync: SpaceSync, change: PlanChange): RecapEvent {
  // The task's page where it is now: a file renamed since still has its link.
  const loaded = sync.plan.entities.get(change.task_id);
  return {
    kind: change.kind,
    task_id: change.task_id,
    title: change.title,
    space: record.key,
    project: change.project,
    at: change.at,
    by: personOf(sync, change),
    detail: change.detail,
    pr: change.pr,
    link: loaded ? planFileUrl(record.remote, record.branch, loaded.path) : "",
    by_hand: change.by_hand,
  };
}

/** The first events, newest first, that fit RECAP_MAX_CHARS together with the rest of the answer. */
function fit(answer: Recap, events: RecapEvent[]): RecapEvent[] {
  let size = JSON.stringify({ ...answer, events: [] }).length;
  const shown: RecapEvent[] = [];
  for (const event of events) {
    size += JSON.stringify(event).length + 1;
    if (size > RECAP_MAX_CHARS) break;
    shown.push(event);
  }
  return shown;
}

export async function readRecap(
  dashboard: Dashboard,
  input: RpcInput<typeof recapRpc>,
  now: Date = new Date(),
  waitMs = RECAP_WAIT_MS,
): Promise<Recap> {
  const fail = (error: string, since = ""): Recap => ({ since, counts: {}, total: 0, more: false, partial: "", events: [], error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  const since = parseSince(input.since, now);
  if (typeof since === "string") return fail(since);
  const spaces = spacesOf(dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error, since.toISOString());
  const chosen = [...dashboard.spaces.values()].filter(({ record }) => !spaces.keys || spaces.keys.has(record.key));
  const reads = await Promise.all(chosen.map(async ({ record, sync }) => ({ record, sync, result: await readWithin(dashboard, sync, since, waitMs) })));

  const kinds = new Set(input.kinds?.length ? input.kinds : RECAP_KINDS);
  const found: { event: RecapEvent; commit: number; n: number }[] = [];
  const partial: string[] = [];
  for (const { record, sync, result } of reads) {
    if (!result.ok) {
      partial.push(`${record.name} (${record.key}): ${result.why}`);
      continue;
    }
    if (result.read.cutAt) partial.push(`${record.name} (${record.key}): only its newest commits were read, back to ${result.read.cutAt}`);
    for (const change of result.read.changes) {
      if (kinds.has(change.kind)) found.push({ event: eventOf(record, sync, change), commit: change.commit, n: found.length });
    }
  }
  // Newest first. Commit dates are whole seconds: within one, a space's later commit first. A commit
  // does not say in which order its files changed (git lists them by path); of one task's changes in
  // it, the later one comes first (started before created).
  found.sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at) || b.commit - a.commit || b.n - a.n);
  const events = found.map((f) => f.event);
  const counts: Record<string, number> = {};
  for (const kind of RECAP_KINDS) {
    const n = events.filter((e) => e.kind === kind).length;
    if (n) counts[kind] = n;
  }
  const answer: Recap = { since: since.toISOString(), counts, total: events.length, more: false, partial: partial.join("; "), events: [], error: "" };
  answer.events = fit(answer, events.slice(0, input.limit ?? RECAP_DEFAULT_LIMIT));
  answer.more = events.length > answer.events.length;
  return answer;
}
