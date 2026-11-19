import { type Entity, refId, type Task } from "../../shared/model.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import { editDistance, idForms, type IdForms, otherLayouts, stem, type Token, tokenize, typoBudget } from "./text.ts";

/**
 * One search for every reader: the Tasks tab and the
 * board, God Mode's `tasks` and `task`, the inbox and agents' plan_find. It reads the plan in memory
 * only, never git or the network.
 *
 * A task matches when it is the id asked, or when every word asked is in it (its id only as a whole): as the word, another
 * form of it (логіну → логін), its beginning, a part of a word, or, for a word found nowhere, with a
 * typo. Matches are ranked: the id; the exact title; fewer words held only as a part of a word or
 * with a typo; every word in the title; in its labels, project, feature, release or assignee; in
 * its text; in its links. Then fewer typos, stronger matches, open before done before canceled, and
 * the list order last. With nothing found the query
 * is tried as typed on the other keyboard layout, and then the tasks with most of the words are
 * answered as partial matches.
 *
 * A link or a branch (no spaces, a "/") is looked for as one: a task that owns the PR/MR, link,
 * issue or branch is the only answer; else the tasks that name it in their text, as a whole link.
 */

export const SEARCH_FIELDS = [
  "id",
  "title",
  "labels",
  "project",
  "feature",
  "release",
  "assignee",
  "brief",
  "acceptance",
  "notes",
  "progress_note",
  "pr",
  "links",
  "issue",
  "branch",
] as const;
/** Where a match is. */
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Lower is closer to what the task is: the title, its facets, its text, its links. */
const GROUP: Record<SearchField, number> = {
  id: 0,
  title: 0,
  labels: 1,
  project: 1,
  feature: 1,
  release: 1,
  assignee: 1,
  brief: 2,
  acceptance: 2,
  notes: 2,
  progress_note: 2,
  pr: 3,
  links: 3,
  issue: 3,
  branch: 3,
};

/** The fields that name the task's own things on a forge or in git. */
const REF_FIELDS: ReadonlySet<SearchField> = new Set(["pr", "links", "issue", "branch"]);

/** How a word matched a word of the text, strongest first; 0 is no match. */
export const EXACT = 5;
export const FORM = 4;
export const PREFIX = 3;
export const PART = 2;
export const TYPO = 1;

interface Word {
  norm: string;
  stem: string;
  /** Edits allowed; 0 until the word is found nowhere as typed. */
  typos: number;
  memo: Map<string, number>;
}

export interface Query {
  /** The text as asked, trimmed. */
  text: string;
  /** A link or branch (no spaces, a "/"), normalized; empty for words. */
  ref: string;
  /** With `ref`: the text lowercased, looked for as one piece. */
  refText: string;
  words: Word[];
  ids: IdForms;
  /** The words joined by one space: an exact title reads the same. */
  phrase: string;
}

/** A PR/MR link pasted from a tab may end in /files, /commits, /diffs: the PR/MR is the same. */
const REVIEW_PAGE = /(\/pull\/\d+|\/merge_requests\/\d+)(?:\/.*)?$/;

