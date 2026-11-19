import { basename } from "node:path";
import { type Entity, type EntityType, ID_PATTERN, refId, type Task } from "../../shared/model.ts";
import type { Dashboard, SpaceRecord } from "../dashboard.ts";
import type { LoadedEntity } from "../plan/load.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { findPerson } from "../../shared/labels.ts";
import { onlyOne, search, titleFields } from "../search/core.ts";
import { idForms } from "../search/text.ts";

/**
 * Names to things (06-god-mode.md, Resolving names): an exact id (in any case, with or without its
 * dash, or its suffix alone: server/search/text.ts idForms), else an exact title, else the only
 * entity whose title has every word asked for, all ignoring case. Several equal candidates are an
 * error naming them, never a guess; the same rule serves reads and writes. A name that matches
 * nothing says which entities come closest, with their ids. Reads that only show a task may go
 * further: `resolveTaskForRead`.
 */

export interface SpaceEntry {
  record: SpaceRecord;
  sync: SpaceSync;
}

/** `missing`: nothing matched the name, as opposed to several things or a broken plan. */
export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string; missing?: boolean };

export interface FoundEntity<E extends Entity = Entity> {
  space: SpaceEntry;
  loaded: LoadedEntity;
  entity: E;
}

const NOUN: Record<EntityType, [string, string]> = {
  task: ["task", "tasks"],
  feature: ["feature", "features"],
  milestone: ["milestone", "milestones"],
};

const MAX_CANDIDATES = 5;

export function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Whether every asked word is a whole word of the text: "ne" does not name «one». */
export function hasEveryWord(text: string, asked: string[]): boolean {
  const own = new Set(words(text));
  return asked.every((w) => own.has(w));
}

function statusOf(entity: Entity): string {
  return entity.status;
}

/** `LAC-1A2B3 «Fix flaky login test» (todo)` */
export function describe(entity: Entity): string {
  return `${entity.id} «${entity.title}» (${statusOf(entity)})`;
}

function ambiguous(type: EntityType, asked: string, found: FoundEntity[]): string {
  const listed = found.slice(0, MAX_CANDIDATES).map((f) => describe(f.entity)).join(", ");
  const more = found.length > MAX_CANDIDATES ? ` and ${found.length - MAX_CANDIDATES} more` : "";
  return `${found.length} ${NOUN[type][1]} match «${asked}»: ${listed}${more}. Ask which one, or use the id.`;
}

export function spaceEntries(dashboard: Dashboard): SpaceEntry[] {
  return [...dashboard.spaces.values()];
}

function knownSpaces(dashboard: Dashboard): string {
  const known = spaceEntries(dashboard).map(({ record }) => `${record.name} (${record.key})`).join(", ");
  return known ? `spaces: ${known}` : "no space is connected yet";
}

/** Reads: every space, or the one named. */
export function resolveSpaces(dashboard: Dashboard, asked: string | undefined): Resolved<SpaceEntry[]> {
  const all = spaceEntries(dashboard);
  if (!asked) return { ok: true, value: all };
  const wanted = asked.trim().toLowerCase();
  const exact = all.filter(({ record }) => record.key.toLowerCase() === wanted || record.name.toLowerCase() === wanted);
  if (exact.length === 1) return { ok: true, value: exact };
  const asWords = words(asked);
  const loose = all.filter(({ record }) => hasEveryWord(record.name, asWords));
  if (exact.length === 0 && loose.length === 1) return { ok: true, value: loose };
  return { ok: false, error: `No single space matches «${asked.trim()}»; ${knownSpaces(dashboard)}.` };
}

/** Creates: the space named, or the only one. */
export function resolveCreateSpace(dashboard: Dashboard, asked: string | undefined): Resolved<SpaceEntry> {
  if (asked) {
    const found = resolveSpaces(dashboard, asked);
    return found.ok ? { ok: true, value: found.value[0]! } : found;
  }
  const all = spaceEntries(dashboard);
  if (all.length === 1) return { ok: true, value: all[0]! };
  if (all.length === 0) return { ok: false, error: "No space is connected yet; connect a plan repository in Paseo's settings." };
  return { ok: false, error: `Say which space: ${knownSpaces(dashboard)}.` };
}

