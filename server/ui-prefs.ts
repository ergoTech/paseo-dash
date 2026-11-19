import { join } from "node:path";
import { z } from "zod";
import { RECENT_MAX, type RecentItem, recentItem } from "../shared/ui.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

/**
 * This machine's display choices (03-model.md, Runtime files) in `ui.json`: whether the sidebar
 * shows a row per space next to the all-spaces "Paseo Dash" row, and the places a person opened
 * last, which the search offers while its field is empty. Memory changes only after the file is
 * written.
 */

const prefsSchema = z.object({
  version: z.literal(1),
  space_rows: z.boolean(),
  // A file from before the recent places has none; a list that does not read is dropped, not the file.
  recent: z.array(recentItem).max(RECENT_MAX).default([]).catch([]),
});
export type UiPrefs = { space_rows: boolean };

export class UiPrefsStore {
  private readonly path: string;
  private prefs: z.output<typeof prefsSchema>;
  /** Set when the file could not be read and was moved aside. */
  readonly movedAside: string | undefined;

  constructor(dir: string) {
    this.path = join(dir, "ui.json");
    // Off by default: with several spaces the sidebar shows the one all-spaces row.
    const read = readJsonFile(this.path, prefsSchema, () => ({ version: 1 as const, space_rows: false, recent: [] }));
    this.prefs = read.value;
    this.movedAside = read.movedAside;
  }

  get(): UiPrefs {
    return { space_rows: this.prefs.space_rows };
  }

  set(change: Partial<UiPrefs>): UiPrefs {
    const next = { ...this.prefs, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) };
    writeJsonFile(this.path, next);
    this.prefs = next;
    return this.get();
  }

  recent(): RecentItem[] {
    return this.prefs.recent;
  }

  /** Puts `item` first, once, keeping the newest RECENT_MAX; no write when it is first already. */
  addRecent(item: RecentItem): RecentItem[] {
    const same = (r: RecentItem) => r.kind === item.kind && r.id === item.id && r.space === item.space;
    const first = this.prefs.recent[0];
    if (first && same(first) && first.title === item.title) return this.prefs.recent;
    const next = { ...this.prefs, recent: [item, ...this.prefs.recent.filter((r) => !same(r))].slice(0, RECENT_MAX) };
    writeJsonFile(this.path, next);
    this.prefs = next;
    return next.recent;
  }
}

/** The `ui.recent` read: none when this installation does not own the data. */
export function readRecent(dashboard: { prefs: UiPrefsStore | undefined; owner: boolean; ownerReason: string }): { items: RecentItem[]; error: string } {
  if (!dashboard.prefs) return { items: [], error: dashboard.owner ? "" : dashboard.ownerReason };
  return { items: dashboard.prefs.recent(), error: "" };
}

export function addRecent(dashboard: { prefs: UiPrefsStore | undefined; owner: boolean; ownerReason: string }, item: RecentItem): { ok: boolean; error: string } {
  if (!dashboard.prefs) return { ok: false, error: dashboard.ownerReason || "Paseo Dash has not started" };
  try {
    dashboard.prefs.addRecent(item);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: `not saved: ${String((error as Error)?.message ?? error)}` };
  }
}

/** The `ui.prefs` read: the defaults when this installation does not own the data. */
export function readPrefs(dashboard: { prefs: UiPrefsStore | undefined; owner: boolean; ownerReason: string }): UiPrefs & { error: string } {
  if (!dashboard.prefs) return { space_rows: false, error: dashboard.owner ? "" : dashboard.ownerReason };
  return { ...dashboard.prefs.get(), error: "" };
}

export function writePrefs(dashboard: { prefs: UiPrefsStore | undefined; owner: boolean; ownerReason: string }, change: Partial<UiPrefs>): UiPrefs & { ok: boolean; error: string } {
  const fail = (error: string) => ({ ...readPrefs(dashboard), ok: false, error });
  if (!dashboard.prefs) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  try {
    return { ...dashboard.prefs.set(change), ok: true, error: "" };
  } catch (error) {
    return fail(`not saved: ${String((error as Error)?.message ?? error)}`);
  }
}
