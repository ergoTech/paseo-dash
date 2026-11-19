import type { PaseoApi } from "./paseo.ts";

/**
 * A provider's usage limit as the autopilot meets it (JOBBY-AH5Z0): an agent's turn that failed on
 * the limit, and when the limit resets. The autopilot holds every start until then, so a queue
 * waits out the limit instead of starting task after task into it, and starts again after the reset.
 *
 * Where the reset time comes from, most trusted first:
 * - the failed turn's own error text, when it names the reset ("…|1763215200", "resets 7pm (Europe/Kyiv)");
 * - Paseo's usage report (`providers.listUsage`): a window of the agent's provider used up, with its
 *   `resetsAt`; Paseo answers "Usage is off on this host" when the user has not turned usage on;
 * - neither: a bounded backoff (BACKOFF_MIN), doubled each time a start after a hold meets the limit again.
 */

/**
 * Errors of a turn that hit a usage or rate limit. Neither an overloaded provider (529) nor a full
 * context window ("Context limit reached") is one: waiting does not help the first, a reset not the second.
 */
const LIMIT = /usage limit|rate[ _-]?limit|hit your (?:usage )?limit|(?:session|weekly|\d+-hour|hourly|daily|opus|sonnet) limit|\b429\b|too many requests|quota exceeded/i;

export function isRateLimit(text: string | undefined): boolean {
  return Boolean(text && LIMIT.test(text));
}

/** Minutes a hold lasts with no reset time known, by how many holds in a row met the limit (the last one repeats). */
export const BACKOFF_MIN = [15, 30, 60, 120, 240] as const;

export function backoffMs(strikes: number): number {
  return BACKOFF_MIN[Math.min(Math.max(strikes, 1), BACKOFF_MIN.length) - 1]! * 60_000;
}

/** A reset further away than this is not believed: no provider window is longer than a week. */
const MAX_AHEAD_MS = 8 * 24 * 3_600_000;

function plausible(at: Date, now: Date): Date | undefined {
  const ms = at.getTime() - now.getTime();
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_AHEAD_MS ? at : undefined;
}

/** The wall clock in `timeZone` (an IANA name), or undefined when the name is not one. */
function clockIn(now: Date, timeZone: string | undefined): { h: number; m: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? { h, m } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reset an error text names: a Unix time after a bar (Claude Code's "Claude AI usage limit
 * reached|<seconds>"), or a clock time after "resets" with an optional time zone in brackets, read as
 * its next occurrence; undefined when it names none that can be read.
 */
export function resetFrom(text: string | undefined, now: Date): Date | undefined {
  if (!text) return undefined;
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return plausible(new Date(Number(epoch[1]) * 1000), now);
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!clock) return undefined;
  let h = Number(clock[1]);
  const m = Number(clock[2] ?? 0);
  const half = clock[3]?.toLowerCase();
  if (half && (h < 1 || h > 12)) return undefined;
  if (half === "pm" && h !== 12) h += 12;
  if (half === "am" && h === 12) h = 0;
  if (h > 23 || m > 59) return undefined;
  const nowAt = clockIn(now, clock[4]?.trim());
  if (!nowAt) return undefined;
  let minutes = h * 60 + m - (nowAt.h * 60 + nowAt.m);
  if (minutes <= 0) minutes += 24 * 60;
  const at = new Date(now.getTime() + minutes * 60_000);
  at.setUTCSeconds(0, 0);
  return plausible(at, now);
}

export type UsageReading = { resetsAt: Date; window: string } | { unavailable: string } | { clear: true };

const USAGE_TIMEOUT_MS = 5_000;

/**
 * What Paseo's usage report says of `provider` (the provider part of `claude/claude-opus-5-5`): the
 * latest reset of a window used up, `clear` when the report has the provider with nothing used up,
 * or why it cannot tell. It never waits more than USAGE_TIMEOUT_MS.
 */
export async function readUsage(paseo: PaseoApi | undefined, provider: string, now: Date): Promise<UsageReading> {
  const list = (paseo?.providers as { listUsage?: () => Promise<unknown> } | undefined)?.listUsage;
  if (!list) return { unavailable: "this Paseo has no usage report" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (await Promise.race([
      list.call(paseo!.providers),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer in 5 s")), USAGE_TIMEOUT_MS);
      }),
    ])) as { providers?: { providerId?: string; status?: string; error?: string | null; windows?: { label?: string; usedPct?: number | null; resetsAt?: string | null }[] }[] };
    const own = (read.providers ?? []).filter((p) => p.providerId === provider || p.providerId?.split("/")[0] === provider);
    if (!own.length) return { unavailable: `the usage report has no ${provider || "provider of the agent"}` };
    const usable = own.filter((p) => p.status === "available");
    if (!usable.length) return { unavailable: own[0]!.error || `the usage report of ${provider} is ${own[0]!.status ?? "unknown"}` };
    let latest: { resetsAt: Date; window: string } | undefined;
    for (const p of usable) {
      for (const w of p.windows ?? []) {
        if ((w.usedPct ?? 0) < 100) continue;
        const at = plausible(new Date(w.resetsAt ?? ""), now);
        if (at && (!latest || at > latest.resetsAt)) latest = { resetsAt: at, window: w.label ?? "a window" };
      }
    }
    return latest ?? { clear: true };
  } catch (error) {
    return { unavailable: String((error as Error)?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