/** An entity of one type by id or title words, across the given spaces. */
export function resolveEntity<T extends EntityType>(
  spaces: SpaceEntry[],
  type: T,
  asked: string,
): Resolved<FoundEntity<Extract<Entity, { type: T }>>> {
  const text = asked.trim();
  const candidates: FoundEntity[] = [];
  for (const space of spaces) {
    for (const loaded of space.sync.plan.entities.values()) {
      if (loaded.entity.type === type) candidates.push({ space, loaded, entity: loaded.entity });
    }
  }
  const pick = (found: FoundEntity[]): Resolved<FoundEntity<Extract<Entity, { type: T }>>> | undefined => {
    if (found.length === 1) return { ok: true, value: found[0] as FoundEntity<Extract<Entity, { type: T }>> };
    if (found.length > 1) return { ok: false, error: ambiguous(type, text, found) };
    return undefined;
  };

  const id = refId(text) ?? (ID_PATTERN.test(text.toUpperCase()) ? text.toUpperCase() : undefined);
  if (id) {
    const byId = candidates.filter((c) => c.entity.id === id);
    const duplicated = spaces.some((s) => s.sync.plan.duplicates.has(id));
    if (duplicated) return { ok: false, error: `${id} is claimed by two files in the plan repo; rename one first.` };
    return pick(byId) ?? { ok: false, error: `No ${NOUN[type][0]} ${id}.` };
  }
  // An id typed some other way ("lac7k3qx", "7K3QX") names the entity that has it; a name that only
  // looks like one («Laconote» in LAC reads as LAC-0N0TE) goes on to the titles.
  const forms = idForms(text, spaces.map((s) => s.record.key));
  const byForm = forms.full || forms.suffix ? candidates.filter((c) => (forms.full ? c.entity.id === forms.full : c.entity.id.endsWith(`-${forms.suffix}`))) : [];
  const claimed = byForm.find((c) => c.space.sync.plan.duplicates.has(c.entity.id));
  if (claimed) return { ok: false, error: `${claimed.entity.id} is claimed by two files in the plan repo; rename one first.` };
  const picked = pick(byForm);
  if (picked) return picked;
  const lower = text.toLowerCase();
  const byTitle = pick(candidates.filter((c) => c.entity.title.toLowerCase() === lower));
  if (byTitle) return byTitle;
  const asked_ = words(text);
  if (asked_.length) {
    const byWords = pick(candidates.filter((c) => hasEveryWord(c.entity.title, asked_)));
    if (byWords) return byWords;
  }
  return { ok: false, error: `No ${NOUN[type][0]} matches «${text}».${closest(type, candidates, text)}`, missing: true };
}

const CLOSEST = 5;

/** " Closest: LAC-7K3QX «…» (todo), …. Use the id." from search, or "" when nothing is near. */
function closest(type: EntityType, candidates: FoundEntity[], text: string): string {
  const items = candidates.map((found) => ({ loaded: found.loaded, plan: found.space.sync.plan, found }));
  const hits = search(items, text, { partial: true, fields: type === "task" ? undefined : titleFields })?.hits ?? [];
  if (!hits.length) return "";
  return ` Closest: ${hits.slice(0, CLOSEST).map((h) => describe(h.item.found.entity)).join(", ")}. Use the id.`;
}

export interface ReadResolved<E extends Entity> {
  found: Resolved<FoundEntity<E>>;
  /** When the name was no id or title: where search found the task, "notes: «…»"; else "". */
  foundBy: string;
}

/**
 * A task for a read that only shows it (God Mode's `task` and `task_result`): `resolveEntity`, and
 * when that matches nothing, search, if it points to one task clearly (server/search/core.ts
 * onlyOne). Writes, and reads that come before one, keep to `resolveEntity`: a write never goes to a
 * guessed task.
 */
export function resolveTaskForRead(spaces: SpaceEntry[], asked: string): ReadResolved<Extract<Entity, { type: "task" }>> {
  const strict = resolveEntity(spaces, "task", asked);
  if (strict.ok || !strict.missing) return { found: strict, foundBy: "" };
  const items = spaces.flatMap((space) =>
    [...space.sync.plan.entities.values()].filter((loaded) => loaded.entity.type === "task").map((loaded) => ({ loaded, plan: space.sync.plan, space })),
  );
  const found = search(items, asked);
  const one = found ? onlyOne(found, asked) : undefined;
  if (!one) return { found: strict, foundBy: "" };
  const { loaded, space } = one.item;
  return { found: { ok: true, value: { space, loaded, entity: loaded.entity as Task } }, foundBy: `${one.match.field.replace("_", " ")}: «${one.match.quote}»` };
}

/** The repository name of a remote URL: `git@host:acme/core.git` → `core`. */
function repoName(remote: string): string {
  return remote.replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() ?? "";
}

/** A project key of the space by its key or its repository's name. */
export function resolveProject(space: SpaceEntry, asked: string): Resolved<string> {
  const projects = space.sync.plan.space?.projects ?? {};
  const wanted = asked.trim().toLowerCase();
  const keys = Object.keys(projects);
  const byKey = keys.filter((key) => key.toLowerCase() === wanted);
  if (byKey.length === 1) return { ok: true, value: byKey[0]! };
  const byRepo = keys.filter((key) => repoName(projects[key]!.remote).toLowerCase() === wanted);
  if (byRepo.length === 1) return { ok: true, value: byRepo[0]! };
  const known = keys.length ? `projects of ${space.record.name}: ${keys.join(", ")}` : `${space.record.name} lists no projects in space.yaml`;
  return { ok: false, error: `No project «${asked.trim()}»; ${known}.` };
}

/** A person of the space by key or name (space.yaml `people`). */
export function resolvePerson(space: SpaceEntry, asked: string): Resolved<string> {
  const people = space.sync.plan.space?.people ?? {};
  const key = findPerson(people, asked);
  if (key) return { ok: true, value: key };
  const keys = Object.keys(people);
  const known = keys.length
    ? `people of ${space.record.name}: ${keys.join(", ")}`
    : `${space.record.name} lists no people in space.yaml; add them on the People & labels tab of Paseo Dash`;
  return { ok: false, error: `No person «${asked.trim()}»; ${known}.` };
}

/** How the plan refers to an entity in front matter: a wikilink to its file, as Obsidian writes it. */
export function wikilink(found: FoundEntity | { loaded: LoadedEntity }): string {
  return `[[${basename(found.loaded.path, ".md")}]]`;
}
