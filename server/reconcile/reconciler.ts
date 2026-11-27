import { closed, hasLiveRun, type Task } from "../../shared/model.ts";
import { localHost, localRun, plannedBranch } from "../api/view.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { opaqueId } from "../plan/ids.ts";
import type { Plan } from "../plan/load.ts";
import type { RunStore } from "../runner/runs.ts";
import { type GitRunner, SAFE_BRANCH } from "../sync/git.ts";
import { closeRevision, type Operation } from "../sync/ops.ts";
import { prDetails } from "../tracker/details.ts";
import { type ForgeCli, type ForgePr, prKey, prUrlOfProject } from "../tracker/forge.ts";
import { idMatches, type MergedPr, namedIds } from "../tracker/merged.ts";
import type { PrView } from "../tracker/prs.ts";
import { apkStates, buildPool, isApp } from "./android.ts";
import { type CardFacts, type GoneFacts, type Mention, merged, mergedSince, named, type PrFact, type Scope } from "./facts.ts";
import { type StageHolds, stageHolds } from "./steps.ts";
import { agentGone, cardsOwn, ofCard } from "./stopped.ts";
import { scopeSince } from "./history.ts";
import { type Rule, ruleOf } from "./rules.ts";
import { judgeTie, type TieIndex, tieIndex, type Way } from "./ties.ts";
import { type JudgeInput, judge, type Verdict } from "./verdict.ts";
import type { Item } from "./needs.ts";

/**
 * Automatic reconciliation (03-model.md, Automatic reconciliation): for the projects this machine's
 * owner switched on (rules.ts), the open cards with work behind them are compared with the forge, and
 * what is complete is closed once; everything else keeps its holds, which Needs you and the reconcile
 * read show. Reads never wait on it: a pass runs after each sync of the plans and reads again only
 * what is old or whose links or branch changed (builds are compared again with git alone), so a verdict
 * follows the facts as they appear. At most MAX_READS cards are asked about at once.
 * It never starts, stops, releases or restarts a run. A live run's card closes only through its own
 * run's merged PR/MR (server/tracker/prs.ts asks `gate`).
 *
 * A card whose agent is gone while its run still holds it is read too, in every project, whatever the
 * rule (stopped.ts): its work may be merged from a branch the run never recorded. That reading only
 * informs: without a rule nothing closes, and a held card never closes here.
 */

export interface ReconcilerOptions {
  dataDir: string;
  /** This machine's spaces; empty while it does not own the data. */
  spaces: () => SpaceEntry[];
  projectRoot: (projectId: string) => string | undefined;
  forge: ForgeCli;
  git: GitRunner;
  runs: () => RunStore | undefined;
  /** What the run's tracker last saw of a card's PR/MR. */
  seen: (taskId: string) => PrView | undefined;
  /** The PR/MRs the forge says closed the card's issue, as last read here. */
  closers: (plan: Plan, task: Task) => string[];
  merged: (plan: Plan, task: Task) => MergedPr[];
  /** Whether this machine's project checkouts are known yet. */
  ready?: () => boolean;
  host?: string;
  now?: () => Date;
  /** A reading older than this is read again by the next pass. */
  freshMs?: number;
  log?: (message: string) => void;
}

export interface Gate {
  /** The closure to record in place of the run's own transition. */
  op?: Operation;
  /** Why the run's merge does not close the card. */
  hold?: string;
}

/** A reading older than this is made again; one that could not read everything, sooner. */
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;
/** PR/MR links of a card read at most, and PR/MRs read in full: a card names a handful. */
const LINKS_READ = 5;
const PRS_READ = 10;
/** The most one branch listing or search of the id answers: that many means there may be more. */
const HITS = 20;
/** Cards read from the forge at once, however many a screen asks about. */
const MAX_READS = 2;
/** How long a project's list of open PR/MRs serves the reads of its cards; a closing asks again. */
const OPEN_LIST_MS = 60_000;
const PR_LIKE = /\/(?:pull|merge_requests)\/\d+/;

const key = (space: SpaceEntry, task: Task) => `${space.record.key}:${task.id}`;

export class Reconciler {
  private readonly facts = new Map<string, CardFacts>();
  private readonly reading = new Map<string, Promise<CardFacts | undefined>>();
  private readonly openLists = new Map<string, { at: number; list: Promise<ForgePr[] | undefined> }>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Build comparisons screens asked for, one at a time, and the cards waiting for one. */
  private covers: Promise<unknown> = Promise.resolve();
  private readonly covering = new Set<string>();
  private readonly options: ReconcilerOptions;
  private passing = false;
  private again = false;
  private stopped = false;

