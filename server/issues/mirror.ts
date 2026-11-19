import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { findPerson } from "../../shared/labels.ts";
import { issueKey } from "../../shared/issues.ts";
import type { Task, TaskStatus } from "../../shared/model.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";
import { opaqueId } from "../plan/ids.ts";
import type { Plan } from "../plan/load.ts";
import type { Operation, Outcome } from "../sync/ops.ts";
import { CLOSED_REASON, type SpaceSync } from "../sync/space-sync.ts";
import type { IssueContent, IssueWriter, WriteResult } from "./forge-write.ts";
import { type ProjectRepo, projectRepo } from "./link.ts";

/**
 * The issue mirror (09-forge-issues.md, option c, the mirror): a one-way copy of the plan's tasks as
 * forge issues, so people outside Paseo see them. The plan stays the only source; nothing on the
 * forge is read back into it.
 *
 * - One machine writes: a space is mirrored only on a machine where its "Mirror issues" switch is on
 *   (off by default, this machine's `mirror.json`); every other machine writes nothing.
 * - It writes from committed state (`SpaceSync.committed`, origin as last seen), like ROADMAP.md, so
 *   an edit that never reaches origin never reaches the forge.
 * - A task not done or canceled (todo, in review or in progress; never an inbox draft) with a project
 *   and no `issue` gets an issue in its project's repository. The URL goes back to the task through a
 *   `set` operation, and `mirror.json` remembers that the mirror made it.
 * - It writes only issues it made. A task whose `issue` was linked or imported is never edited,
 *   closed or reopened here: the forge's closing keyword handles those.
 * - Title, brief (with the task id and a note that the plan is the source), labels, assignee (the
 *   person's forge login from `people`) and state (done closes as completed, canceled as not planned,
 *   reopening the task reopens it) are written whole whenever the task's mirrored content changes, so
 *   edits made on the forge are overwritten by the task's next change. Comments are left alone.
 * - Writes are queued in the sense that a pass retries whatever is not written yet: a failure waits
 *   (1, 2, 4 … 60 minutes) and is shown in Settings; the forge's rate limit pauses the host.
 */

/** A pass runs this often; it calls the forge only for tasks whose mirrored content changed. */
const EVERY_MS = 60_000;
/** Writes per forge host, under GitHub's 80 a minute and 500 an hour for content creation [H4]. */
const PER_MINUTE = 20;
const PER_HOUR = 300;
/** Between two writes, as GitHub asks of content-creating requests [H5]. */
const SPACING_MS = 1_000;
/** How long a host the forge rate-limited gets nothing more. */
const RATE_PAUSE_MS = 15 * 60_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** How long the answer to "may this login write to the repository?" is kept. */
const ACCESS_FRESH_MS = 60 * 60_000;
/** How long Settings do not ask again about a repository whose access could not be read (offline). */
const ACCESS_RETRY_MS = 5 * 60_000;
/** GitHub takes up to 256 characters in a title and GitLab 255. */
const TITLE_MAX = 255;
/** A brief longer than this is cut; GitHub takes 65,536 characters in an issue body. */
const BRIEF_MAX = 50_000;
/** Labels written to one issue. */
const LABELS_MAX = 20;

/** Statuses whose task gets an issue made. Done and canceled tasks get none afterwards. */
const MIRRORED: ReadonlySet<TaskStatus> = new Set(["todo", "in_progress", "review"]);

/**
 * - `creating`: the create was sent and its answer is not known; the next try looks for the issue
 *   before creating another.
 * - `created`: the issue exists; its URL is on its way to the task.
 * - `linked`: origin's task carries it; the mirror keeps it equal to the task.
 * - `orphan`: the task did not take it (another issue landed first, or the task is gone); closed once.
 * - `released`: the task carried it and no longer does; never written again.
 */
const STATES = ["creating", "created", "linked", "orphan", "released"] as const;

