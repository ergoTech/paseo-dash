import { frontData, parseEntity, readAcceptance, readBrief, readClarifications } from "../plan/document.ts";
import type { GitRunner } from "../sync/git.ts";
import type { Scope } from "./facts.ts";

/**
 * The card as it stood when its work merged, read from the plan's own history (git log of the card's
 * file), and what a person did to its status since. Scope is what "done" means: the brief, the
 * acceptance lines (their text, not their ticks) and the clarifications. A card someone marked done,
 * canceled or sent to review after the merge is theirs, whatever the merged work says. A history that
 * cannot be read is said, never taken as unchanged; commit times are the committer's clock, so a clock
 * far off can misplace one edit.
 */

const LOG_MS = 10_000;
/** Versions of the card since the merge that are read; more than this is a card people worked on. */
const VERSIONS = 30;

export const scopeText = (brief: string, acceptance: { text: string }[], clarifications: string): string =>
  JSON.stringify([brief.trim(), acceptance.map((line) => line.text), clarifications.trim()]);

const scopeOf = (body: string) => scopeText(readBrief(body), readAcceptance(body), readClarifications(body));

/** Statuses a card may be in after its work merged without anyone having decided about it. */
const OPEN = ["todo", "in_progress"];

export async function scopeSince(git: GitRunner, root: string, path: string, mergedAt: string, asRun: boolean): Promise<Scope> {
  const unknown = (why: string): Scope => ({ unknown: why, acted: "" });
  const merged = Date.parse(mergedAt);
  if (!Number.isFinite(merged)) return unknown("the merge time is not known");
  const log = await git.run(root, ["log", "--format=%H %ct", "--", path], LOG_MS);
  if (log.code !== 0 || log.timedOut) return unknown("the plan's history of the card could not be read");
  const versions = log.stdout
    .split("\n")
    .map((line) => /^([0-9a-f]{40,64}) (\d+)$/.exec(line.trim()))
    .flatMap((m) => (m ? [{ sha: m[1]!, at: Number(m[2]) * 1000 }] : []));
  const baseline = versions.find((v) => v.at <= merged);
  if (!baseline) return unknown("no version of the card from before the merge is in the plan's history");
  const later = versions.filter((v) => v.at > merged);
  if (later.length > VERSIONS) return unknown(`${later.length} versions of the card since the merge: too many to compare`);
  const read = async (sha: string) => {
    const shown = await git.run(root, ["show", `${sha}:${path}`], LOG_MS);
    if (shown.code !== 0 || shown.timedOut) return undefined;
    try {
      const entity = parseEntity(shown.stdout);
      return { front: frontData(entity), body: entity.body };
    } catch {
      return undefined;
    }
  };
  const before = await read(baseline.sha);
  if (!before) return unknown("the version of the card from before the merge could not be read");
  let acted = "";
  for (const version of [...later].reverse()) {
    const then = await read(version.sha);
    if (!then) return unknown("a version of the card since the merge could not be read");
    const status = String(then.front.status ?? "");
    const day = new Date(version.at).toISOString().slice(0, 10);
    if (!acted && !asRun && !OPEN.includes(status)) acted = `it was ${status || "changed"} on ${day}, after the merge`;
  }
  return { then: scopeOf(before.body), unknown: "", acted };
}