  constructor(options: ReconcilerOptions) {
    this.options = options;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private get host(): string {
    return this.options.host ?? localHost();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Queues a comparison a screen noticed is due; it is not waited for. */
  private coverLater(space: SpaceEntry, task: Task, facts: CardFacts): void {
    const id = key(space, task);
    if (this.covering.has(id) || facts.apksKey === this.apksKey(space, task)) return;
    this.covering.add(id);
    this.covers = this.covers
      .then(() => (this.stopped ? undefined : this.cover(space, task, facts)))
      .catch((error: unknown) => this.options.log?.(`builds of ${task.id}: ${String((error as Error)?.message ?? error)}`))
      .finally(() => this.covering.delete(id));
  }

  /** The owner's rule for the card's project; undefined when it is off. */
  rule(space: SpaceEntry, task: Task): Rule | undefined {
    return task.project ? ruleOf(this.options.dataDir, space.record.key, task.project) : undefined;
  }

  /** Whether a rule of this machine covers the task of that space's plan. */
  ruled(sync: SpaceSync, taskId: string): boolean {
    const space = this.options.spaces().find((s) => s.sync === sync);
    const task = sync.plan.entities.get(taskId)?.entity;
    return Boolean(space && task?.type === "task" && this.rule(space, task));
  }

  /** Why the rule does not let a closure be written now (server/sync/space-sync.ts, mayClose). */
  mayClose(spaceKey: string, taskId: string): string | undefined {
    const space = this.options.spaces().find((s) => s.record.key === spaceKey);
    const task = space?.sync.plan.entities.get(taskId)?.entity;
    if (!space || task?.type !== "task") return "the card is not in a space of this machine";
    return this.rule(space, task)?.mode === "close" ? undefined : `this machine's rule does not let ${task.project ?? "its project"} close cards`;
  }

  /** An open card with something to reconcile: a PR/MR known for it, work under way or in review, or a closure of the rule undone. */
  evidence(space: SpaceEntry, task: Task): boolean {
    if (closed(task)) return false;
    if (task.auto_closed || task.run_pr || task.status === "review" || task.status === "in_progress") return true;
    if (task.links.some((link) => PR_LIKE.test(link))) return true;
    if (this.options.merged(space.sync.plan, task).length || this.options.seen(task.id)) return true;
    return Boolean(this.facts.get(key(space, task))?.prs.length);
  }

  /** Whether the card is held by a run whose agent is gone on this Mac (stopped.ts); `host` names this Mac. */
  stoppedHold(space: SpaceEntry, task: Task, host: string = this.host): boolean {
    const runs = this.options.runs();
    if (!runs) return false;
    // A claim of this Mac still on its way is a start, not a lost agent.
    const claiming = space.sync.journalEntries.some(({ op }) => op.kind === "claim" && op.run.run_id === task.run_id);
    return agentGone(task, localRun(runs, task), host, claiming);
  }

  /** Which stop a held card's agent is in: the run's last change of activity; undefined when it is not gone. */
  private stopOf(space: SpaceEntry, task: Task, host: string = this.host): string | undefined {
    if (!this.stoppedHold(space, task, host)) return undefined;
    return this.options.runs()?.runs.get(task.run_id ?? "")?.activityAt ?? "no record";
  }

  /**
   * The last reading made for this stop of the run that holds the card now: a reading of an earlier run,
   * of a time the agent worked, or of an earlier stop says nothing of this hold.
   */
  stoppedFacts(space: SpaceEntry, task: Task, host: string = this.host): CardFacts | undefined {
    const stop = this.stopOf(space, task, host);
    const found = this.latest(space, task);
    return found && stop !== undefined && found.run === task.run_id && found.gone?.stop === stop ? found : undefined;
  }

  /** What a reading depends on besides the forge: another value makes the reading old. */
  private factsKey(space: SpaceEntry, task: Task): string {
    const plan = space.sync.plan;
    const project = task.project ? plan.space?.projects[task.project] : undefined;
    const seen = this.options.seen(task.id);
    return JSON.stringify([
      task.project,
      project?.remote,
      project?.trunk,
      task.base,
      task.links,
      task.run_id,
      task.run_pr,
      task.run_branch ?? plannedBranch(plan, task),
      task.created,
      seen?.run_id === task.run_id ? [seen?.url, seen?.state] : "",
      this.options.merged(plan, task).map((pr) => pr.url),
      // A hold whose agent is gone also reads what the reading of a working run does not.
      this.stoppedHold(space, task) ? [this.stopOf(space, task), task.delivery?.stage_sha ?? "", this.options.closers(plan, task)] : "",
    ]);
  }

  /** What an app card's builds are compared for; "" for another card. */
  private apksKey(space: SpaceEntry, task: Task): string {
    if (!isApp(task) || !task.project) return "";
    return JSON.stringify([task.delivery!.variants, task.delivery!.environment, buildPool(space.sync.plan, task.project).map((b) => [b.variant, b.environment, b.sha, b.url, b.version])]);
  }

  /** Compares the builds with a reading's PR/MRs again when they changed: git only, no forge. */
  private async cover(space: SpaceEntry, task: Task, facts: CardFacts): Promise<void> {
    const wanted = this.apksKey(space, task);
    if (facts.apksKey === wanted) return;
    const projectId = task.project ? space.record.mapping[task.project] : undefined;
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    const pool = wanted ? buildPool(space.sync.plan, task.project!) : [];
    facts.apks = wanted ? await apkStates(this.options.git, root, facts.trunk, task, facts, pool) : [];
    // A hold whose agent is gone counts more of the card's work (stopped.ts), beside the rule's own comparison.
    if (facts.gone) {
      const unread = { ...facts, unknown: [...facts.unknown, ...facts.gone.unknown] };
      facts.gone.apks = wanted ? await apkStates(this.options.git, root, facts.trunk, task, unread, pool, (pr) => ofCard(pr, facts.trunk)) : [];
    }
    facts.apksKey = wanted;
  }

  /**
   * The last reading of a card, whatever changed since: what screens show while a new one is made.
   * Nothing closes on it (`current`).
   */
  latest(space: SpaceEntry, task: Task): CardFacts | undefined {
    return this.facts.get(key(space, task));
  }

  /** The last reading of a card that still applies to it. */
  current(space: SpaceEntry, task: Task): CardFacts | undefined {
    const found = this.facts.get(key(space, task));
    return found && found.key === this.factsKey(space, task) ? found : undefined;
  }

  /** `retry`: whether a reading that could not read everything is made again sooner. */
  private stale(facts: CardFacts | undefined, retry = true): boolean {
    if (!facts) return true;
    const limit = retry && facts.unknown.length ? Math.min(RETRY_MS, this.options.freshMs ?? FRESH_MS) : (this.options.freshMs ?? FRESH_MS);
    return this.now().getTime() - Date.parse(facts.at) >= limit;
  }

  private agentOf(task: Task): JudgeInput["agent"] {
    if (!hasLiveRun(task)) return undefined;
    const runs = this.options.runs();
    const run = runs ? localRun(runs, task) : undefined;
    if (!run) return task.run_host === this.host ? "gone" : "elsewhere";
    if (run.activity === "stopped" || run.activity === "failed") return "gone";
    return run.activity === "waiting" || run.activity === "needs_input" ? "waiting" : "working";
  }

  private judgeCard(space: SpaceEntry, taskId: string, asRun: boolean, read: "current" | "latest" = "current"): Verdict | undefined {
    const plan = space.sync.plan;
    const loaded = plan.entities.get(taskId);
    const task = loaded?.entity;
    if (!loaded || task?.type !== "task") return undefined;
    const rule = this.rule(space, task);
    if (!rule) return undefined;
    return judge({ plan, task, loaded, rule, facts: this[read](space, task), asRun, agent: this.agentOf(task), host: this.host });
  }

  /**
   * The verdict on a card as a screen shows it, from the last reading and the plan as it is now;
   * undefined for a project that is off or a card with nothing to reconcile. A card whose links,
   * branch or builds changed since that reading is read again in the background; it is not waited for.
   */
  verdict(space: SpaceEntry, task: Task): Verdict | undefined {
    if (!this.rule(space, task) || !this.evidence(space, task)) return undefined;
    const current = this.current(space, task);
    if (this.facts.has(key(space, task)) && !current) void this.read(space, task);
    else if (current) this.coverLater(space, task, current);
    return this.judgeCard(space, task.id, false, "latest");
  }

  /**
   * Whether the card's code is in the target branch, as last read in full: merged work of its own, every
   * merged PR/MR it names landed there, and none it names still open.
   */
  codeMerged(space: SpaceEntry, taskId: string): boolean {
    const task = space.sync.plan.entities.get(taskId)?.entity;
    const facts = task?.type === "task" ? this.latest(space, task) : undefined;
    if (!facts || facts.unknown.length || facts.limits.length) return false;
    const created = (task as Task).created;
    // A merge from before the card existed is a reference, not its work.
    const work = facts.prs.filter((pr) => named(pr) && (pr.state !== "merged" || mergedSince(pr, created)));
    return (
      work.some((pr) => pr.own && pr.state === "merged") &&
      !work.some((pr) => pr.state === "open" || pr.state === "draft" || (pr.state === "merged" && pr.base !== facts.trunk))
    );
  }

  /** Reads a card now; a read of the same card already going on is shared. */
  read(space: SpaceEntry, task: Task): Promise<CardFacts | undefined> {
    // Before this machine's checkouts are known nothing can be read, and "not mapped" would be a guess.
    if (this.options.ready?.() === false) return Promise.resolve(undefined);
    const id = key(space, task);
    const running = this.reading.get(id);
    if (running) return running;
    // A read still waiting for its turn when the plugin stops asks nothing.
    const read = this.slot(async () => (this.stopped ? undefined : this.gather(space, task)))
      .then((facts) => {
        if (facts && !this.stopped) this.facts.set(id, facts);
        return facts;
      })
      .catch((error: unknown) => {
        this.options.log?.(`reconcile of ${task.id}: ${String((error as Error)?.message ?? error)}`);
        return undefined;
      })
      .finally(() => this.reading.delete(id));
    this.reading.set(id, read);
    return read;
  }

  /** A reading that begins now: one already going on may predate what asks for it. */
  private async readAnew(space: SpaceEntry, task: Task): Promise<CardFacts | undefined> {
    await this.reading.get(key(space, task));
    this.openLists.clear();
    return this.read(space, task);
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_READS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  /** The card's facts for a screen: the fresh reading, else one made now, waited for at most `waitMs`. */
  async factsFor(space: SpaceEntry, task: Task, waitMs: number): Promise<CardFacts | undefined> {
    const current = this.current(space, task);
    if (current && !this.stale(current)) {
      await this.cover(space, task, current);
      return current;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)));
    await Promise.race([this.read(space, task), late]).finally(() => clearTimeout(timer));
    return this.current(space, task);
  }

  /**
   * A card read from the forge now, whatever was read before, waited for at most `waitMs`; false when no
   * reading came of it in time. One already going on is waited for instead of asking a second after it.
   */
  async readNow(space: SpaceEntry, task: Task, waitMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)));
    if (!this.reading.has(key(space, task))) this.openLists.clear();
    // A reading joined may have begun before this stop: then one more is made, within the same wait.
    const ofThisStop = (facts: CardFacts | undefined) => Boolean(facts) && facts!.gone?.stop === this.stopOf(space, task);
    const read = this.read(space, task).then((facts) => (ofThisStop(facts) ? true : this.read(space, task).then(ofThisStop)));
    return Promise.race([read, late]).finally(() => clearTimeout(timer));
  }

  /** Every card of a switched-on project, one at a time: read what is old, close what the rule lets. A call during a pass asks for one more. */
  async pass(): Promise<void> {
    if (this.stopped || this.options.ready?.() === false) return;
    if (this.passing) {
      this.again = true;
      return;
    }
    this.passing = true;
    try {
      do {
        this.again = false;
        const known = new Set<string>();
        for (const space of this.options.spaces()) {
          for (const { entity } of [...space.sync.plan.entities.values()]) {
            if (this.stopped) return;
            if (entity.type !== "task" || !((this.rule(space, entity) && this.evidence(space, entity)) || this.stoppedHold(space, entity))) continue;
            known.add(key(space, entity));
            await this.reconcile(space, entity.id).catch((error: unknown) => this.options.log?.(`reconcile of ${entity.id}: ${String((error as Error)?.message ?? error)}`));
          }
        }
        // A card finished, or a project switched off, keeps no reading.
        for (const id of [...this.facts.keys()]) if (!known.has(id)) this.facts.delete(id);
      } while (this.again && !this.stopped);
    } finally {
      this.passing = false;
    }
  }

  /**
   * What a live run's need adds in a reconciled project: the card's links and where the decision
   * comes from, and for a run whose merge closed nothing the one step that is left (`merged`).
   */
  heldRun(space: SpaceEntry, task: Task, need: { kind: string }): { next?: string; cards: NonNullable<Item["cards"]> } | undefined {
    if (!this.rule(space, task)) return undefined;
    const verdict = this.judgeCard(space, task.id, true, "latest");
    const hold = verdict?.holds[0];
    if (!verdict || !hold) return undefined;
    const links = verdict.sources.filter((source) => source.url);
    return {
      ...(need.kind === "merged" ? { next: hold.next } : {}),
      cards: [{ task: task.id, title: task.title, note: hold.text.slice(0, 200), source: hold.source.label, links }],
    };
  }

  private async reconcile(space: SpaceEntry, taskId: string): Promise<void> {
    const task = () => {
      const entity = space.sync.plan.entities.get(taskId)?.entity;
      return entity?.type === "task" ? entity : undefined;
    };
    const first = task();
    if (!first) return;
    const known = this.current(space, first);
    // Without a rule a held card is only informed: a forge that fails is not asked every minute for it.
    if (!known || this.stale(known, Boolean(this.rule(space, first)))) await this.read(space, first);
    else await this.cover(space, first, known);
    const held = task();
    // A live run's card is closed by its run's merge only (gate); nothing here takes it from the run.
    if (!held || hasLiveRun(held) || closed(held) || !this.judgeCard(space, taskId, false)?.close) return;
    // Everything holds on the last reading: the closure stands on one made now, never on an older one.
    if (!(await this.readAnew(space, held))) return;
    const loaded = space.sync.plan.entities.get(taskId);
    const now = task();
    const verdict = this.judgeCard(space, taskId, false);
    if (this.stopped || !loaded || !now || hasLiveRun(now) || closed(now) || !verdict?.close) return;
    const op: Operation = { op_id: opaqueId("op"), kind: "close", id: taskId, expect_rev: closeRevision(loaded), closure: verdict.closure! };
    const { outcomes } = space.sync.record([op]);
    const outcome = (await outcomes).get(op.op_id);
    if (outcome && outcome.status !== "applied" && outcome.status !== "already") this.options.log?.(`${taskId} was not closed: ${outcome.reason}`);
  }

  /**
   * Asked before a live run's merged PR/MR (`url`) ends run `runId` of a task (server/tracker/prs.ts):
   * undefined when the project is off and the run's own rule stands; else the closure to record, or
   * what holds it. A closure ends only that run, and only on that PR/MR: a run that took the task
   * meanwhile is never ended by the earlier one's merge.
   */
  async gate(sync: SpaceSync, taskId: string, runId: string, url: string): Promise<Gate | undefined> {
    const space = this.options.spaces().find((s) => s.sync === sync);
    const card = () => {
      const loaded = sync.plan.entities.get(taskId);
      return loaded?.entity.type === "task" ? { loaded, task: loaded.entity } : undefined;
    };
    const first = card();
    if (!space || !first) return { hold: "the card or its space is not on this machine any more" };
    if (!this.rule(space, first.task)) return undefined;
    const gone = { hold: "the run the merge was seen for no longer holds the task" };
    if (first.task.run_id !== runId || !hasLiveRun(first.task)) return gone;
    const same = (pr: string) => prKey(pr) === prKey(url);
    // A fresh reading that already saw the merge and holds the card is not asked for again.
    const known = this.current(space, first.task);
    if (known && !this.stale(known) && known.prs.some((pr) => same(pr.url) && pr.state === "merged")) {
      const verdict = this.judgeCard(space, taskId, true);
      if (verdict && !verdict.close) return { hold: verdict.holds[0]!.text };
    }
    if (!(await this.readAnew(space, first.task))) return { hold: "its facts could not be read" };
    const now = card();
    if (!now || now.task.run_id !== runId || !hasLiveRun(now.task)) return gone;
    const verdict = this.judgeCard(space, taskId, true);
    if (!verdict) return { hold: "its facts could not be read" };
    if (!verdict.close) return { hold: verdict.holds[0]!.text };
    if (!verdict.closure!.prs.some(same)) return { hold: `${url} is not proven to be this card's own merged work` };
    return { op: { op_id: opaqueId("op"), kind: "close", id: taskId, run_id: runId, expect_rev: closeRevision(now.loaded), closure: verdict.closure! } };
  }

  /** The project's latest open PR/MRs, shared by the reads of its cards for a short while. */
  private openOf(root: string, remote: string): Promise<ForgePr[] | undefined> {
    const id = `${root}\n${remote}`;
    const known = this.openLists.get(id);
    if (known && this.now().getTime() - known.at < OPEN_LIST_MS) return known.list;
    const list = this.options.forge.open(root, remote);
    this.openLists.set(id, { at: this.now().getTime(), list });
    void list.then((answer) => (answer ? undefined : this.openLists.delete(id)));
    return list;
  }

  private async gather(space: SpaceEntry, task: Task): Promise<CardFacts> {
    const plan = space.sync.plan;
    const at = this.now().toISOString();
    const factsKey = this.factsKey(space, task);
    const gone = this.stopOf(space, task);
    const unknown: string[] = [];
    const limits: CardFacts["limits"] = [];
    const mentions: Mention[] = [];
    const run = hasLiveRun(task) ? (task.run_id ?? "") : "";
    const facts = (trunk = "", prs: PrFact[] = []): CardFacts => ({ key: factsKey, at, trunk, prs, unknown, limits, scope: { unknown: "no merged work to compare it with", acted: "" }, apks: [], apksKey: "", run, mentions });
    const project = task.project ? plan.space?.projects[task.project] : undefined;
    const projectId = task.project ? space.record.mapping[task.project] : undefined;
    const root = projectId ? this.options.projectRoot(projectId) : undefined;
    if (!project || !root) {
      limits.push({ why: `project ${task.project ?? "(none)"} is not mapped on this Mac, so its forge cannot be asked`, advice: "open the project in Paseo on this Mac" });
      const none = facts();
      await this.cover(space, task, none);
      return none;
    }
    const trunk = task.base ?? project.trunk ?? (await this.defaultBranch(root));
    const forge = this.options.forge;
    const remote = project.remote;
    const found = new Map<string, Set<Way>>();
    const note = (url: string, way: Way) => found.set(url, (found.get(url) ?? new Set()).add(way));
    const own = (url: string) => prUrlOfProject(url, remote, project.web_host);
    const elsewhere = "if it is part of this card's work, check it yourself; else take it off the card";

    const seen = this.options.seen(task.id);
    if (task.run_pr) {
      if (own(task.run_pr)) note(task.run_pr, "run");
      else limits.push({ why: `${task.run_pr} of its run is not a PR/MR of ${task.project}`, advice: elsewhere });
    }
    if (seen && seen.run_id === task.run_id && own(seen.url)) note(seen.url, "run");
    const links = [...new Set(task.links.map((link) => link.trim()).filter((link) => PR_LIKE.test(link)))];
    for (const link of links.slice(0, LINKS_READ)) {
      // A link into another repository may be part of the work, and nothing here can read it.
      if (own(link)) note(link, "link");
      else limits.push({ why: `the link ${link} is a PR/MR of another repository, which is not read`, advice: elsewhere });
    }
    if (links.length > LINKS_READ) limits.push({ why: `only ${LINKS_READ} of its ${links.length} PR/MR links are read`, advice: "keep only the links of its own work" });
    for (const url of this.options.closers(plan, task).slice(0, LINKS_READ)) if (own(url)) note(url, "closes_issue");

    const branch = task.run_branch ?? plannedBranch(plan, task);
    const ownBranch = SAFE_BRANCH.test(branch) && branch !== trunk && branch !== project.trunk;
    const askBranch = () => (ownBranch ? forge.byBranch(root, remote, branch) : Promise.resolve(undefined));
    const askMerged = () => forge.merged(root, remote, { search: task.id, max: HITS });
    const askOpen = () => Promise.all([this.openOf(root, remote), forge.open(root, remote, { search: task.id, max: HITS })]);
    // For a hold whose agent is gone the lists are asked together: one after another, a single card
    // outlasts the read that waits for it. A pass of the rule keeps asking one thing at a time.
    // One that throws reads as not answered, also while an earlier one is still waited for.
    const none = () => undefined;
    const early = gone === undefined ? undefined : { branch: askBranch().catch(none), merged: askMerged().catch(none), open: askOpen().catch(() => [undefined, undefined] as const) };
    const listed = await (early?.branch ?? askBranch());
    // A branch's tip is asked of origin once a reading, whoever needs it.
    const tips = new Map<string, Promise<string | undefined>>();
    const tipOf = (head: string) => tips.get(head) ?? tips.set(head, forge.branchTip(root, head)).get(head)!;
    if (ownBranch) {
      if (!listed) unknown.push(`the PR/MRs of branch ${branch} could not be listed`);
      else if (listed.length >= HITS) limits.push({ why: `branch ${branch} has ${HITS} or more PR/MRs, so some may not be read`, advice: "check them yourself" });
      for (const pr of listed ?? []) note(pr.url, "branch");
    }
    const searched = await (early?.merged ?? askMerged());
    if (!searched) unknown.push("the forge did not answer the search for the card's id");
    else if (searched.length >= HITS) limits.push({ why: `${HITS} or more merged PR/MRs name the card, so some may not be read`, advice: "check them yourself" });
    for (const pr of [...(searched ?? []), ...this.options.merged(plan, task).map((m) => ({ url: m.url, title: "", head: m.branch ?? "", body: "", by: m.by }))]) {
      for (const way of "by" in pr ? pr.by : idMatches(pr, task.id)) note(pr.url, way);
    }
    // A follow-up nobody linked, open, naming the card in its title or branch: part of the work is not in.
    const opened = new Set<string>();
    const index = tieIndex(plan);
    const [latestOpen, namedOpen] = await (early?.open ?? askOpen());
    if (!latestOpen || !namedOpen) unknown.push("the open PR/MRs could not be listed");
    for (const pr of [...(latestOpen ?? []), ...(namedOpen ?? [])]) {
      const ways = idMatches(pr, task.id);
      for (const way of ways) {
        if (way === "id_in_description") continue;
        note(pr.url, way);
        opened.add(pr.url);
      }
      // Named in the description only: no part of a closing, but a possible follow-up of a held card.
      // One whose title or branch names another card is that card's; one from the target branch only carries it on.
      const others = namedIds(`${pr.title ?? ""}\n${pr.head ?? ""}`).some((id) => id !== task.id && index.tasks.has(id));
      const onwards = pr.head === trunk || pr.head === project.trunk;
      if (ways.length === 1 && ways[0] === "id_in_description" && !others && !onwards && !mentions.some((m) => m.url === pr.url)) {
        mentions.push({ url: pr.url, label: pr.label, draft: Boolean(pr.draft), title: pr.title ?? "" });
      }
    }

    const prs: PrFact[] = [];
    // What the card names comes first, so a long list of search hits never crowds it out.
    const strength = ([url, ways]: [string, Set<Way>]) => (ways.has("run") ? 0 : ways.has("link") ? 1 : ways.has("branch") || ways.has("closes_issue") || ways.has("id_in_branch") || opened.has(url) ? 2 : 3);
    const ordered = [...found].sort((a, b) => strength(a) - strength(b));
    const strong = ordered.filter((entry) => strength(entry) < 3).length;
    if (strong > PRS_READ) limits.push({ why: `only ${PRS_READ} of the ${strong} PR/MRs it names are read`, advice: "check the others yourself" });
    for (const [url, set] of ordered.slice(0, PRS_READ)) {
      if (this.stopped) break;
      try {
        const d = await prDetails(root, remote, url, (command, args, cwd, timeoutMs) => forge.exec(command as "gh" | "glab", args, cwd, timeoutMs));
        const ways = [...set];
        if (d.fork) {
          // A fork's PR/MR is not the project's work. One the card points at is said, never dropped.
          if (set.has("run") || set.has("link") || set.has("closes_issue")) limits.push({ why: `${d.label} is from a fork, or the forge does not name its repository, so it is not counted`, advice: elsewhere });
          continue;
        }
        const tie = judgeTie(index, task, { url: d.url, head: d.head, title: d.title }, ways);
        const checks = d.checks ? { state: d.checks.state === "passing" && !d.verified ? ("none" as const) : d.checks.state, passed: d.checks.passed, failing: d.checks.failing } : null;
        prs.push({
          url: d.url,
          label: d.label,
          state: d.state,
          title: d.title,
          base: d.base,
          head: d.head,
          headSha: d.head_sha,
          mergeSha: d.merge_sha,
          mergedAt: d.merged_at,
          createdAt: d.created_at,
          checks,
          review: d.review,
          merge: d.merge,
          ways,
          own: tie.own,
          doubts: tie.doubts,
          theirs: tie.theirs,
          elsewhere: d.state === "merged" && d.base !== trunk && set.has("id_in_title"),
          pushedAfter: "",
        });
      } catch (error) {
        unknown.push(`${url}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    // Work pushed to a PR/MR's branch after its merge is not in the target branch. A branch may have
    // had several merged PR/MRs: its tip is merged work when it is the head of one the verdict verifies
    // (target branch, checks, review: verdict.ts), and else came after the latest of them. No other
    // PR/MR vouches for it: one merged elsewhere, or one nobody checks, would clear the hold.
    const byHead = new Map<string, PrFact[]>();
    for (const pr of prs) {
      if (pr.state !== "merged" || !named(pr) || !mergedSince(pr, task.created) || !pr.headSha) continue;
      if (!SAFE_BRANCH.test(pr.head) || pr.head === trunk || pr.head === project.trunk) continue;
      // A branch other cards plan on moves with their work.
      if (index.branches.get(`${task.project}\n${pr.head}`)?.some((id) => id !== task.id)) continue;
      byHead.set(pr.head, [...(byHead.get(pr.head) ?? []), pr]);
    }
    for (const [head, merges] of byHead) {
      const latest = [...merges].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0]!;
      const tip = await tipOf(head);
      if (tip === undefined) unknown.push(`whether commits were pushed to ${head} after ${latest.label} could not be read`);
      else if (tip && !merges.some((pr) => pr.headSha === tip)) latest.pushedAfter = tip;
    }
    const read = facts(trunk, prs);
    // A PR/MR tied some other way is among the facts already.
    read.mentions = mentions.filter((m) => !prs.some((pr) => pr.url === m.url));
    if (gone !== undefined) read.gone = await this.gatherGone(root, task, read, gone, index, project.trunk, tipOf);
    await this.cover(space, task, read);
    // Last, so the history read is the newest thing a verdict stands on.
    const latest = merged(read)
      .filter((pr) => pr.own && mergedSince(pr, task.created))
      .map((pr) => pr.mergedAt)
      .sort()
      .at(-1);
    if (latest) read.scope = await this.scope(space, task.id, latest);
    return read;
  }

  /**
   * What only a hold whose agent is gone asks: whether the branches of the card's merges, or the run's
   * own, hold commits no merge carries into the target branch, and whether the stage build recorded on
   * the card holds the merges. It reads the facts and writes none of them (GoneFacts).
   */
  private async gatherGone(
    root: string,
    task: Task,
    read: CardFacts,
    stop: string,
    index: TieIndex,
    projectTrunk: string | undefined,
    tipOf: (head: string) => Promise<string | undefined>,
  ): Promise<GoneFacts> {
    const out: GoneFacts = { stop, unknown: [], pushed: [], apks: [] };
    const trunk = read.trunk;
    const onwards = (head: string) => head === trunk || head === projectTrunk;
    // Merges that are the card's work. A mention alone vouches for no branch and holds none: a release
    // branch listing the card moves on for good.
    const byHead = new Map<string, PrFact[]>();
    for (const pr of read.prs) {
      if (pr.state !== "merged" || !(named(pr) || cardsOwn(pr)) || !mergedSince(pr, task.created) || !pr.headSha) continue;
      if (!SAFE_BRANCH.test(pr.head) || onwards(pr.head)) continue;
      if (index.branches.get(`${task.project}\n${pr.head}`)?.some((id) => id !== task.id)) continue;
      byHead.set(pr.head, [...(byHead.get(pr.head) ?? []), pr]);
    }
    for (const [head, merges] of byHead) {
      const latest = [...merges].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0]!;
      const tip = await tipOf(head);
      if (tip === undefined) out.unknown.push(`whether commits were pushed to ${head} after ${latest.label} could not be read`);
      else if (tip && !merges.some((pr) => pr.headSha === tip)) out.pushed.push({ label: latest.label, branch: head, tip });
    }
    const branch = task.run_branch;
    if (branch && SAFE_BRANCH.test(branch) && !onwards(branch) && !byHead.has(branch)) {
      const tip = await tipOf(branch);
      // Said as it is by an open PR/MR of the card, or carried by a merge into the target branch with that head.
      const carried = read.prs.some((pr) => pr.head === branch && (((pr.state === "open" || pr.state === "draft") && named(pr)) || (pr.state === "merged" && pr.base === trunk && pr.headSha === tip)));
      if (tip === undefined) out.unknown.push(`whether ${branch} holds commits outside the PR/MRs could not be read`);
      // A tip the checkout does not hold, or that git cannot place, counts as not merged.
      else if (tip && !carried && !(await this.inBranch(root, tip, trunk))) out.ahead = { branch, tip };
    }
    const sha = task.delivery?.stage_sha;
    const merges = read.prs.filter((pr) => ofCard(pr, trunk) && pr.state === "merged" && pr.base === trunk && mergedSince(pr, task.created));
    if (!sha || !merges.length) return out;
    const answers: { pr: PrFact; holds: StageHolds }[] = [];
    for (const pr of merges) answers.push({ pr, holds: await stageHolds(this.options.git, root, pr.mergeSha, sha) });
    const missing = answers.find((a) => a.holds === "no") ?? answers.find((a) => a.holds === "unknown");
    out.stage = { sha, holds: missing?.holds ?? "yes", ...(missing ? { missing: { label: missing.pr.label, sha: missing.pr.mergeSha } } : {}) };
    return out;
  }

  private async inBranch(root: string, commit: string, trunk: string): Promise<boolean> {
    if (!trunk) return false;
    const result = await this.options.git.run(root, ["merge-base", "--is-ancestor", commit, `origin/${trunk}`], 10_000).catch(() => undefined);
    return Boolean(result && !result.timedOut && result.code === 0);
  }

  private async scope(space: SpaceEntry, taskId: string, mergedAt: string): Promise<Scope> {
    const loaded = space.sync.plan.entities.get(taskId);
    if (!loaded || loaded.entity.type !== "task") return { unknown: "the card is not in the plan", acted: "" };
    return scopeSince(this.options.git, space.sync.root, loaded.path, mergedAt, hasLiveRun(loaded.entity));
  }

  /** The checkout's default branch, for a project that names no trunk; "" when git does not say. */
  private async defaultBranch(root: string): Promise<string> {
    const result = await this.options.git.run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 10_000).catch(() => undefined);
    return result && result.code === 0 && !result.timedOut ? result.stdout.trim().replace(/^origin\//, "") : "";
  }
}
