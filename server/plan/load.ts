import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ENTITY_DIRS,
  type Entity,
  type EntityType,
  featureSchema,
  milestoneSchema,
  type Space,
  spaceSchema,
  taskSchema,
} from "../../shared/model.ts";
import { findLabel } from "../../shared/labels.ts";
import { type AcceptanceLine, briefHash, frontData, type Handoff, parseEntity, readAcceptance, readBrief, readClarifications, readHandoff, readNotes } from "./document.ts";

export interface LoadedEntity {
  entity: Entity;
  /** Path relative to the plan repo's root. */
  path: string;
  brief: string;
  briefHash: string;
  acceptance: AcceptanceLine[];
  /** The text of `## Notes`: kept for search, never written from here. */
  notes: string;
  /** The latest `## Handoff` a run left (03-model.md, Task), if any. */
  handoff?: Handoff;
  /** The text of `## Clarifications`, the clarifications people gave when starting the task, if any. */
  clarifications?: string;
}

export interface PlanProblem {
  path: string;
  reason: string;
}

export interface Plan {
  space: Space | undefined;
  entities: Map<string, LoadedEntity>;
  /** Ids claimed by more than one file: never written to until a person renames one. */
  duplicates: Set<string>;
  problems: PlanProblem[];
}

/**
 * Whether a repo-relative path stays a real path inside the repo: no component that exists is a
 * symlink, so nothing read or written through it can land outside the clone.
 */
export function realPathInside(root: string, path: string): boolean {
  let current = root;
  for (const part of path.split("/")) {
    if (!part || part === "." || part === "..") return false;
    current = join(current, part);
    // lstat, not exists: a dangling symlink counts as a symlink.
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return true;
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

const SCHEMAS = { milestone: milestoneSchema, feature: featureSchema, task: taskSchema } as const;

/** Parses and validates an entity file's text; throws with the first problem. */
export function validateEntityText(text: string, type: EntityType): LoadedEntity {
  const document = parseEntity(text);
  const data = frontData(document);
  if (data.type !== type) throw new Error(`type is ${JSON.stringify(data.type)}, expected "${type}" in ${ENTITY_DIRS[type]}/`);
  const parsed = SCHEMAS[type].safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.join(".") || "front matter"}: ${issue.message}`);
  }
  const brief = readBrief(document.body);
  const handoff = readHandoff(document.body);
  const clarifications = readClarifications(document.body);
  return {
    entity: parsed.data,
    path: "",
    brief,
    briefHash: briefHash(brief),
    acceptance: readAcceptance(document.body),
    notes: readNotes(document.body),
    ...(handoff ? { handoff } : {}),
    ...(clarifications ? { clarifications } : {}),
  };
}

export function readEntityFile(root: string, path: string, type: EntityType): LoadedEntity {
  return { ...validateEntityText(readFileSync(join(root, path), "utf8"), type), path };
}

/** Loads everything in a plan repo checkout. A file that does not parse is listed, never dropped. */
export function loadPlan(root: string): Plan {
  const plan: Plan = { space: undefined, entities: new Map(), duplicates: new Set(), problems: [] };
  const spacePath = join(root, "space.yaml");
  if (existsSync(spacePath) && !lstatSync(spacePath).isFile()) {
    plan.problems.push({ path: "space.yaml", reason: "not a regular file (a symlink or a directory); ignored" });
  } else if (existsSync(spacePath)) {
    try {
      const parsed = spaceSchema.safeParse(parseYaml(readFileSync(spacePath, "utf8")));
      if (parsed.success) plan.space = parsed.data;
      else plan.problems.push({ path: "space.yaml", reason: parsed.error.issues[0]!.message });
    } catch (error) {
      plan.problems.push({ path: "space.yaml", reason: String((error as Error).message) });
    }
  } else {
    plan.problems.push({ path: "space.yaml", reason: "missing: this is not a plan repository yet" });
  }

  for (const [type, dir] of Object.entries(ENTITY_DIRS) as [EntityType, string][]) {
    const absolute = join(root, dir);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory()) {
      plan.problems.push({ path: `${dir}/`, reason: "not a directory of the repository (a symlink?); ignored" });
      continue;
    }
    for (const name of readdirSync(absolute).filter((n) => n.endsWith(".md")).sort()) {
      const path = `${dir}/${name}`;
      if (!lstatSync(join(absolute, name)).isFile()) {
        plan.problems.push({ path, reason: "not a regular file (a symlink or a directory); ignored" });
        continue;
      }
      let loaded: LoadedEntity;
      try {
        loaded = readEntityFile(root, path, type);
      } catch (error) {
        plan.problems.push({ path, reason: String((error as Error).message) });
        continue;
      }
      const id = loaded.entity.id;
      const earlier = plan.entities.get(id);
      if (earlier || plan.duplicates.has(id)) {
        plan.duplicates.add(id);
        plan.problems.push({ path, reason: `duplicate id ${id}${earlier ? ` (also ${earlier.path})` : ""}` });
        continue;
      }
      plan.entities.set(id, loaded);
    }
  }
  return plan;
}

/**
 * Everything wrong with the plan a person should see: files that do not load, and labels tasks carry
 * that space.yaml's palette does not define (typed by hand; the dashboard defines what it writes).
 * Computed from the current plan, so a label defined since stops being listed without a reload.
 */
export function planProblems(plan: Plan): PlanProblem[] {
  const problems = [...plan.problems];
  if (!plan.space) return problems;
  for (const loaded of plan.entities.values()) {
    if (loaded.entity.type !== "task") continue;
    const missing = loaded.entity.labels.filter((label) => !findLabel(plan.space!.labels, label));
    if (missing.length) {
      problems.push({ path: loaded.path, reason: `label${missing.length > 1 ? "s" : ""} ${missing.map((l) => `«${l}»`).join(", ")} not defined in space.yaml` });
    }
  }
  return problems;
}
