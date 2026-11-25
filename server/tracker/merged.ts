import { refId, type Task, unheld } from "../../shared/model.ts";
import { plannedBranch } from "../api/view.ts";
import type { Plan } from "../plan/load.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { type ForgeCli, type ForgePr, MERGED_LIST, prUrlOfProject } from "./forge.ts";

/**
 * How a merged PR/MR is tied to a task, each checked in the task's own project only: its branch (the
 * planned one), a link of the task, the task's id in its title, description or source branch (so a
 * session that named its branch otherwise is still found: ERG-7MRG1 and site !412), or the forge
 * naming it as the one that closed the task's issue. An issue number or a similar title alone never
 * ties one: the same number is another issue in another repository.
 */
export const MATCHED_BY = ["branch", "link", "id_in_title", "id_in_description", "id_in_branch", "closes_issue"] as const;
export type MatchedBy = (typeof MATCHED_BY)[number];

/**
 * Work merged outside the dashboard (03-model.md, Work merged outside the dashboard): a task that
 * never ran, in `todo` or `inbox`, or one in progress that no live run holds (`unheld`),
 * whose branch's latest PR/MR, or a PR/MR of its project among its `links`, was merged after the task
 * was created. Such work was done by a session the dashboard did
 * not start, so no run follows it and nothing moves the task. It is runtime state per machine, like
 * an issue's state: shown with "Mark done", never written to the plan, and it never changes the task.
 *
 * Only the task's own project is asked, in its checkout on this machine and through its remote from
 * space.yaml: a branch name several projects share (feat/member-roles in site and docker-compose) is
 * looked up in each task's own repository. Read on a slow timer, and in the background when a screen
 * shows the board or the task and the last reading is old.
 */

export interface MergedPr {
  label: string;
  url: string;
  merged_at: string;
  /** The merge's commit on the target branch, when the forge names it. */
  sha?: string;
  /** The PR/MR's own source branch. */
  branch?: string;
  /** Ids of other tasks its title or source branch names: whose work it may be instead. */
  names?: string[];
  by: MatchedBy[];
}

export interface MergedView {
  /** What it was read for (branch, links, created): a task edited since shows nothing until it is read again. */
  key: string;
  /** When this machine read it. */
  at: string;
  merged: MergedPr[];
}

export interface MergedTrackerOptions {
  spaces: () => { sync: SpaceSync; mapping: Record<string, string | null> }[];
  projectRoot: (projectId: string) => string | undefined;
  forge: ForgeCli;
  now?: () => Date;
  everyMs?: number;
  /** Whether this machine's project checkouts are known yet; before that nothing can be read. */
  ready?: () => boolean;
  /** The PR/MR URLs the forge says closed the task's issue (server/tracker/issues.ts), as last read here. */
  issueClosers?: (plan: Plan, task: Task) => string[];
  log?: (message: string) => void;
}

/** At most this many PR/MR links of a task are read: links are written by hand and may be many. */
const LINKS_READ = 5;
/** A screen's read starts a new pass when the last one ended longer ago than this. */
const FRESH_MS = 5 * 60_000;

/** What a task is checked by: its id, its branch when it or its feature names one, and its links to PR/MRs of its project. */
export interface MergedCandidates {
  id: string;
  /** The space's project key: a pass reads each project's latest merges once. */
  project: string;
  remote: string;
  webHost?: string;
  branch?: string;
  links: string[];
  key: string;
}

/**
 * The candidates of a task this machine follows: `todo` or `inbox` never started (no `run_id`; a task
 * with a run is followed by its run's PR/MR), or in progress with no live run (`unheld`: a
 * session outside the dashboard set the status, so no run's PR/MR is followed), in a project of the
 * space, with a `created` time to compare merges with. Its id is always looked for in the project's
 * latest merges; its branch only when it or its feature names one (the default `task/<id>-<slug>`
 * holds the id already), and its links to PR/MRs of the project.
 */
