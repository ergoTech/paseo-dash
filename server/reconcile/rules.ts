import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ReconcileMode } from "../../shared/reconcile.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";

/**
 * This machine's rule per project (`reconcile.json`): which projects Paseo Dash reconciles and whether
 * it may close a card there. Read on every use, like godmode.json and plan-tools.json: a pass and an
 * apply follow the last write, and a file that cannot be read means off. The rule is this machine's,
 * never the plan's: a collaborator who can push to the plan cannot switch another machine's closing on.
 */

const entry = z.object({ space: z.string(), project: z.string(), mode: z.enum(["report", "close"]), no_checks_ok: z.boolean().default(false) });
const fileSchema = z.object({ version: z.literal(1), projects: z.array(entry) });

export const RECONCILE_FILE = "reconcile.json";

export interface Rule {
  space: string;
  project: string;
  mode: Exclude<ReconcileMode, "off">;
  no_checks_ok: boolean;
}

function read(dataDir: string): Rule[] {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, RECONCILE_FILE), "utf8")));
    return parsed.success ? parsed.data.projects : [];
  } catch {
    return [];
  }
}

/** The rule of one project of a space; undefined when it is off. */
export function ruleOf(dataDir: string, space: string, project: string): Rule | undefined {
  return read(dataDir).find((rule) => rule.space === space && rule.project === project);
}

export function allRules(dataDir: string): Rule[] {
  return read(dataDir);
}

/** The owner's check at start: a file that cannot be used is moved aside (and reads as off meanwhile). */
export function checkRulesFile(dataDir: string): string | undefined {
  return readJsonFile(join(dataDir, RECONCILE_FILE), fileSchema, () => ({ version: 1 as const, projects: [] })).movedAside;
}

export function writeRule(dataDir: string, change: { space: string; project: string; mode: ReconcileMode; no_checks_ok: boolean }): void {
  const rest = read(dataDir).filter((rule) => !(rule.space === change.space && rule.project === change.project));
  const projects = change.mode === "off" ? rest : [...rest, { space: change.space, project: change.project, mode: change.mode, no_checks_ok: change.no_checks_ok }];
  writeJsonFile(join(dataDir, RECONCILE_FILE), { version: 1, projects });
}
