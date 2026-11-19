import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

/**
 * This machine's choices for ChatGPT through God Mode (shared/godmode.ts) in `godmode.json`. The file
 * is read on every use rather than kept in memory: `meta.describe` answers before the dashboard has
 * started and in an installation that does not own the data, and it must agree with what `tasks.start`
 * enforces after the last write.
 */

const fileSchema = z.object({ version: z.literal(1), start_without_asking: z.boolean() });

export const GODMODE_FILE = "godmode.json";

/** Whether ChatGPT may start a task without asking: off unless a valid file turns it on. */
export function startWithoutAsking(dataDir: string): boolean {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, GODMODE_FILE), "utf8")));
    return parsed.success && parsed.data.start_without_asking;
  } catch {
    return false;
  }
}

/** The owner's check at start: a file that cannot be used is moved aside (and reads as off meanwhile). */
export function checkGodModeFile(dataDir: string): string | undefined {
  return readJsonFile(join(dataDir, GODMODE_FILE), fileSchema, () => ({ version: 1 as const, start_without_asking: false })).movedAside;
}

interface Owner {
  dataDir: string;
  owner: boolean;
  ownerReason: string;
}

export function readGodModeSettings(dashboard: Owner): { start_without_asking: boolean; error: string } {
  return { start_without_asking: startWithoutAsking(dashboard.dataDir), error: dashboard.owner ? "" : dashboard.ownerReason };
}

export function writeGodModeSettings(dashboard: Owner, change: { start_without_asking: boolean }): { start_without_asking: boolean; ok: boolean; error: string } {
  const fail = (error: string) => ({ start_without_asking: startWithoutAsking(dashboard.dataDir), ok: false, error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  try {
    writeJsonFile(join(dashboard.dataDir, GODMODE_FILE), { version: 1, start_without_asking: change.start_without_asking });
  } catch (error) {
    return fail(`not saved: ${String((error as Error)?.message ?? error)}`);
  }
  return { start_without_asking: startWithoutAsking(dashboard.dataDir), ok: true, error: "" };
}