export function mergedCandidates(plan: Plan, task: Task): MergedCandidates | undefined {
  const neverRan = (task.status === "todo" || task.status === "inbox") && !task.run_id;
  if ((!neverRan && !unheld(task)) || !task.project) return undefined;
  const project = plan.space?.projects[task.project];
  if (!project || !Number.isFinite(Date.parse(task.created ?? ""))) return undefined;
  const feature = plan.entities.get(refId(task.feature) ?? "")?.entity;
  const named = Boolean(task.branch) || (feature?.type === "feature" && Boolean(feature.branch));
  const planned = named ? plannedBranch(plan, task) : undefined;
  const branch = planned && SAFE_BRANCH.test(planned) ? planned : undefined;
  const links = [...new Set(task.links.map((link) => link.trim()).filter((link) => prUrlOfProject(link, project.remote, project.web_host)))].slice(0, LINKS_READ);
  return {
    id: task.id,
    project: task.project,
    remote: project.remote,
    ...(project.web_host ? { webHost: project.web_host } : {}),
    ...(branch ? { branch } : {}),
    links,
    key: [task.id, task.project, branch ?? "", ...links, task.created].join("\n"),
  };
}

/** An id as a text may name it, in any case (branch names spell it in lower case). */
const ANY_ID = /(?<![A-Za-z0-9])[A-Za-z]{2,6}-[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{5}(?![A-Za-z0-9])/g;

/** Every task id a text names, upper-cased, each once; a word of the same shape counts too, so check it against the plan. */
export function namedIds(text: string): string[] {
  return [...new Set((text.match(ANY_ID) ?? []).map((id) => id.toUpperCase()))];
}

/** The task's id as a token of a text: not part of a longer id or word; any case (branches are lower case). */
function idIn(text: string | undefined, id: string): boolean {
  if (!text) return false;
  return new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`, "i").test(text);
}

/** How a merged PR/MR names the task's id: its title, description or source branch; empty when it does not. */
export function idMatches(pr: Pick<ForgePr, "title" | "body" | "head">, id: string): MatchedBy[] {
  const by: MatchedBy[] = [];
  if (idIn(pr.title, id)) by.push("id_in_title");
  if (idIn(pr.body, id)) by.push("id_in_description");
  if (idIn(pr.head, id)) by.push("id_in_branch");
  return by;
}

export class MergedTracker {
  /** By task id. */
  readonly seen = new Map<string, MergedView>();
  private readonly options: MergedTrackerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private stopped = false;
  /** When the last pass over every followed task ended (ms); 0 before the first one with checkouts known. */
  private lastPass = 0;
  private readonly inFlight = new Map<string, Promise<void>>();
  /** When each task was last asked for, answered or not: a task screen does not ask again before FRESH_MS. */
  private readonly asked = new Map<string, number>();
  /**
   * The readings for which the forge's search for the task's id answered. Kept apart from the
   * reading: screens follow its content (server/changes.ts), and this changes nothing they show.
   */
  private readonly searched = new WeakSet<MergedView>();
  /** Each project's latest merges as the last pass read them, by `<space>:<project>`; absent when the forge did not answer. */
  private readonly recent = new Map<string, { at: number; prs: ForgePr[]; cut: boolean }>();

  constructor(options: MergedTrackerOptions) {
    this.options = options;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    void this.checkAll().catch(() => undefined);
    this.timer = setInterval(() => void this.checkAll().catch(() => undefined), this.options.everyMs ?? 15 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A pass in the background when the last one ended FRESH_MS ago or more; reads never wait on it. */
  peek(minAgeMs = FRESH_MS): void {
    if (this.stopped || !this.timer || this.checking || this.now().getTime() - this.lastPass < minAgeMs) return;
    void this.checkAll().catch(() => undefined);
  }

  /** Every followed task once, one at a time; each project's latest merges once per pass. */
  async checkAll(): Promise<void> {
    if (this.checking || this.options.ready?.() === false) return;
    this.checking = true;
    try {
      const followed = new Set<string>();
      const listed = new Set<string>();
      for (const space of this.options.spaces()) {
        for (const loaded of [...space.sync.plan.entities.values()]) {
          if (this.stopped) return;
          const task = loaded.entity;
          if (task.type !== "task") continue;
          const wanted = mergedCandidates(space.sync.plan, task);
          if (!wanted) continue;
          followed.add(task.id);
          const projectKey = recentKey(space, wanted.project);
          if (!listed.has(projectKey)) {
            listed.add(projectKey);
            await this.readRecent(space, wanted).catch((error: unknown) => this.options.log?.(`merged list of ${wanted.project}: ${(error as Error).message}`));
          }
          await this.check(space, task, { search: false }).catch((error: unknown) => this.options.log?.(`merged check of ${task.id}: ${(error as Error).message}`));
        }
      }
      // A task started, finished, or edited out of the check meanwhile shows nothing any more.
      for (const id of [...this.seen.keys()]) if (!followed.has(id)) this.seen.delete(id);
      for (const id of [...this.asked.keys()]) if (!followed.has(id)) this.asked.delete(id);
    } finally {
      this.checking = false;
      this.lastPass = this.now().getTime();
    }
  }

  /** A project's latest merges, read once per pass; a forge that does not answer leaves the last list. */
  private async readRecent(space: { sync: SpaceSync; mapping: Record<string, string | null> }, wanted: MergedCandidates): Promise<void> {
    const projectId = space.mapping[wanted.project];
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    if (!root) return;
    let cut = false;
    const prs = await this.options.forge.merged(root, wanted.remote, { listed: (count) => (cut = count >= MERGED_LIST) });
    if (prs && !this.stopped) this.recent.set(recentKey(space, wanted.project), { at: this.now().getTime(), prs, cut });
  }

  /**
   * Reads one task now; a read of the same task already going on is shared. With `search` (a screen
   * or a reconcile asking for this one task) the forge is also searched for the task's id, beyond the
   * project's latest merges a pass reads.
   */
  check(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task, options: { search?: boolean } = {}): Promise<void> {
    const running = this.inFlight.get(task.id);
    if (running) return running;
    this.asked.set(task.id, this.now().getTime());
    const read = this.read(space, task, options.search ?? true).finally(() => this.inFlight.delete(task.id));
    this.inFlight.set(task.id, read);
    return read;
  }

  private async read(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task, search: boolean): Promise<void> {
    const wanted = mergedCandidates(space.sync.plan, task);
    const projectId = task.project ? space.mapping[task.project] : undefined;
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    if (!wanted || !root) return;
    const forge = this.options.forge;
    const found: { pr: ForgePr; by: MatchedBy[] }[] = [];
    let unanswered = 0;
    for (const link of wanted.links) {
      if (this.stopped) return;
      const pr = await forge.byUrl(root, wanted.remote, link, wanted.webHost);
      if (pr) found.push({ pr, by: ["link"] });
      else unanswered += 1;
    }
    if (wanted.branch && !this.stopped) {
      const prs = await forge.byBranch(root, wanted.remote, wanted.branch);
      // The branch's latest PR/MR: an open one after a merged one carries work not merged yet.
      if (prs?.[0]) found.push({ pr: prs[0], by: ["branch"] });
      else if (!prs) unanswered += 1;
    }
    // The task's id in the project's latest merges, and on request in the forge's search of them.
    const recent = this.recent.get(recentKey(space, wanted.project))?.prs ?? [];
    const searched = search && !this.stopped ? await forge.merged(root, wanted.remote, { search: wanted.id, max: 20 }) : [];
    if (searched === undefined) unanswered += 1;
    for (const pr of [...recent, ...(searched ?? [])]) {
      const by = idMatches(pr, wanted.id);
      if (by.length) found.push({ pr, by });
    }
    // The PR/MRs the forge says closed the task's issue, when they are the project's own.
    for (const url of (this.options.issueClosers?.(space.sync.plan, task) ?? []).slice(0, LINKS_READ)) {
      if (this.stopped) return;
      if (!prUrlOfProject(url, wanted.remote, wanted.webHost)) continue;
      const pr = await forge.byUrl(root, wanted.remote, url, wanted.webHost);
      if (pr) found.push({ pr, by: ["closes_issue"] });
      else unanswered += 1;
    }
    if (this.stopped) return;
    const merged = mergedAfter(found, task.created!, task.id);
    // A forge that did not answer leaves the last reading; a merge it did name is shown at once.
    if (!merged.length && unanswered) return;
    const view = { key: wanted.key, at: this.now().toISOString(), merged };
    if (search && searched !== undefined) this.searched.add(view);
    this.seen.set(task.id, view);
  }

  /**
   * What this machine last read of a task's merged work, when it still applies to the task as it is
   * now; an old reading starts a new one for this task, which this call does not wait for.
   */
  peekTask(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task): MergedPr[] {
    const wanted = mergedCandidates(space.sync.plan, task);
    if (!wanted) return [];
    const view = this.seen.get(task.id);
    // A forge that did not answer stores no reading: the last time it was asked counts too.
    const at = Math.max(Date.parse(view?.at ?? "") || 0, this.asked.get(task.id) ?? 0);
    if (!this.stopped && this.timer && this.now().getTime() - at >= FRESH_MS) void this.check(space, task).catch(() => undefined);
    return view && view.key === wanted.key ? view.merged : [];
  }

  /** Whether this reading searched the forge beyond the project's latest merges, and was answered. */
  wasSearched(view: MergedView): boolean {
    return this.searched.has(view);
  }

  /** This machine's reading of a task as it is now, its time included; undefined when it has none. */
  readingOf(plan: Plan, task: Task): MergedView | undefined {
    const view = this.seen.get(task.id);
    return view && mergedCandidates(plan, task)?.key === view.key ? view : undefined;
  }

  /**
   * The latest merges of a project of a space as a pass last read them: when, and when the list is cut
   * short, how far back it goes (`since`, its oldest merge). Undefined when no pass read them.
   */
  listing(space: string, project: string): { at: string; since?: string } | undefined {
    const list = this.recent.get(`${space}:${project}`);
    if (!list) return undefined;
    // Cut short with none of the project's own among them: nothing before the reading was compared.
    const since = list.cut ? (list.prs.map((pr) => pr.mergedAt ?? "").filter(Boolean).sort()[0] ?? new Date(list.at).toISOString()) : undefined;
    return { at: new Date(list.at).toISOString(), ...(since ? { since } : {}) };
  }

  /** A PR/MR by its URL among a project's latest merges, as the last pass read them; never asks the forge. */
  listed(space: string, project: string, url: string): ForgePr | undefined {
    return this.recent.get(`${space}:${project}`)?.prs.find((pr) => pr.url === url);
  }

  /** The reading of a task as a list shows it: never asks the forge (`peek` does, once per pass). */
  shown(plan: Plan, task: Task): MergedPr[] {
    // Most tasks have no reading: the candidates are worked out only for those that do.
    const view = this.seen.get(task.id);
    if (!view?.merged.length) return [];
    return mergedCandidates(plan, task)?.key === view.key ? view.merged : [];
  }
}

/** `<space>:<project>`: one project of one space, whose latest merges a pass reads once. */
function recentKey(space: { sync: SpaceSync }, project: string): string {
  return `${space.sync.plan.space?.key ?? ""}:${project}`;
}

/**
 * The merged PR/MRs of `found` merged after the task was created, each once with every way it was
 * tied to the task; pure. Newest merge first.
 */
export function mergedAfter(found: (ForgePr | { pr: ForgePr; by: MatchedBy[] })[], created: string, self = ""): MergedPr[] {
  const since = Date.parse(created);
  const out = new Map<string, MergedPr>();
  for (const item of found) {
    const { pr, by } = "pr" in item ? item : { pr: item, by: [] as MatchedBy[] };
    const at = Date.parse(pr.mergedAt ?? "");
    if (pr.state !== "merged" || !Number.isFinite(at) || !Number.isFinite(since) || at <= since) continue;
    const names = namedIds(`${pr.title ?? ""}\n${pr.head ?? ""}`).filter((id) => id !== self);
    const seen = out.get(pr.url);
    if (seen) {
      for (const way of by) if (!seen.by.includes(way)) seen.by.push(way);
      if (names.length) seen.names = [...new Set([...(seen.names ?? []), ...names])];
      continue;
    }
    out.set(pr.url, {
      label: pr.label,
      url: pr.url,
      merged_at: pr.mergedAt!,
      ...(pr.mergeSha ? { sha: pr.mergeSha } : {}),
      ...(pr.head ? { branch: pr.head } : {}),
      ...(names.length ? { names } : {}),
      by: [...by],
    });
  }
  return [...out.values()].sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
}