const recordSchema = z.object({
  space: z.string(),
  task: z.string(),
  state: z.enum(STATES),
  /** The repository the create went to. */
  forge: z.enum(["github", "gitlab"]),
  host: z.string(),
  repo: z.string(),
  url: z.string().optional(),
  /** When the state was entered (for `creating`: when the create was sent). */
  at: z.string(),
  /** The content last written, hashed. */
  hash: z.string().optional(),
  /** An orphan that was closed. */
  closed: z.boolean().optional(),
  /** The last failure, until a write succeeds. */
  error: z.string().optional(),
  tries: z.number().int().nonnegative().default(0),
  retry_at: z.string().optional(),
});
export type MirrorRecord = z.output<typeof recordSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  /** The switch per space key: on only on the one machine that writes. */
  spaces: z.record(z.string(), z.object({ on: z.boolean(), at: z.string() })),
  issues: z.array(recordSchema),
});

/** This machine's `mirror.json` (0600): the switch per space and every issue the mirror made. */
export class MirrorStore {
  private readonly path: string;
  private data: z.output<typeof fileSchema>;
  readonly movedAside: string | undefined;

  constructor(dir: string) {
    this.path = join(dir, "mirror.json");
    const read = readJsonFile(this.path, fileSchema, () => ({ version: 1 as const, spaces: {}, issues: [] }));
    this.data = read.value;
    this.movedAside = read.movedAside;
  }

  save(): void {
    writeJsonFile(this.path, this.data);
  }

  on(space: string): boolean {
    return this.data.spaces[space]?.on === true;
  }

  /** Memory changes only after the file is written. */
  setOn(space: string, on: boolean, at: string): void {
    const next = { ...this.data, spaces: { ...this.data.spaces, [space]: { on, at } } };
    writeJsonFile(this.path, next);
    this.data = next;
  }

  records(space: string): MirrorRecord[] {
    return this.data.issues.filter((r) => r.space === space);
  }

  /** The record of a task the mirror is making or made an issue for (not an orphan or a released one). */
  current(space: string, task: string): MirrorRecord | undefined {
    return this.data.issues.find((r) => r.space === space && r.task === task && r.state !== "orphan" && r.state !== "released");
  }

  /** Whether the mirror ever made an issue for the task. */
  any(space: string, task: string): boolean {
    return this.data.issues.some((r) => r.space === space && r.task === task);
  }

  add(record: MirrorRecord): void {
    this.data.issues.push(record);
    this.save();
  }

  remove(record: MirrorRecord): void {
    this.data.issues = this.data.issues.filter((r) => r !== record);
    this.save();
  }
}

/** A task the mirror makes an issue for: accepted, open, in a project, with no issue yet. */
function wantsIssue(task: Task): boolean {
  return MIRRORED.has(task.status) && !task.issue && Boolean(task.project);
}

/** The person's login on the forge of the repository: GitHub's, or GitLab's for that web host. */
function forgeLogin(plan: Pick<Plan, "space">, task: Pick<Task, "assignee">, repo: ProjectRepo): string {
  const people = plan.space?.people ?? {};
  const key = task.assignee ? findPerson(people, task.assignee) : undefined;
  const person = key ? people[key] : undefined;
  if (!person) return "";
  return (repo.forge === "github" ? person.github : person.gitlab[repo.host]) ?? "";
}

/** The body's last line, which finds an issue the mirror made should a create's answer be lost. */
export function mirrorMarker(space: string, task: string): string {
  return `<!-- paseo-dashboard mirror ${space}/${task} -->`;
}

/** Marker lines a brief may carry (an imported mirrored issue quotes one): never copied into a body. */
const MARKER_LINE = /^.*<!--\s*paseo-dashboard mirror\b.*$/gim;

