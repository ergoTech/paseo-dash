import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { type Feature, type Milestone, refId, type Task } from "../../shared/model.ts";
import { milestoneOf } from "../api/view.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";
import type { Plan } from "../plan/load.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { type FetchLike, LaconoteClient, LaconoteError, type ReleaseContextBody } from "./client.ts";
import type { LaconoteStore } from "./store.ts";

/**
 * The release context (05-architecture.md, Release context): Laconote's delivery meetings show the
 * release, its due date and the days left, and the dashboard knows them. The daemon is behind NAT, so
 * it pushes: for every Laconote project a space's projects are mapped to on this machine, the open
 * milestones those projects work towards go to PUT /api/v1/projects/{id}/release-context, the whole
 * set every time (the contract of Laconote core's docs/plans/delivery-release-context.md).
 *
 * - Only this machine's mapping sends: a space whose projects are not mapped here sends nothing. A
 *   Laconote project takes one sending installation (`sender_id`); a second one is refused with 409,
 *   which is shown, never answered with a DELETE.
 * - It sends committed state (origin as last seen), like the issue mirror, so an edit that never
 *   reaches origin never reaches Laconote.
 * - An open milestone is `planned` or `active`; one with no due date cannot be sent (Laconote needs
 *   the date) and is listed in Settings. A milestone left out of a push is retired by Laconote, so a
 *   milestone marked done or canceled drops out on its own.
 * - A set is sent when it changed, and otherwise once every HEARTBEAT_MS, which keeps Laconote from
 *   treating it as abandoned. A failure waits (1, 2, 4 … 60 minutes) and is shown in Settings.
 */

/** A pass runs this often; it calls Laconote only for sets that changed or are due for a heartbeat. */
const EVERY_MS = 60_000;
/** An unchanged set is sent again after this long. */
const HEARTBEAT_MS = 60 * 60_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Longest release name sent; a longer milestone title is cut. */
const NAME_MAX = 200;
/** Most releases one push carries, the earliest due first. */
const RELEASES_MAX = 50;

/** What `source` says of the sender. */
export const RELEASE_SOURCE = "paseo-dashboard";

/** Laconote project ids as the API gives them (24 hex digits today); anything else is refused. */
export const LACONOTE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const OPEN: ReadonlySet<Milestone["status"]> = new Set(["planned", "active"]);

const pushSchema = z.object({
  space: z.string(),
  /** The API URL the set went to; another URL means it was never sent there. */
  api: z.string(),
  hash: z.string().optional(),
  /** When the set was last accepted. */
  at: z.string().optional(),
  error: z.string().optional(),
  tries: z.number().int().nonnegative().default(0),
  retry_at: z.string().optional(),
});
type PushRecord = z.output<typeof pushSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  /** This installation's id towards Laconote, made once. */
  sender_id: z.string().min(1),
  /** Per space key: its project keys mapped to a Laconote project id. */
  spaces: z.record(z.string(), z.record(z.string(), z.string())),
  /** Per Laconote project id: the last push. */
  pushes: z.record(z.string(), pushSchema),
});
type ReleaseFile = z.output<typeof fileSchema>;

/** This machine's `release-context.json` (0600): the mapping, the sender id and what was sent. */
export class ReleaseStore {
  private readonly path: string;
  private data: ReleaseFile;
  readonly movedAside: string | undefined;

  constructor(dir: string) {
    this.path = join(dir, "release-context.json");
    const read = readJsonFile(this.path, fileSchema, () => ({ version: 1 as const, sender_id: randomUUID(), spaces: {}, pushes: {} }));
    this.data = read.value;
    this.movedAside = read.movedAside;
  }

  get senderId(): string {
    return this.data.sender_id;
  }

  save(): void {
    writeJsonFile(this.path, this.data);
  }

  mapping(space: string): Record<string, string> {
    return Object.hasOwn(this.data.spaces, space) ? { ...this.data.spaces[space] } : {};
  }

  /** The space whose mapping holds the Laconote project, if any. */
  spaceOf(laconote: string): string | undefined {
    return Object.entries(this.data.spaces).find(([, mapping]) => Object.values(mapping).includes(laconote))?.[0];
  }

  /**
   * Maps a project of a space to a Laconote project, or unmaps it (""). A Laconote project no mapping
   * names any more loses its push record. Memory changes only after the file is written.
   */
  setMapping(space: string, project: string, laconote: string): void {
    const mapping = this.mapping(space);
    if (laconote) mapping[project] = laconote;
    else delete mapping[project];
    const spaces = { ...this.data.spaces, [space]: mapping };
    if (!Object.keys(mapping).length) delete spaces[space];
    const named = new Set(Object.values(spaces).flatMap((m) => Object.values(m)));
    const pushes = Object.fromEntries(Object.entries(this.data.pushes).filter(([id]) => named.has(id)));
    const next = { ...this.data, spaces, pushes };
    writeJsonFile(this.path, next);
    this.data = next;
  }

