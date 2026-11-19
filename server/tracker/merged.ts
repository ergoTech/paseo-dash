import { refId, type Task } from "../../shared/model.ts";
import { plannedBranch } from "../api/view.ts";
import type { Plan } from "../plan/load.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { type ForgeCli, type ForgePr, prUrlOfProject } from "./forge.ts";

/**
 * Work merged outside the dashboard (03-model.md, Work merged outside the dashboard): a task that
 * never ran, in `todo` or `inbox`, whose branch's latest PR/MR, or a PR/MR of its project among its
 * `links`, was merged after the task was created. Such work was done by a session the dashboard did
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
  log?: (message: string) => void;
}

/** At most this many PR/MR links of a task are read: links are written by hand and may be many. */
const LINKS_READ = 5;
/** A screen's read starts a new pass when the last one ended longer ago than this. */
const FRESH_MS = 5 * 60_000;

/** What a task is checked by: its branch, when it or its feature names one, and its links to PR/MRs of its project. */
export interface MergedCandidates {
  remote: string;
  webHost?: string;
  branch?: string;
  links: string[];
  key: string;
}

/**
 * The candidates of a task this machine follows: `todo` or `inbox`, never started (no `run_id`; a
 * task with a run is followed by its run's PR/MR), in a project of the space, with a `created` time
 * to compare merges with, and with a branch or a PR/MR link to look up. The default branch name
 * (`task/<id>-<slug>`) is not looked up: only a start makes it, and a start makes a run.
 */
export function mergedCandidates(plan: Plan, task: Task): MergedCandidates | undefined {
  if ((task.status !== "todo" && task.status !== "inbox") || task.run_id || !task.project) return undefined;
  const project = plan.space?.projects[task.project];
  if (!project || !Number.isFinite(Date.parse(task.created ?? ""))) return undefined;
  const feature = plan.entities.get(refId(task.feature) ?? "")?.entity;
  const named = Boolean(task.branch) || (feature?.type === "feature" && Boolean(feature.branch));
  const planned = named ? plannedBranch(plan, task) : undefined;
  const branch = planned && SAFE_BRANCH.test(planned) ? planned : undefined;
  const links = [...new Set(task.links.map((link) => link.trim()).filter((link) => prUrlOfProject(link, project.remote, project.web_host)))].slice(0, LINKS_READ);
  if (!branch && !links.length) return undefined;
  return { remote: project.remote, ...(project.web_host ? { webHost: project.web_host } : {}), ...(branch ? { branch } : {}), links, key: [branch ?? "", ...links, task.created].join("\n") };
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

  /** Every followed task once, one at a time. */
  async checkAll(): Promise<void> {
    if (this.checking || this.options.ready?.() === false) return;
    this.checking = true;
    try {
      const followed = new Set<string>();
      for (const space of this.options.spaces()) {
        for (const loaded of [...space.sync.plan.entities.values()]) {
          if (this.stopped) return;
          const task = loaded.entity;
          if (task.type !== "task" || !mergedCandidates(space.sync.plan, task)) continue;
          followed.add(task.id);
          await this.check(space, task).catch((error: unknown) => this.options.log?.(`merged check of ${task.id}: ${(error as Error).message}`));
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

  /** Reads one task now; a read of the same task already going on is shared. */
  check(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task): Promise<void> {
    const running = this.inFlight.get(task.id);
    if (running) return running;
    this.asked.set(task.id, this.now().getTime());
    const read = this.read(space, task).finally(() => this.inFlight.delete(task.id));
    this.inFlight.set(task.id, read);
    return read;
  }

  private async read(space: { sync: SpaceSync; mapping: Record<string, string | null> }, task: Task): Promise<void> {
    const wanted = mergedCandidates(space.sync.plan, task);
    const projectId = task.project ? space.mapping[task.project] : undefined;
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    if (!wanted || !root) return;
    const forge = this.options.forge;
    const found: ForgePr[] = [];
    let unanswered = 0;
    for (const link of wanted.links) {
      if (this.stopped) return;
      const pr = await forge.byUrl(root, wanted.remote, link, wanted.webHost);
      if (pr) found.push(pr);
      else unanswered += 1;
    }
    if (wanted.branch && !this.stopped) {
      const prs = await forge.byBranch(root, wanted.remote, wanted.branch);
      // The branch's latest PR/MR: an open one after a merged one carries work not merged yet.
      if (prs?.[0]) found.push(prs[0]);
      else if (!prs) unanswered += 1;
    }
    if (this.stopped) return;
    const merged = mergedAfter(found, task.created!);
    // A forge that did not answer leaves the last reading; a merge it did name is shown at once.
    if (!merged.length && unanswered) return;
    this.seen.set(task.id, { key: wanted.key, at: this.now().toISOString(), merged });
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

  /** The reading of a task as a list shows it: never asks the forge (`peek` does, once per pass). */
  shown(plan: Plan, task: Task): MergedPr[] {
    // Most tasks have no reading: the candidates are worked out only for those that do.
    const view = this.seen.get(task.id);
    if (!view?.merged.length) return [];
    return mergedCandidates(plan, task)?.key === view.key ? view.merged : [];
  }
}

/** The merged PR/MRs of `found` merged after the task was created, each once; pure. */
export function mergedAfter(found: ForgePr[], created: string): MergedPr[] {
  const since = Date.parse(created);
  const out = new Map<string, MergedPr>();
  for (const pr of found) {
    const at = Date.parse(pr.mergedAt ?? "");
    if (pr.state !== "merged" || !Number.isFinite(at) || !Number.isFinite(since) || at <= since) continue;
    out.set(pr.url, { label: pr.label, url: pr.url, merged_at: pr.mergedAt! });
  }
  return [...out.values()];
}