/** What the issue of a task shows; pure. */
export function issueContent(plan: Pick<Plan, "space">, task: Task, brief: string, repo: ProjectRepo): IssueContent {
  const space = plan.space;
  const own = brief.replace(MARKER_LINE, "").trim();
  const text = own ? (own.length > BRIEF_MAX ? `${own.slice(0, BRIEF_MAX).trimEnd()}\n\n(The brief goes on in the plan.)` : own) : "(No brief yet.)";
  const where = space ? `${space.name} (${space.key})` : "the plan";
  const body = [
    text,
    "",
    "---",
    "",
    `Task ${task.id} of ${where}. The plan is the source of this issue: it is mirrored one way from the plan, so edits made here are overwritten by the task's next change. Comments are left alone.`,
    "",
    mirrorMarker(space?.key ?? "", task.id),
  ].join("\n");
  const title = task.title.replace(/\s+/g, " ").trim();
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
    body,
    labels: task.labels.slice(0, LABELS_MAX),
    assignee: forgeLogin(plan, task, repo),
    state: task.status === "done" ? "completed" : task.status === "canceled" ? "not_planned" : "open",
  };
}

export function contentHash(content: IssueContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export interface MirrorSpace {
  key: string;
  sync: SpaceSync;
}

export interface IssueMirrorOptions {
  spaces: () => MirrorSpace[];
  store: () => MirrorStore | undefined;
  writer: IssueWriter;
  now?: () => Date;
  everyMs?: number;
  spacingMs?: number;
  log?: (message: string) => void;
}

export interface MirrorStatus {
  /** Issues the mirror keeps equal to their task. */
  mirrored: number;
  /** Tasks whose issue is not made or not up to date yet. */
  waiting: number;
  problems: { task: string; error: string }[];
  /** Hosts paused by the forge's rate limit, with until when. */
  paused: string[];
  /** Repositories (`host/repo`) this login may not write to: their tasks get no issue. */
  read_only: string[];
}

export class IssueMirror {
  private readonly options: IssueMirrorOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  /** Write times per host in the last hour, and hosts paused until a time. */
  private readonly writes = new Map<string, number[]>();
  private readonly pausedUntil = new Map<string, number>();
  /** Hosts a call failed on in this pass: offline, the rest would fail the same way. */
  private readonly failedHosts = new Set<string>();
  /** Whether this machine's forge login may write to a repository (`host/repo`), and when that was read. */
  private readonly access = new Map<string, { at: number; write: boolean }>();
  /** When Settings last failed to read a repository's access: not asked again for ACCESS_RETRY_MS. */
  private readonly accessFailed = new Map<string, number>();

  constructor(options: IssueMirrorOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? (() => new Date()))().getTime();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
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

  /** One pass over every space whose switch is on here; one asked for while one runs follows it. */
  pass(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          this.failedHosts.clear();
          const store = this.options.store();
          if (!store) return;
          for (const space of this.options.spaces()) {
            if (this.stopped) return;
            if (!store.on(space.key)) continue;
            await this.passSpace(store, space).catch((error: unknown) => this.options.log?.(`issue mirror of ${space.key}: ${(error as Error).message}`));
          }
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** A host a call failed on in this pass, or that the forge asked to slow down: no call goes there. */
  private held(host: string): boolean {
    return this.failedHosts.has(host) || (this.pausedUntil.get(host) ?? 0) > this.now();
  }

  /** Whether a write to the host may go now: not held, and within the minute's and the hour's budget. */
  private mayWrite(host: string): boolean {
    const now = this.now();
    if (this.held(host)) return false;
    const recent = (this.writes.get(host) ?? []).filter((t) => now - t < 3_600_000);
    this.writes.set(host, recent);
    return recent.length < PER_HOUR && recent.filter((t) => now - t < 60_000).length < PER_MINUTE;
  }

  /** Spaces writes out, and counts one against the host's budget. */
  private async spend(host: string): Promise<void> {
    const recent = this.writes.get(host) ?? [];
    if (recent.length) await new Promise((resolve) => setTimeout(resolve, this.options.spacingMs ?? SPACING_MS));
    recent.push(this.now());
    this.writes.set(host, recent);
  }

  /** A failed write: the record waits longer each time; a rate limit pauses the whole host. */
  private failed(store: MirrorStore, record: MirrorRecord, host: string, result: Extract<WriteResult<unknown>, { ok: false }>): void {
    if (result.kind === "rate") this.pausedUntil.set(host, this.now() + RATE_PAUSE_MS);
    this.failedHosts.add(host);
    record.tries += 1;
    record.error = result.error;
    record.retry_at = new Date(this.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (record.tries - 1))).toISOString();
    store.save();
    this.options.log?.(`issue mirror: ${record.task}: ${result.error}`);
  }

  private succeeded(record: MirrorRecord): void {
    record.tries = 0;
    delete record.error;
    delete record.retry_at;
  }

  private waits(record: MirrorRecord): boolean {
    return Boolean(record.retry_at && Date.parse(record.retry_at) > this.now());
  }

  /**
   * Writes the content, and once labels or assignee are refused (an unknown label or login), the
   * content without them, so the issue still follows its task.
   */
  private async write<T>(host: string, send: (bare: boolean) => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
    await this.spend(host);
    const first = await send(false);
    if (first.ok || first.kind !== "invalid" || !this.mayWrite(host)) return first;
    await this.spend(host);
    const bare = await send(true);
    return bare.ok ? bare : first;
  }

  private async passSpace(store: MirrorStore, space: MirrorSpace): Promise<void> {
    const committed = space.sync.committed;
    const local = space.sync.plan;
    const task = (id: string) => {
      const entity = committed.entities.get(id)?.entity;
      return entity?.type === "task" ? entity : undefined;
    };

    // A task file that does not read (a hand edit, a duplicate id) is missing from the plan, not
    // gone: its records wait until it reads again.
    /** Links to write back, recorded together at the end: one plan commit per pass, not per issue. */
    const backs: MirrorRecord[] = [];
    const unreadable = committed.problems.some((p) => p.path.startsWith("tasks/"));
    const gone = (id: string) => !unreadable && !committed.duplicates.has(id);

    // Issues the mirror made: follow what origin's task carries.
    for (const record of store.records(space.key)) {
      if (this.stopped) return;
      const current = task(record.task);
      if (!current && !gone(record.task)) continue;
      const carried = current ? issueKey(current.issue) : undefined;
      const own = record.url ? issueKey(record.url) : undefined;
      if (record.state === "linked" && !current) continue;
      if (record.state === "created" || record.state === "linked") {
        if (carried && carried === own) {
          if (record.state === "created") {
            record.state = "linked";
            record.at = this.stamp();
            store.save();
          }
          await this.follow(store, record, current!, committed);
        } else if (record.state === "linked") {
          // A person took the link off or put another one on: the issue is theirs now.
          record.state = "released";
          record.at = this.stamp();
          this.succeeded(record);
          store.save();
        } else if (!current || carried) {
          this.orphan(store, record);
        } else {
          backs.push(record);
        }
      }
      // A create whose answer was lost, for a task that no longer wants an issue.
      if (record.state === "creating" && !(current && wantsIssue(current))) await this.settleCreating(store, record);
      if (record.state === "orphan" && !record.closed) await this.closeOrphan(store, record, current);
    }

    // Tasks without an issue: make one, unless the mirror already did (or tried) for that task.
    for (const loaded of [...committed.entities.values()]) {
      if (this.stopped) return;
      const entity = loaded.entity;
      if (entity.type !== "task" || !wantsIssue(entity)) continue;
      const pending = store.current(space.key, entity.id);
      if (pending ? pending.state !== "creating" : store.any(space.key, entity.id)) continue;
      // Gone or changed locally already (a link on its way to origin): the next pass sees origin.
      const now = local.entities.get(entity.id)?.entity;
      if (now?.type !== "task" || now.issue) continue;
      const repo = projectRepoOf(committed, entity.project!);
      if (!repo) continue;
      const made = await this.create(store, space, entity, loaded.brief, repo, pending);
      if (made) backs.push(made);
    }
    await this.writeBack(store, space, backs);
  }

  /**
   * Whether this machine's forge login may write to the repository, kept for an hour; a failed read
   * is a failed call like any other, and is not kept. Anyone may open an issue in a public
   * repository: without this, a space's project that is someone else's public repository would get
   * the space's briefs as public issues.
   */
  private async writable(repo: ProjectRepo): Promise<WriteResult<boolean>> {
    const key = `${repo.host}/${repo.repo}`;
    const known = this.access.get(key);
    if (known && this.now() - known.at < ACCESS_FRESH_MS) return { ok: true, value: known.write };
    // One failing call per host and pass, as for writes: offline, the others would fail the same way.
    if (this.held(repo.host)) return { ok: false, kind: "failed", error: `${repo.host} did not answer` };
    const read = await this.options.writer.access(repo);
    if (!read.ok) {
      this.failedHosts.add(repo.host);
      return read;
    }
    this.access.set(key, { at: this.now(), write: read.value.write });
    return { ok: true, value: read.value.write };
  }

  /**
   * Reads, for Settings, whether this login may write to the repositories of the space's records the
   * mirror has not settled (an issue not made yet, or made before), where that is not known or is an
   * hour old. A pass asks only when it tries a record, and a record that failed waits up to an hour
   * before it is tried again: without this, a repository found read-only would show as such only then.
   * A failed read holds no host back, as Settings' reads are not the pass's; that repository is not
   * asked again by Settings for ACCESS_RETRY_MS, so an offline forge does not slow every poll.
   */
  async learnAccess(space: MirrorSpace): Promise<void> {
    const repos = new Map<string, ProjectRepo>();
    for (const record of this.options.store()?.records(space.key) ?? []) {
      if (record.state !== "creating" && record.state !== "linked" && record.state !== "orphan") continue;
      const key = `${record.host}/${record.repo}`;
      const known = this.access.get(key);
      const failed = this.accessFailed.get(key);
      if (failed !== undefined && this.now() - failed < ACCESS_RETRY_MS) continue;
      if (!known || this.now() - known.at >= ACCESS_FRESH_MS) repos.set(key, { forge: record.forge, host: record.host, repo: record.repo });
    }
    await Promise.all(
      [...repos].map(async ([key, repo]) => {
        const read = await this.options.writer.access(repo);
        if (read.ok) {
          this.access.set(key, { at: this.now(), write: read.value.write });
          this.accessFailed.delete(key);
        } else this.accessFailed.set(key, this.now());
      }),
    );
  }

  /**
   * Whether an issue the mirror made may be written now: not when this login may no longer write to
   * its repository (the issue stays as it is), and a failed read is that record's failed call.
   */
  private async mayWriteTo(store: MirrorStore, record: MirrorRecord): Promise<boolean> {
    const access = await this.writable({ forge: record.forge, host: record.host, repo: record.repo });
    if (!access.ok) {
      this.failed(store, record, record.host, access);
      return false;
    }
    return access.value;
  }

  /** A repository the mirror writes nothing to, because this login may not write there. */
  private readOnly(repo: Pick<ProjectRepo, "host" | "repo">): boolean {
    return this.access.get(`${repo.host}/${repo.repo}`)?.write === false;
  }

  /** Makes the task's issue; the record whose link is to be written back, if one was made or found. */
  private async create(store: MirrorStore, space: MirrorSpace, task: Task, brief: string, repo: ProjectRepo, pending: MirrorRecord | undefined): Promise<MirrorRecord | undefined> {
    // A waiting record waits first: its repository's access is read when it is tried again, so an
    // offline pass spends its one failing call on a task not tried yet.
    if (pending && this.waits(pending)) return undefined;
    if (!this.mayWrite(repo.host)) return undefined;
    const access = await this.writable(repo);
    if (access.ok && !access.value) return undefined;
    const marker = mirrorMarker(space.key, task.id);
    if (!access.ok) {
      // The forge did not answer: shown on the task and tried again later, as a failed create is.
      const failing = pending ?? { space: space.key, task: task.id, state: "creating" as const, forge: repo.forge, host: repo.host, repo: repo.repo, at: this.stamp(), tries: 0 };
      if (!pending) store.add(failing);
      this.failed(store, failing, repo.host, access);
      return undefined;
    }
    let record = pending;
    if (record) {
      // An earlier create's answer was lost: it may have made the issue.
      const found = await this.options.writer.find({ forge: record.forge, host: record.host, repo: record.repo }, marker, new Date(Date.parse(record.at) - 60_000).toISOString());
      if (!found.ok) {
        this.failed(store, record, record.host, found);
        return undefined;
      }
      if (found.value) {
        Object.assign(record, { state: "created", url: found.value, at: this.stamp() });
        this.succeeded(record);
        store.save();
        return record;
      }
      Object.assign(record, { forge: repo.forge, host: repo.host, repo: repo.repo, at: this.stamp() });
      store.save();
    } else {
      record = { space: space.key, task: task.id, state: "creating", forge: repo.forge, host: repo.host, repo: repo.repo, at: this.stamp(), tries: 0 };
      // Remembered before the forge hears of it, so a lost answer is looked for, not created again.
      store.add(record);
    }
    const content = issueContent(space.sync.committed, task, brief, repo);
    const made = await this.write(repo.host, (bare) => this.options.writer.create(repo, content, bare));
    if (!made.ok) {
      this.failed(store, record, repo.host, made);
      return undefined;
    }
    Object.assign(record, { state: "created", url: made.value.url, at: this.stamp(), hash: contentHash(content) });
    this.succeeded(record);
    store.save();
    return record;
  }

  /** Looks for the issue a lost create may have made: one found is left over and closed; none, and the record goes. */
  private async settleCreating(store: MirrorStore, record: MirrorRecord): Promise<void> {
    if (this.waits(record) || this.held(record.host)) return;
    const found = await this.options.writer.find({ forge: record.forge, host: record.host, repo: record.repo }, mirrorMarker(record.space, record.task), new Date(Date.parse(record.at) - 60_000).toISOString());
    if (!found.ok) return this.failed(store, record, record.host, found);
    this.succeeded(record);
    if (found.value) {
      record.url = found.value;
      this.orphan(store, record);
      return;
    }
    // Nothing was made: the task is as if never tried, and gets an issue if it wants one again.
    store.remove(record);
  }

  /**
   * Puts the issues' URLs on their tasks through the plan, in one record call, leaving out those whose
   * operation is on its way already. A link refused because the task took another issue or is gone
   * leaves this one over; a space disconnected meanwhile leaves the record as it is.
   */
  private async writeBack(store: MirrorStore, space: MirrorSpace, records: MirrorRecord[]): Promise<void> {
    const queued = (record: MirrorRecord) =>
      space.sync.journalEntries.some(({ op }) => op.kind === "set" && op.id === record.task && op.field === "issue" && op.value === record.url);
    const sends = records.filter((record) => record.url && !queued(record)).map((record) => ({
      record,
      op: { op_id: opaqueId("op"), kind: "set", id: record.task, field: "issue", value: record.url, expect: null } satisfies Operation,
    }));
    if (!sends.length) return;
    let outcomes: Map<string, Outcome>;
    try {
      outcomes = await space.sync.record(sends.map((s) => s.op)).outcomes;
    } catch (error) {
      this.options.log?.(`issue mirror: links of ${space.key} were not written (${(error as Error).message})`);
      return;
    }
    for (const { record, op } of sends) {
      const outcome = outcomes.get(op.op_id);
      if (outcome?.status === "refused" && outcome.reason !== CLOSED_REASON) this.orphan(store, record);
    }
  }

  private orphan(store: MirrorStore, record: MirrorRecord): void {
    record.state = "orphan";
    record.at = this.stamp();
    store.save();
  }

  /** Closes an issue the task never took, saying why, once. */
  private async closeOrphan(store: MirrorStore, record: MirrorRecord, task: Task | undefined): Promise<void> {
    if (!record.url || this.waits(record) || !this.mayWrite(record.host)) return;
    if (!(await this.mayWriteTo(store, record))) return;
    const why = task?.issue
      ? `The plan's task ${record.task} stands for ${task.issue}, so this issue was left over; the issue mirror closed it.`
      : `The plan no longer has task ${record.task}, so this issue was left over; the issue mirror closed it.`;
    await this.spend(record.host);
    const closed = await this.options.writer.close(record.url, why);
    if (!closed.ok) return this.failed(store, record, record.host, closed);
    record.closed = true;
    this.succeeded(record);
    store.save();
  }

  /** Writes a linked issue whose task's mirrored content changed since the last write. */
  private async follow(store: MirrorStore, record: MirrorRecord, task: Task, committed: Plan): Promise<void> {
    // A draft again (by hand): the issue stays as it was.
    if (task.status === "inbox") return;
    const repo: ProjectRepo = { forge: record.forge, host: record.host, repo: record.repo };
    const content = issueContent(committed, task, committed.entities.get(task.id)?.brief ?? "", repo);
    const hash = contentHash(content);
    if (hash === record.hash) {
      // Back to what the issue shows: nothing to write, and an earlier failure no longer matters.
      if (record.error) {
        this.succeeded(record);
        store.save();
      }
      return;
    }
    if (this.waits(record) || !this.mayWrite(record.host)) return;
    if (!(await this.mayWriteTo(store, record))) return;
    const written = await this.write(record.host, (bare) => this.options.writer.update(record.url!, content, bare));
    if (!written.ok) return this.failed(store, record, record.host, written);
    record.hash = hash;
    this.succeeded(record);
    store.save();
  }

  /** What Settings shows of one space; reads nothing from the forge. */
  status(space: MirrorSpace): MirrorStatus {
    const store = this.options.store();
    const records = store?.records(space.key) ?? [];
    const committed = space.sync.committed;
    let mirrored = 0;
    let waiting = 0;
    // A task of a repository this login may not write to gets no issue: not waiting, no problem of its own.
    const skipped = new Set<string>();
    // Not made, made before and no longer written, or left over and no longer closed: what the mirror
    // leaves alone in such a repository.
    const unmade = (record: MirrorRecord) => (record.state === "creating" || record.state === "linked" || record.state === "orphan") && this.readOnly(record);
    for (const record of records) {
      if (unmade(record)) {
        skipped.add(`${record.host}/${record.repo}`);
        continue;
      }
      if (record.state === "creating" || record.state === "created") waiting += 1;
      if (record.state !== "linked") continue;
      mirrored += 1;
      const task = committed.entities.get(record.task);
      if (task?.entity.type === "task" && task.entity.status !== "inbox") {
        const content = issueContent(committed, task.entity, task.brief, { forge: record.forge, host: record.host, repo: record.repo });
        if (contentHash(content) !== record.hash) waiting += 1;
      }
    }
    for (const loaded of committed.entities.values()) {
      const entity = loaded.entity;
      if (entity.type !== "task" || !wantsIssue(entity)) continue;
      const repo = projectRepoOf(committed, entity.project!);
      if (!repo || store?.any(space.key, entity.id)) continue;
      if (this.readOnly(repo)) skipped.add(`${repo.host}/${repo.repo}`);
      else waiting += 1;
    }
    const now = this.now();
    return {
      mirrored,
      waiting,
      problems: records.flatMap((r) => (r.error && !unmade(r) ? [{ task: r.task, error: r.error }] : [])),
      read_only: [...skipped].sort(),
      paused: [...this.pausedUntil.entries()].filter(([, until]) => until > now).map(([host, until]) => `${host} until ${new Date(until).toISOString()}`),
    };
  }
}

function projectRepoOf(plan: Pick<Plan, "space">, key: string): ProjectRepo | undefined {
  const project = plan.space?.projects[key];
  return project ? projectRepo(project) : undefined;
}