  /** Drops a disconnected space's mapping and push records, so its Laconote projects are free again. */
  forgetSpace(space: string): void {
    if (!Object.hasOwn(this.data.spaces, space)) return;
    const spaces = { ...this.data.spaces };
    delete spaces[space];
    const named = new Set(Object.values(spaces).flatMap((m) => Object.values(m)));
    const pushes = Object.fromEntries(Object.entries(this.data.pushes).filter(([id]) => named.has(id)));
    const next = { ...this.data, spaces, pushes };
    writeJsonFile(this.path, next);
    this.data = next;
  }

  /** The next try of every set goes on the next pass: the key or the server changed. */
  retryNow(): void {
    if (!Object.values(this.data.pushes).some((r) => r.retry_at || r.tries)) return;
    const pushes = Object.fromEntries(Object.entries(this.data.pushes).map(([id, { retry_at: _, ...r }]) => [id, { ...r, tries: 0 }]));
    const next = { ...this.data, pushes };
    writeJsonFile(this.path, next);
    this.data = next;
  }

  push(laconote: string): PushRecord | undefined {
    return Object.hasOwn(this.data.pushes, laconote) ? this.data.pushes[laconote] : undefined;
  }

  /** A push that ends after its project was unmapped leaves no record. */
  setPush(laconote: string, record: PushRecord): void {
    if (!this.spaceOf(laconote)) return;
    this.data.pushes[laconote] = record;
    this.save();
  }
}

export interface Release {
  /** The milestone's id. */
  id: string;
  name: string;
  /** YYYY-MM-DD. */
  due: string;
  /** Done tasks of the milestone in percent; undefined while it has none counted. */
  progress: number | undefined;
}

export interface ReleaseSet {
  /** The space's project keys mapped to this Laconote project. */
  projects: string[];
  releases: Release[];
  /** Open milestones of these projects that have no due date, so are not sent. */
  undated: { id: string; title: string }[];
}

