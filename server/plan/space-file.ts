import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, isMap, isScalar, isSeq, parseDocument, parse as parseYaml, YAMLMap } from "yaml";
import { spaceSchema, type SpaceProject } from "../../shared/model.ts";
import { type Plan, realPathInside } from "./load.ts";

/**
 * Edits of `space.yaml`'s project list, label palette and people (03-model.md, `space.yaml`). The file goes through the YAML
 * syntax tree, so comments, other keys and a project's own unknown keys survive; a project the plugin
 * writes is one flow map per line, like the hand-written ones. The result must read back as a valid
 * space, or nothing is written.
 */

/** The fields of a project the plugin writes; anything else on the entry is left as it is. */
export interface ProjectFields {
  remote: string;
  trunk?: string;
  color?: string;
  group?: string;
  web_host?: string;
}
export const PROJECT_FIELDS = ["remote", "trunk", "color", "group", "web_host"] as const;

const FILE = "space.yaml";
/** Keys a put may write: plain text YAML reads back as the same string key. */
const PROJECT_KEY_TEXT = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * A project's own fields only, without empties and in one key order: what operations compare, so the
 * same change made on two machines replays as `already`, not as a conflict.
 */
export function projectFields(project: Partial<ProjectFields> | undefined | null): ProjectFields | null {
  if (!project || project.remote === undefined) return null;
  const fields: ProjectFields = { remote: project.remote };
  for (const key of ["trunk", "color", "group", "web_host"] as const) if (project[key]) fields[key] = project[key];
  return fields;
}

/** What a label definition says, without empties: what `label_def` operations compare. */
export interface LabelFields {
  color?: string;
  description?: string;
}
export const LABEL_FIELDS = ["color", "description"] as const;

export function labelFields(def: Partial<LabelFields> | undefined | null): LabelFields | null {
  if (!def) return null;
  const fields: LabelFields = {};
  if (def.color) fields.color = def.color.toLowerCase();
  if (def.description) fields.description = def.description;
  return fields;
}

/** What a person entry says, without empties and with GitLab hosts in order: what `person` operations compare. */
export interface PersonFields {
  name?: string;
  emails?: string[];
  github?: string;
  gitlab?: Record<string, string>;
}
export const PERSON_FIELDS = ["name", "emails", "github", "gitlab"] as const;

export function personFields(person: Partial<PersonFields> | undefined | null): PersonFields | null {
  if (!person) return null;
  const fields: PersonFields = {};
  if (person.name) fields.name = person.name;
  if (person.emails?.length) fields.emails = [...person.emails];
  if (person.github) fields.github = person.github;
  const hosts = Object.keys(person.gitlab ?? {}).filter((host) => person.gitlab![host]).sort();
  if (hosts.length) fields.gitlab = Object.fromEntries(hosts.map((host) => [host, person.gitlab![host]!]));
  return fields;
}

/** The project of a space by key: own keys only, so `toString` or `constructor` is never a project. */
export function ownProject<T>(projects: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(projects, key) ? projects[key] : undefined;
}

function sectionMap(document: Document, section: Section): YAMLMap {
  const current = document.get(section, true);
  if (isMap(current)) return current;
  // A list (`labels: [bug, ui]`) or text reads as entries; replacing it would lose them.
  if (current !== undefined && !(isScalar(current) && current.value === null)) {
    throw new Error(`space.yaml's ${section} is not a map; write it as one by hand first`);
  }
  // Missing or `projects: {}` / `projects:` (null): a fresh block map.
  const fresh = new YAMLMap();
  document.set(section, fresh);
  return fresh;
}

function entry(map: YAMLMap, key: string): YAMLMap | undefined {
  const value = map.get(key, true);
  return isMap(value) ? value : undefined;
}

type Section = "projects" | "labels" | "people";

export type SpaceEdit =
  | { kind: "put"; key: string; fields: ProjectFields }
  | { kind: "remove"; key: string }
  | { kind: "order"; order: string[] }
  /** Writes a label or a person; `key` is the one space.yaml already spells, when it has the entry. */
  | { kind: "label"; key: string; fields: LabelFields }
  | { kind: "person"; key: string; fields: PersonFields }
  | { kind: "drop"; section: "labels" | "people"; key: string };

