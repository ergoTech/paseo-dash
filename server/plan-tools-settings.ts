import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

/**
 * This machine's switch for the plan tools of any agent (shared/plan-tools.ts) in `plan-tools.json`.
 * Read on every use, like godmode.json: a session opening and a tool call follow the last write,
 * and an installation that does not own the data still reads it as the owner wrote it.
 */

const fileSchema = z.object({ version: z.literal(1), enabled: z.boolean() });

export const PLAN_TOOLS_FILE = "plan-tools.json";

/** Off unless a valid file turns it on. */
export function planToolsOn(dataDir: string): boolean {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, PLAN_TOOLS_FILE), "utf8")));
    return parsed.success && parsed.data.enabled;
  } catch {
    return false;
  }
}

/** The owner's check at start: a file that cannot be used is moved aside (and reads as off meanwhile). */
export function checkPlanToolsFile(dataDir: string): string | undefined {
  return readJsonFile(join(dataDir, PLAN_TOOLS_FILE), fileSchema, () => ({ version: 1 as const, enabled: false })).movedAside;
}

interface Owner {
  dataDir: string;
  owner: boolean;
  ownerReason: string;
}

export function readPlanToolsSettings(dashboard: Owner): { enabled: boolean; error: string } {
  return { enabled: planToolsOn(dashboard.dataDir), error: dashboard.owner ? "" : dashboard.ownerReason };
}

export function writePlanToolsSettings(dashboard: Owner, change: { enabled: boolean }): { enabled: boolean; ok: boolean; error: string } {
  const fail = (error: string) => ({ enabled: planToolsOn(dashboard.dataDir), ok: false, error });
  if (!dashboard.owner) return fail(dashboard.ownerReason || "Paseo Dash has not started");
  try {
    writeJsonFile(join(dashboard.dataDir, PLAN_TOOLS_FILE), { version: 1, enabled: change.enabled });
  } catch (error) {
    return fail(`not saved: ${String((error as Error)?.message ?? error)}`);
  }
  return { enabled: planToolsOn(dashboard.dataDir), ok: true, error: "" };
}