/** A due date as Laconote takes it, or undefined. */
export function dueDate(due: string | undefined): string | undefined {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(due ?? "");
  if (!day) return undefined;
  const parsed = new Date(`${day[0]}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === day[0] ? day[0] : undefined;
}

/** A milestone title as a release name: one line, no control characters, at most NAME_MAX long. */
export function releaseName(title: string): string {
  // Control and format characters (zero-width, bidi overrides) go; the cut counts code points, so it
  // never splits a surrogate pair.
  const line = [...title.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim()];
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1).join("").trimEnd()}…` : line.join("");
}

/**
 * The release set of every Laconote project the mapping names; pure. A milestone belongs to a set when
 * an accepted task of the milestone (not a draft, not canceled) is in one of the set's projects, or a
 * feature of the milestone lists one of them. Its progress counts all of its accepted tasks, as the
 * dashboard's own roadmap does. A Laconote project with nothing open gets an empty set, which retires
 * whatever was sent before.
 */
export function releaseSets(plan: Plan, mapping: Record<string, string>): Map<string, ReleaseSet> {
  const entities = [...plan.entities.values()].map((l) => l.entity);
  const milestones = entities.filter((e): e is Milestone => e.type === "milestone" && OPEN.has(e.status));
  const tasks = entities.filter((e): e is Task => e.type === "task" && e.status !== "canceled" && e.status !== "inbox");
  const features = entities.filter((e): e is Feature => e.type === "feature" && e.status !== "canceled");
  const known = new Set(Object.keys(plan.space?.projects ?? {}));
  const sets = new Map<string, ReleaseSet>();
  for (const [project, laconote] of Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) {
    if (!known.has(project)) continue;
    const set = sets.get(laconote) ?? { projects: [], releases: [], undated: [] };
    set.projects.push(project);
    sets.set(laconote, set);
  }
  for (const set of sets.values()) {
    const mine = new Set(set.projects);
    for (const milestone of milestones) {
      const own = tasks.filter((t) => milestoneOf(plan, t) === milestone.id);
      const touches =
        own.some((t) => t.project && mine.has(t.project)) ||
        features.some((f) => refId(f.milestone) === milestone.id && f.projects.some((p) => mine.has(p)));
      if (!touches) continue;
      const due = dueDate(milestone.due);
      if (!due) {
        set.undated.push({ id: milestone.id, title: milestone.title });
        continue;
      }
      const done = own.filter((t) => t.status === "done").length;
      set.releases.push({ id: milestone.id, name: releaseName(milestone.title) || milestone.id, due, progress: own.length ? Math.round((100 * done) / own.length) : undefined });
    }
    set.releases.sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
    set.releases = set.releases.slice(0, RELEASES_MAX);
  }
  return sets;
}

/** The request body of a set. */
export function releaseBody(senderId: string, set: ReleaseSet): ReleaseContextBody {
  return {
    sender_id: senderId,
    source: RELEASE_SOURCE,
    releases: set.releases.map((r) => ({ external_id: r.id, name: r.name, due_date: r.due, ...(r.progress === undefined ? {} : { progress: r.progress }) })),
  };
}

export function bodyHash(body: ReleaseContextBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Laconote's refusal in words a person can act on. */
export function pushError(error: unknown): string {
  if (!(error instanceof LaconoteError)) return String((error as Error)?.message ?? error);
  if (error.code === "RELEASE_CONTEXT_OWNED_BY_OTHER" || error.status === 409) {
    return "Another installation sends this project's releases (Laconote answered 409): only one machine should send them. Laconote frees the project once that one stops for long enough; if it was this machine before a reinstall, reset the project's release context in Laconote.";
  }
  if (error.code === "insufficient_scope") return "The key may not write release context: give this machine a key with the release:write scope.";
  if (error.status === 404) return `${error.message}. The release context may not be available on this Laconote server yet.`;
  return error.message;
}

export interface ReleaseSpace {
  key: string;
  sync: SpaceSync;
}

export interface ReleasePusherOptions {
  spaces: () => ReleaseSpace[];
  store: () => ReleaseStore | undefined;
  laconote: () => LaconoteStore | undefined;
  fetch?: FetchLike;
  now?: () => Date;
  everyMs?: number;
  log?: (message: string) => void;
}

export interface ReleaseStatus {
  laconote: string;
  projects: string[];
  releases: Release[];
  undated: { id: string; title: string }[];
  /** When Laconote last accepted the set; "" when never. */
  sent_at: string;
  /** Whether the set as it is now still has to be sent. */
  waiting: boolean;
  error: string;
}

export class ReleasePusher {
  private readonly options: ReleasePusherOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  constructor(options: ReleasePusherOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? (() => new Date()))().getTime();
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass().catch(() => undefined), this.options.everyMs ?? EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every space mapped here; one asked for while one runs follows it. */
  pass(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.passOnce();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Whether the set must go now: never sent to this server, changed, or due for its heartbeat. */
  private due(record: PushRecord | undefined, api: string, hash: string): boolean {
    if (!record || record.api !== api || record.hash !== hash || !record.at) return true;
    return this.now() - Date.parse(record.at) >= HEARTBEAT_MS;
  }

  private async passOnce(): Promise<void> {
    const store = this.options.store();
    const laconote = this.options.laconote();
    const key = laconote?.key();
    if (!store || !laconote || !key) return;
    const client = new LaconoteClient(laconote.apiUrl, key, this.options.fetch);
    for (const space of this.options.spaces()) {
      const mapping = store.mapping(space.key);
      if (!Object.keys(mapping).length) continue;
      for (const [id, set] of releaseSets(space.sync.committed, mapping)) {
        if (this.stopped) return;
        const record = store.push(id);
        const body = releaseBody(store.senderId, set);
        const hash = bodyHash(body);
        if (!this.due(record, laconote.apiUrl, hash)) {
          // Back to what Laconote holds: an earlier failure no longer matters.
          if (record?.error) store.setPush(id, { space: record.space, api: record.api, hash: record.hash, at: record.at, tries: 0 });
          continue;
        }
        if (record?.retry_at && record.api === laconote.apiUrl && Date.parse(record.retry_at) > this.now()) continue;
        try {
          await client.putReleaseContext(id, body);
        } catch (error) {
          const tries = (record?.api === laconote.apiUrl ? record.tries : 0) + 1;
          const message = pushError(error);
          store.setPush(id, {
            ...(record?.api === laconote.apiUrl ? record : {}),
            space: space.key,
            api: laconote.apiUrl,
            tries,
            error: message,
            retry_at: new Date(this.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (tries - 1))).toISOString(),
          });
          this.options.log?.(`release context of ${space.key} to Laconote project ${id}: ${message}`);
          // Laconote did not answer: the other projects would wait for it the same way.
          if (error instanceof LaconoteError && error.status === 0) return;
          continue;
        }
        store.setPush(id, { space: space.key, api: laconote.apiUrl, hash, at: new Date(this.now()).toISOString(), tries: 0 });
      }
    }
  }

  /** What Settings shows of one space; calls nothing. */
  status(space: ReleaseSpace): ReleaseStatus[] {
    const store = this.options.store();
    if (!store) return [];
    const api = this.options.laconote()?.apiUrl ?? "";
    return [...releaseSets(space.sync.committed, store.mapping(space.key))].map(([id, set]) => {
      const record = store.push(id);
      const current = record?.api === api ? record : undefined;
      const hash = bodyHash(releaseBody(store.senderId, set));
      return {
        laconote: id,
        projects: set.projects,
        releases: set.releases,
        undated: set.undated,
        sent_at: current?.at ?? "",
        waiting: !current || current.hash !== hash,
        error: current?.error ?? "",
      };
    });
  }
}