/** Applies one edit to the checkout's space.yaml and keeps `plan.space` in step; throws when it cannot. */
export function editSpace(root: string, plan: Plan, edit: SpaceEdit): void {
  const path = join(root, FILE);
  if (!realPathInside(root, FILE) || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("space.yaml is not a plain file in the plan repository");
  }
  const document = parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length) throw new Error(`space.yaml: ${document.errors[0]!.message}`);
  const section: Section = edit.kind === "drop" ? edit.section : edit.kind === "label" ? "labels" : edit.kind === "person" ? "people" : "projects";
  const map = sectionMap(document, section);

  switch (edit.kind) {
    case "put": {
      if (!PROJECT_KEY_TEXT.test(edit.key)) throw new Error(`${JSON.stringify(edit.key)} is not a project key`);
      const existing = entry(map, edit.key);
      // A listed key the YAML holds as another scalar (`true:`, `null:`) is not found as text; a
      // new entry would duplicate it.
      if (!existing && plan.space && ownProject(plan.space.projects, edit.key)) {
        throw new Error(`space.yaml writes the key ${edit.key} so that it is not text; quote it by hand first`);
      }
      if (existing) {
        for (const field of PROJECT_FIELDS) {
          const value = edit.fields[field];
          if (value === undefined || value === "") existing.delete(field);
          else existing.set(field, value);
        }
      } else {
        const present = Object.fromEntries(PROJECT_FIELDS.filter((f) => edit.fields[f]).map((f) => [f, edit.fields[f]]));
        const node = document.createNode(present) as YAMLMap;
        node.flow = true;
        map.set(edit.key, node);
      }
      // An empty block map printed as `projects:` would read back as null; keep it a block map.
      map.flow = false;
      break;
    }
    case "remove":
    case "drop":
      // A key the YAML map does not hold as text (a number, say) must not pass as removed.
      if (!map.delete(edit.key)) throw new Error(`space.yaml has no ${section} key ${JSON.stringify(edit.key)} to remove`);
      if (map.items.length === 0) map.flow = true;
      break;
    case "label":
    case "person": {
      const listed = edit.kind === "label" ? plan.space?.labels : plan.space?.people;
      const existing = entry(map, edit.key);
      const held = map.get(edit.key, true);
      // An empty or short entry (`bug:`, `bug: "#e5484d"`, `ergo: Ergo`) is replaced by the full
      // form, which says what it said and more; a list or other collection is left to a person.
      if (!existing && held !== undefined && !isScalar(held)) {
        throw new Error(`space.yaml's ${section} entry ${edit.key} is not a map; fix it by hand first`);
      }
      if (!existing && held === undefined && listed && Object.hasOwn(listed, edit.key)) {
        throw new Error(`space.yaml writes the ${section} key ${edit.key} so that it is not text; quote it by hand first`);
      }
      const names = edit.kind === "label" ? LABEL_FIELDS : PERSON_FIELDS;
      const values = edit.fields as Record<string, unknown>;
      const node = (value: unknown) => {
        const created = document.createNode(value);
        if (isMap(created) || isSeq(created)) created.flow = true;
        return created;
      };
      if (existing) {
        for (const field of names) {
          if (values[field] === undefined) existing.delete(field);
          else existing.set(field, node(values[field]));
        }
      } else {
        const fresh = document.createNode(Object.fromEntries(names.filter((f) => values[f] !== undefined).map((f) => [f, values[f]]))) as YAMLMap;
        fresh.flow = true;
        map.set(edit.key, fresh);
      }
      map.flow = false;
      break;
    }
    case "order": {
      const rank = new Map(edit.order.map((key, index) => [key, index]));
      const keyOf = (item: (typeof map.items)[number]) => String((item.key as { value?: unknown })?.value ?? item.key);
      map.items.sort((a, b) => (rank.get(keyOf(a)) ?? Infinity) - (rank.get(keyOf(b)) ?? Infinity));
      break;
    }
  }

  const text = document.toString({ lineWidth: 0, flowCollectionPadding: true });
  const parsed = spaceSchema.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`space.yaml would not be valid: ${parsed.error.issues[0]!.message}`);
  writeFileSync(path, text);
  plan.space = parsed.data;
}