function normalizeRef(text: string): string {
  let ref = text.trim().toLowerCase();
  // Only a URL has a query or fragment to drop: in "acme/core#38" the "#38" is the PR/issue.
  if (ref.includes("://")) ref = ref.replace(/[?#].*$/, "");
  return ref.replace(/\/+$/, "").replace(REVIEW_PAGE, "$1");
}

const word = (norm: string, typos = 0): Word => ({ norm, stem: stem(norm), typos, memo: new Map() });

/** A piece of a query that may be an id: a key, an optional dash or space, five characters. */
const ID_IN_TEXT = /(?<![\p{L}\p{N}])\p{L}{2,6}[-\s]?[\p{L}\p{N}]{5}(?![\p{L}\p{N}])/gu;

/**
 * The id a query names: the whole query in any form (text.ts idForms), else the first piece of it
 * that is a whole id ("LAC-7K3QX login"). Only a candidate: it matches the entity that has it, and
 * the words are searched as well, so a title that only looks like an id («Laconote» in LAC) is
 * still found by its words.
 */
function idsOf(text: string, spaceKeys: string[]): IdForms {
  const whole = idForms(text, spaceKeys);
  if (whole.full || whole.suffix) return whole;
  for (const piece of text.matchAll(ID_IN_TEXT)) {
    const found = idForms(piece[0], spaceKeys);
    if (found.full) return { full: found.full };
  }
  return {};
}

/**
 * The query, or undefined when it has nothing to look for (no letter or digit): no filter then.
 * `spaceKeys` lets a whole id typed without its dash be read as one (text.ts idForms).
 */
export function parseQuery(text: string, spaceKeys: Iterable<string> = []): Query | undefined {
  const trimmed = text.trim();
  // The Tasks tab mirrors this rule to show which status applies (client/space.tsx).
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return undefined;
  const ref = !/\s/.test(trimmed) && trimmed.includes("/") ? normalizeRef(trimmed) : "";
  const tokens = ref ? [] : tokenize(trimmed);
  const norms = [...new Set(tokens.map((t) => t.norm))];
  const ids = ref ? {} : idsOf(trimmed, [...spaceKeys]);
  if (!ref && !norms.length) return undefined;
  return { text: trimmed, ref, refText: ref ? trimmed.toLowerCase() : "", words: norms.map((n) => word(n)), ids, phrase: tokens.map((t) => t.norm).join(" ") };
}

// ---------------------------------------------------------------- what a task is made of

export interface Field {
  name: SearchField;
  text: string;
  tokens: Token[];
}

const field = (name: SearchField, text: string): Field => ({ name, text, tokens: tokenize(text) });

/**
 * The id as a field: its suffix only, matched only as a whole (strengthOf below). The space key is
 * in every id of a space and the suffix is random, so a beginning or a part of either finds nothing
 * a person meant.
 */
const idField = (id: string): Field => ({ name: "id", text: id, tokens: tokenize(id).slice(-1) });

/** A task's own fields, made once per loaded file: a change replaces the loaded entity. */
const OWN = new WeakMap<LoadedEntity, Map<SearchField, Field>>();

function ownFields(loaded: LoadedEntity): Map<SearchField, Field> {
  const cached = OWN.get(loaded);
  if (cached) return cached;
  const task = loaded.entity as Task;
  const fields = new Map<SearchField, Field>(
    (
      [
        ["title", task.title ?? ""],
        ["labels", (task.labels ?? []).join("\n")],
        ["brief", loaded.brief ?? ""],
        ["acceptance", (loaded.acceptance ?? []).map((line) => line.text).join("\n")],
        ["notes", loaded.notes ?? ""],
        ["progress_note", task.progress_note ?? ""],
        ["pr", task.run_pr ?? ""],
        ["links", (task.links ?? []).join("\n")],
        ["issue", task.issue ?? ""],
        ["branch", [task.run_branch, task.branch].filter(Boolean).join("\n")],
      ] as [SearchField, string][]
    ).map(([name, text]) => [name, field(name, text)]),
  );
  fields.set("id", idField(task.id));
  OWN.set(loaded, fields);
  return fields;
}

/** The repository name of a remote URL: `git@host:acme/core.git` → `core`. */
function repoName(remote: string | undefined): string {
  return (remote ?? "").replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() ?? "";
}

/** A task's fields in the order a tie is broken, with what the plan around it names. */
export function taskFields(loaded: LoadedEntity, plan: Plan | undefined): Field[] {
  const own = ownFields(loaded);
  const task = loaded.entity as Task;
  const titleOf = (id: string | undefined) => (id ? (plan?.entities.get(id)?.entity.title ?? "") : "");
  const feature = plan?.entities.get(refId(task.feature) ?? "")?.entity;
  const release = refId(task.milestone) ?? (feature?.type === "feature" ? refId(feature.milestone) : undefined);
  const project = task.project ?? "";
  const repo = repoName(plan?.space?.projects[project]?.remote);
  const assignee = task.assignee ?? "";
  const person = plan?.space?.people[assignee]?.name ?? "";
  const context: Record<string, string> = {
    project: [project, repo !== project ? repo : ""].filter(Boolean).join("\n"),
    feature: feature?.type === "feature" ? feature.title : "",
    release: titleOf(release),
    assignee: [assignee, person].filter(Boolean).join("\n"),
  };
  return SEARCH_FIELDS.map((name) => own.get(name) ?? field(name, context[name] ?? ""));
}

// ---------------------------------------------------------------- matching

function strengthOf(asked: Word, token: Token): number {
  const known = asked.memo.get(token.norm);
  if (known !== undefined) return known;
  const text = token.norm;
  let strength = 0;
  if (text === asked.norm) strength = EXACT;
  else if (token.stem === asked.stem && asked.stem.length >= 3) strength = FORM;
  else if (text.startsWith(asked.norm) || (asked.stem.length >= 4 && text.startsWith(asked.stem))) strength = PREFIX;
  else if (text.includes(asked.norm)) strength = PART;
  else if (asked.typos && text[0] === asked.norm[0] && editDistance(text, asked.norm, asked.typos) <= asked.typos) strength = TYPO;
  asked.memo.set(text, strength);
  return strength;
}

const QUOTE_BEFORE = 40;
const QUOTE_LENGTH = 140;

/** Up to QUOTE_LENGTH characters around `at`, on one line, with "…" where it was cut. */
export function quoteAround(text: string, at: number, length: number): string {
  const start = Math.max(0, Math.min(at, text.length) - QUOTE_BEFORE);
  const end = Math.min(text.length, start + Math.max(QUOTE_LENGTH, Math.min(at, QUOTE_BEFORE) + length));
  const piece = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
}

export interface Match {
  field: SearchField;
  /** A short piece of that field around the match, on one line. */
  quote: string;
  /** The task's own id, PR/MR, issue, link or branch, rather than words found in its text. */
  exact: boolean;
  /** Each word's strength (0 when absent), in the order asked. */
  strengths: number[];
  /** The ranking key: compared item by item, lower first. */
  key: number[];
}

/** Whether a stored link or branch is the one asked: the same, or, for a link, its tail. */
function sameRef(value: string, ref: string): boolean {
  const own = normalizeRef(value);
  if (!own) return false;
  if (own === ref) return true;
  return own.includes("://") && own.endsWith(`/${ref}`);
}

/** Where `asked` stands in `text` not followed by a letter or digit; -1 when nowhere. */
function wholeAt(text: string, asked: string): number {
  for (let at = text.indexOf(asked); at >= 0; at = text.indexOf(asked, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(text.charAt(at + asked.length))) return at;
  }
  return -1;
}

function matchRef(fields: Field[], query: Query): Match | undefined {
  for (const f of fields) {
    if (!REF_FIELDS.has(f.name)) continue;
    const hit = f.text.split("\n").find((value) => sameRef(value, query.ref));
    if (hit) return { field: f.name, quote: hit.trim(), exact: true, strengths: [], key: [0] };
  }
  // Not its own: the link or branch as written in its text, ending where it ends, so ".../pull/3" is
  // not found in ".../pull/38".
  for (const f of fields) {
    if (REF_FIELDS.has(f.name)) continue;
    const at = wholeAt(f.text.toLowerCase(), query.refText);
    if (at >= 0) return { field: f.name, quote: quoteAround(f.text, at, query.refText.length), exact: false, strengths: [], key: [1] };
  }
  return undefined;
}

/** What a task's status says about its place among equal matches: open, then done, then canceled. */
function stateRank(status: string): number {
  return status === "done" ? 1 : status === "canceled" ? 2 : 0;
}

/**
 * How `fields` match the words of `query`, or undefined with no word and no id. `partial` accepts
 * a task with some of the words; the key then counts the missing ones first. `seen` collects the
 * words this task holds at all, matched or not, so typos widen only the words no task holds.
 *
 * Each word is ranked by one field, never by the strength of one and the place of another: the
 * closest field that holds it whole, as a form or as a beginning; only when none does, the closest
 * that holds it as a part of a word or with a typo. «bug» in a task's labels outranks «Debugger» in
 * another's title.
 */
function matchWords(id: string, status: string, fields: Field[], query: Query, partial: boolean, seen?: Set<number>): Match | undefined {
  const idHit = Boolean((query.ids.full && id === query.ids.full) || (query.ids.suffix && id.endsWith(`-${query.ids.suffix}`)));
  const strengths = query.words.map(() => 0);
  const groups = query.words.map(() => Number.POSITIVE_INFINITY);
  // Per field: each word's strength there and the first place it is, for the quote.
  const held: { field: Field; strengths: number[]; at: (Token | undefined)[] }[] = [];
  for (const f of fields) {
    if (!f.tokens.length) continue;
    const here = { field: f, strengths: query.words.map(() => 0), at: query.words.map((): Token | undefined => undefined) };
    held.push(here);
    query.words.forEach((asked, i) => {
      let strongest = 0;
      let at: Token | undefined;
      for (const token of f.tokens) {
        const s = strengthOf(asked, token);
        // The first place of the strongest match: the quote shows the whole word, not a part of an earlier one.
        if (s > strongest) {
          strongest = s;
          at = token;
        }
      }
      // The id matches only as itself.
      if (f.name === "id" && strongest !== EXACT) strongest = 0;
      if (!strongest) return;
      here.strengths[i] = strongest;
      here.at[i] = at;
      const group = GROUP[f.name];
      // A word whole, as a form or as a beginning anywhere outranks a part of a word or a typo in a
      // closer field; between two of the same kind, the closer field, then the stronger match.
      const weak = (strength: number) => (strength <= PART ? 1 : 0);
      const place = [weak(strongest), group, -strongest];
      const kept = [weak(strengths[i]!), groups[i]!, -strengths[i]!];
      if (!strengths[i] || place[0]! - kept[0]! < 0 || (place[0] === kept[0] && (place[1]! < kept[1]! || (place[1] === kept[1] && place[2]! < kept[2]!)))) {
        groups[i] = group;
        strengths[i] = strongest;
      }
    });
  }
  // The quote's field: the one that holds the most words, each counted only where it is as strong a
  // kind of match as its best (a part of «Blog» does not count where «log» is whole elsewhere); the
  // first such field in SEARCH_FIELDS order on a tie, and the first such word in the order asked.
  const counts = (h: (typeof held)[number]) => h.strengths.filter((s, i) => s > 0 && !(s <= PART && strengths[i]! > PART)).length;
  let best: { field: Field; at: Token } | undefined;
  let most = 0;
  for (const h of held) {
    const count = counts(h);
    if (count <= most) continue;
    const i = h.strengths.findIndex((s, w) => s > 0 && !(s <= PART && strengths[w]! > PART));
    most = count;
    best = { field: h.field, at: h.at[i]! };
  }
  strengths.forEach((s, i) => s && seen?.add(i));
  const found = strengths.filter((s) => s > 0).length;
  if (!idHit && (found === 0 || (!partial && found < query.words.length))) return undefined;
  const title = fields.find((f) => f.name === "title");
  const exactTitle = Boolean(title && query.phrase && title.tokens.map((t) => t.norm).join(" ") === query.phrase);
  const key = [
    idHit ? 0 : 1,
    exactTitle ? 0 : 1,
    query.words.length - found,
    // Words held only as a part of a longer word or with a typo, whatever field they are in.
    strengths.filter((s) => s > 0 && s <= PART).length,
    Math.max(0, ...groups.filter(Number.isFinite)),
    strengths.filter((s) => s === TYPO).length,
    strengths.reduce((sum, s) => sum + (s ? EXACT - s : 0), 0),
    stateRank(status),
  ];
  if (idHit) return { field: "id", quote: id, exact: true, strengths, key };
  return { field: best!.field.name, quote: quoteAround(best!.field.text, best!.at.start, best!.at.end - best!.at.start), exact: false, strengths, key };
}

/** How one task matches the query, or undefined; no plan around it, no typos. */
export function matchOne(loaded: LoadedEntity, plan: Plan | undefined, query: Query): Match | undefined {
  const task = loaded.entity as Task;
  const fields = taskFields(loaded, plan);
  return query.ref ? matchRef(fields, query) : matchWords(task.id, task.status, fields, query, false);
}

// ---------------------------------------------------------------- searching many

export interface Searchable {
  loaded: LoadedEntity;
  plan?: Plan;
}

export interface Hit<T> {
  item: T;
  match: Match;
}

export interface Found<T> {
  /** Best first. */
  hits: Hit<T>[];
  /** No item has every word: these have some of them. */
  partial: boolean;
  /** The query as read on another keyboard layout, when that is what found these. */
  searchedFor: string;
}

export interface SearchOptions<T> {
  /** Answer the items with most of the words when none has them all. */
  partial?: boolean;
  /** The list order, the last tie-breaker: lower first. */
  order?: (item: T) => number;
  /** Fields other than a task's (features and releases are matched by title). */
  fields?: (item: T) => Field[];
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

function run<T extends Searchable>(items: T[], query: Query, options: SearchOptions<T>, partial: boolean): { hits: Hit<T>[]; unfound: Set<number> } {
  const hits: Hit<T>[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    const fields = options.fields ? options.fields(item) : taskFields(item.loaded, item.plan);
    const entity = item.loaded.entity;
    const match = matchWords(entity.id, entity.status, fields, query, partial, seen);
    if (match) hits.push({ item, match });
  }
  return { hits, unfound: new Set(query.words.map((_, i) => i).filter((i) => !seen.has(i))) };
}

/** The same query with typos allowed in the words found nowhere as typed. */
function withTypos(query: Query, unfound: Set<number>): Query | undefined {
  if (![...unfound].some((i) => typoBudget(query.words[i]!.norm))) return undefined;
  return { ...query, words: query.words.map((w, i) => (unfound.has(i) ? word(w.norm, typoBudget(w.norm)) : w)) };
}

function words<T extends Searchable>(items: T[], query: Query, options: SearchOptions<T>, partial: boolean): Hit<T>[] {
  const first = run(items, query, options, partial);
  const typos = first.unfound.size ? withTypos(query, first.unfound) : undefined;
  return typos ? run(items, typos, options, partial).hits : first.hits;
}

const spaceKeysOf = (items: Searchable[]) => new Set(items.map((i) => i.loaded.entity.id.split("-")[0]!));

/**
 * The items `text` finds, best first; undefined when the text has nothing to look for (no letter
 * or digit), which filters nothing.
 */
export function search<T extends Searchable>(items: T[], text: string, options: SearchOptions<T> = {}): Found<T> | undefined {
  const keys = spaceKeysOf(items);
  const query = parseQuery(text, keys);
  if (!query) return undefined;
  const order = options.order ?? (() => 0);
  const sorted = (hits: Hit<T>[]) => hits.sort((a, b) => compare(a.match.key, b.match.key) || order(a.item) - order(b.item));
  if (query.ref) {
    const hits: Hit<T>[] = [];
    for (const item of items) {
      const fields = options.fields ? options.fields(item) : taskFields(item.loaded, item.plan);
      const match = matchRef(fields, query);
      if (match) hits.push({ item, match });
    }
    // A task that owns the asked PR/MR or branch is the answer; mentions of it elsewhere are not.
    const own = hits.filter((h) => h.match.exact);
    return { hits: sorted(own.length ? own : hits), partial: false, searchedFor: "" };
  }
  const full = words(items, query, options, false);
  if (full.length) return { hits: sorted(full), partial: false, searchedFor: "" };
  for (const other of otherLayouts(query.text)) {
    const swapped = parseQuery(other, keys);
    if (!swapped || swapped.ref) continue;
    const found = words(items, swapped, options, false);
    if (found.length) return { hits: sorted(found), partial: false, searchedFor: swapped.text };
  }
  if (options.partial && query.words.length > 1) {
    const some = words(items, query, options, true);
    if (some.length) return { hits: sorted(some), partial: true, searchedFor: "" };
  }
  return { hits: [], partial: false, searchedFor: "" };
}

/**
 * Whether a match may name one task for a read on its own: no word only a part of another word or
 * a beginning shorter than four letters, so «ne» never picks «one».
 */
function namesOnItsOwn(match: Match, query: Query): boolean {
  if (match.key[0] === 0) return true;
  return match.strengths.every((s, i) => s >= FORM || s === TYPO || (s === PREFIX && query.words[i]!.norm.length >= 4));
}

/**
 * The one item a vague name points to: the only hit that names it on its own, or one ranked above
 * every other in its tier (id, exact title, missing and weak words, the words' place, typos), with no hit ranked above it
 * that cannot name a task on its own. Undefined when it is not clear.
 */
export function onlyOne<T extends Searchable>(found: Found<T>, text: string): Hit<T> | undefined {
  if (found.partial || found.searchedFor) return undefined;
  const query = parseQuery(text, spaceKeysOf(found.hits.map((h) => h.item)));
  if (!query || query.ref) return undefined;
  const tier = (h: Hit<T>) => h.match.key.slice(0, 6);
  const able = found.hits.filter((h) => namesOnItsOwn(h.match, query));
  const first = able[0];
  if (!first) return undefined;
  // A hit ranked above it in its tier that cannot name a task on its own (a fragment in a title)
  // still makes the name unclear.
  if (found.hits.some((h) => !able.includes(h) && compare(tier(h), tier(first)) < 0)) return undefined;
  if (able.length === 1) return first;
  return compare(tier(first), tier(able[1]!)) < 0 ? first : undefined;
}

// ---------------------------------------------------------------- features, releases, projects

/** A feature or release matched by its title. */
export const titleFields = (item: Searchable): Field[] => [idField(item.loaded.entity.id), field("title", item.loaded.entity.title)];

export interface Named {
  kind: "feature" | "release" | "project";
  id: string;
  title: string;
  /** A project's space key. */
  space?: string;
}

/**
 * The features, releases and projects whose names have every word of `text`, best first, up to
 * `limit` of each: what a person may have meant when no task is it.
 */
export function namedThings(plans: { key: string; plan: Plan }[], text: string, limit = 3): Named[] {
  const query = parseQuery(text);
  if (!query || query.ref) return [];
  const entities = plans.flatMap(({ plan }) => [...plan.entities.values()].map((loaded) => ({ loaded, plan })));
  const of = (type: Entity["type"]) => entities.filter((e) => e.loaded.entity.type === type);
  const named = (type: Entity["type"], kind: Named["kind"]): Named[] =>
    (search(of(type), text, { fields: titleFields })?.hits ?? []).slice(0, limit).map(({ item }) => ({ kind, id: item.loaded.entity.id, title: item.loaded.entity.title }));
  const projects = plans
    .flatMap(({ key, plan }) =>
      Object.entries(plan.space?.projects ?? {}).map(([project, p]) => ({ key, project, fields: [field("title", project), field("project", [repoName(p.remote), p.group ?? ""].join("\n"))] })),
    )
    .map((p) => ({ p, match: matchWords(p.project, "", p.fields, query, false) }))
    .filter((x) => x.match)
    .sort((a, b) => compare(a.match!.key, b.match!.key))
    .slice(0, limit)
    .map(({ p }) => ({ kind: "project" as const, id: p.project, title: p.project, space: p.key }));
  return [...named("feature", "feature"), ...named("milestone", "release"), ...projects];
}
