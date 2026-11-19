import type { Task } from "../../shared/model.ts";
import type { GitRunner } from "../sync/git.ts";
import { SAFE_BRANCH } from "../sync/git.ts";
import type { ForgeCli, PrState } from "../tracker/forge.ts";

/**
 * Which branch and workspace a start uses (05-architecture.md, What a start sends):
 * - a task that never ran: its planned branch when no branch of that name exists. One that exists
 *   belongs to no run of this task (work done outside the dashboard, or an older use of the name), so
 *   the person chooses (`existing`): when its work is merged (its latest PR/MR merged, or the branch
 *   merged into the trunk) the task is marked done or starts on the planned name with a suffix; when it
 *   is not, the start continues on it or takes the suffix. Without a choice nothing starts;
 * - a task whose previous run's PR/MR was merged: a fresh branch from the base, the planned name
 *   with a numeric suffix, never the merged one;
 * - a released run whose PR/MR is open, was closed without a merge, or never existed: the same
 *   branch, in the previous run's workspace when it is on this machine and its agent is not working,
 *   else a checkout of the branch (or a branch-off with that name when it exists nowhere);
 * - when the previous PR/MR's state cannot be told: refused, never guessed;
 * - a previous run on the trunk (a tracked checkout): a fresh task branch in a new worktree, as after
 *   a merge; the trunk is never a task's branch, and a person's own checkout is never reused.
 */

export type BranchPlan =
  | {
      ok: true;
      branch: string;
      workspace: { kind: "new"; action: "branch-off" | "checkout" } | { kind: "reuse"; workspaceId: string };
      /** What a person hears about the branch: "(continues anna's released run; …)". */
      note: string;
      /** The previous run's open PR/MR the new agent continues, if any. */
      continuesPr?: string;
      /** The branch holds work no run of this task made (an existing branch continued): the agent reads it first. */
      continues?: true;
    }
  | { ok: false; error: string; existing?: ExistingBranch };

/**
 * A branch of the planned name that already exists for a task that never ran (03-model.md, Branch
 * names): where it is, whether its work is merged, and what a start may do with it.
 */
export interface ExistingBranch {
  branch: string;
  /** Where it is, as a person reads it: "on this Mac", "on origin", "checked out in /path". */
  where: string[];
  /** Its work is merged (its latest PR/MR merged, or the branch merged into the trunk); undefined: cannot tell. */
  merged: boolean | undefined;
  /** Its latest PR/MR, if the forge named one. */
  pr?: { label: string; url: string; state: PrState; mergedAt?: string };
  /** The trunk it was merged into, when one took it in through a merge. */
  inTrunk?: string;
  /** The branch a fresh run takes: the planned name with the first free numeric suffix; "" when none is free. */
  fresh: string;
  /** Why the start cannot continue on it; "" when it can. */
  cannotContinue: string;
}

export interface PreviousWorkspace {
  workspaceId: string;
  /** The previous run's agent status in Paseo; undefined when it is gone, "unknown" when Paseo did not answer. */
  agentStatus?: string;
  /** Paseo's `workspaceKind`; anything but `worktree` (a person's own checkout) is never reused. */
  kind?: string;
  /** Its title in Paseo, as the start confirmation names it. */
  title?: string;
}

export interface BranchInput {
  task: Task;
  planned: string;
  /** The project's checkout on this machine; without it nothing can be looked up and nothing starts. */
  root: string | undefined;
  remote: string;
  host: string;
  git: GitRunner;
  forge: ForgeCli;
  /** The previous run's workspace on this machine, if it still exists. */
  previous?: PreviousWorkspace;
  /**
   * The project's trunk names (the task's base, space.yaml's trunk, the checkout's origin/HEAD): a
   * run on one of them never continues, and no start ever runs on one.
   */
  trunks?: string[];
  /** One deadline for every lookup of the decision (05-architecture.md: default 5 s). */
  deadline?: number;
  now?: () => number;
  /**
   * Where the answers of the network lookups (origin's branches, a branch's PRs/MRs) are kept for a
   * while. Every answer looked up is kept; only with `reuseLookups`, which only the start
   * confirmation sets, does the decision answer from it: a start always asks again.
   */
  cache?: LookupCache;
  reuseLookups?: boolean;
  /**
   * For a task that never ran whose planned branch exists: what the person chose in the start
   * confirmation. Undefined: such a start is refused with what the branch holds, and nothing starts.
   */
  existing?: "continue" | "fresh";
}

const LOOKUP_TTL_MS = 60_000;

/**
 * The start's network lookups, kept for a minute: opening the confirmation again, or switching to the
 * task another one waits for, does not wait for origin or the forge each time, and a start's own
 * lookups replace what it shows next. A lookup still under way is shared; one that could not tell is
 * not kept.
 */
export class LookupCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = LOOKUP_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** The kept answer while it is under a minute old, else `load`'s; `fresh` always loads, and keeps that. */
  get<T>(key: string, load: () => Promise<T | undefined>, fresh = false): Promise<T | undefined> {
    const kept = this.entries.get(key);
    if (!fresh && kept && this.now() - kept.at < this.ttlMs) return kept.value as Promise<T | undefined>;
    for (const [other, entry] of this.entries) if (this.now() - entry.at >= this.ttlMs) this.entries.delete(other);
    const value = load().then(
      (answer) => {
        if (answer === undefined && this.entries.get(key)?.value === value) this.entries.delete(key);
        return answer;
      },
      (error: unknown) => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { at: this.now(), value });
    return value;
  }
}

const WORKING = new Set(["running", "initializing"]);

export interface KnownBranches {
  /** On this Mac or on origin. */
  has(branch: string): boolean;
  /** A branch of the checkout itself. */
  local(branch: string): boolean;
  /** The commit origin's branch points at, or undefined when origin has no such branch. */
  origin(branch: string): string | undefined;
}

/** The checkout's local branches and its origin's; undefined when either cannot be read in time. */
export async function knownBranches(git: GitRunner, root: string, left: () => number): Promise<KnownBranches | undefined> {
  if (left() <= 0) return undefined;
  const local = await git.run(root, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"], left());
  if (local.code !== 0 || local.timedOut || left() <= 0) return undefined;
  // Exit 0 with no line means "no such branch"; any failure (network, login, time) means "cannot tell".
  const remote = await git.run(root, ["ls-remote", "--heads", "origin"], left());
  if (remote.code !== 0 || remote.timedOut) return undefined;
  const mine = new Set(local.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const theirs = new Map<string, string>();
  for (const line of remote.stdout.split("\n")) {
    const [sha, ref] = line.split("\t").map((part) => part.trim());
    if (sha && ref?.startsWith("refs/heads/")) theirs.set(ref.slice("refs/heads/".length), sha);
  }
  return { has: (branch) => mine.has(branch) || theirs.has(branch), local: (branch) => mine.has(branch), origin: (branch) => theirs.get(branch) };
}

/**
 * Which worktree of the checkout has the branch checked out (the checkout itself included): `path` is
 * empty when none does; undefined when git did not answer in time.
 */
export async function checkedOutIn(git: GitRunner, root: string, branch: string, timeoutMs: number): Promise<{ path: string } | undefined> {
  if (timeoutMs <= 0) return undefined;
  const listed = await git.run(root, ["worktree", "list", "--porcelain"], timeoutMs);
  if (listed.code !== 0 || listed.timedOut) return undefined;
  let path = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}` && path) return { path };
  }
  return { path: "" };
}

/**
 * The trunk that took every known tip of the branch (its local one and origin's) in through a merge,
 * as this checkout's `origin/<trunk>` has it (nothing is fetched): each tip is an ancestor of it and
 * not on its first-parent line. A tip on that line is a trunk commit: a branch with nothing of its
 * own (made, nothing committed yet) or one fast-forwarded into the trunk, which ancestry cannot tell
 * apart, so it is not called merged; the forge's merged PR/MR still tells the fast-forward. A tip git
 * cannot compare (origin's commit not fetched here, no such trunk ref) proves nothing, and then no
 * trunk is named. Null: git ran out of the deadline before it could tell, which is not "not merged".
 */
export async function trunkHolding(git: GitRunner, root: string, branch: string, known: KnownBranches, trunks: string[], left: () => number): Promise<string | undefined | null> {
  const tips = [known.local(branch) ? `refs/heads/${branch}` : undefined, known.origin(branch)].filter((tip): tip is string => Boolean(tip));
  if (!tips.length) return undefined;
  /** True: merged in; false: not, or git cannot compare it; null: out of time. */
  const mergedInto = async (tip: string, trunk: string): Promise<boolean | null> => {
    if (left() <= 0) return null;
    const sha = await git.run(root, ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`], left());
    if (sha.timedOut || left() <= 0) return null;
    const commit = sha.code === 0 ? sha.stdout.trim() : "";
    if (!commit) return false;
    // Exit 0: an ancestor; 1: not one; anything else (no such ref): cannot compare.
    const ancestor = await git.run(root, ["merge-base", "--is-ancestor", commit, `refs/remotes/origin/${trunk}`], left());
    if (ancestor.timedOut || (ancestor.code === 0 && left() <= 0)) return null;
    if (ancestor.code !== 0) return false;
    // The trunk's first-parent line down to the tip: on that line, the oldest commit listed has the
    // tip as its first parent (none is listed when the tip is the trunk's own head).
    const line = await git.run(root, ["rev-list", "--first-parent", "--parents", `${commit}..refs/remotes/origin/${trunk}`], left());
    if (line.timedOut) return null;
    if (line.code !== 0) return false;
    const oldest = line.stdout.trim().split("\n").at(-1)?.trim();
    return Boolean(oldest) && oldest!.split(" ")[1] !== commit;
  };
  let ranOut = false;
  for (const trunk of trunks) {
    if (!SAFE_BRANCH.test(trunk) || trunk === branch) continue;
    let all = true;
    for (const tip of tips) {
      const merged = await mergedInto(tip, trunk);
      if (merged === true) continue;
      if (merged === null) ranOut = true;
      all = false;
      break;
    }
    if (all) return trunk;
  }
  return ranOut ? null : undefined;
}

/** The branch origin/HEAD points at in this checkout (its default branch), or undefined. */
export async function originHead(git: GitRunner, root: string, timeoutMs = 2_000): Promise<string | undefined> {
  const result = await git.run(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], timeoutMs);
  const ref = result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  return branch && SAFE_BRANCH.test(branch) ? branch : undefined;
}

/** A project's trunk names: the given ones (task base, space.yaml's trunk) and the checkout's origin/HEAD. */
export async function trunkNames(git: GitRunner, root: string | undefined, given: (string | undefined)[]): Promise<string[]> {
  const head = root ? await originHead(git, root).catch(() => undefined) : undefined;
  return [...new Set([...given, head].filter((name): name is string => Boolean(name)))];
}

export async function decideBranch(input: BranchInput): Promise<BranchPlan> {
  const now = input.now ?? Date.now;
  const deadline = input.deadline ?? now() + 5_000;
  const left = () => deadline - now();
  const late: BranchPlan = { ok: false, error: "Looking up the branch took too long (git or the forge is slow); try the start again." };
  const { task, planned } = input;
  const name = `«${task.title}» (${task.id})`;
  if (!input.root) return { ok: false, error: `Project ${task.project} has no checkout known on this Mac; open it in Paseo first.` };
  const root = input.root;
  const unknown: BranchPlan = { ok: false, error: `Cannot tell which branches exist in ${task.project} (git or its origin did not answer); check the network or the login, and try again.` };

  const trunks = new Set((input.trunks ?? []).filter(Boolean));
  const lookup = <T>(key: string, load: () => Promise<T | undefined>) => (input.cache ? input.cache.get(key, load, !input.reuseLookups) : load());
  const branchesOf = () => lookup(`branches\n${root}`, () => knownBranches(input.git, root, left));

  if (!task.run_id) {
    if (left() <= 0) return late;
    const branches = await branchesOf();
    if (!branches) return unknown;
    if (!branches.has(planned)) return { ok: true, branch: planned, workspace: { kind: "new", action: "branch-off" }, note: "" };
    // A fresh run needs only the names taken: it never waits on the forge, and says the same whatever the forge says.
    if (input.existing === "fresh") {
      const suffix = suffixed(planned, "", branches);
      if (!suffix) return { ok: false, error: `No free branch name after ${planned}-99; set the task's branch.` };
      return { ok: true, branch: suffix, workspace: { kind: "new", action: "branch-off" }, note: `a fresh branch: ${planned} already exists` };
    }
    // The forge's PRs/MRs, the worktrees and the trunk's history do not depend on each other. Each
    // keeps to the deadline; one that ran out cannot tell, which leaves a fresh run to choose.
    const [prs, holder, inTrunk] = await Promise.all([
      lookup(`prs\n${root}\n${input.remote}\n${planned}`, () => input.forge.byBranch(root, input.remote, planned, left())),
      checkedOutIn(input.git, root, planned, left()).catch(() => undefined),
      trunkHolding(input.git, root, planned, branches, [...trunks], left).catch(() => undefined),
    ]);
    return existingBranch(task, planned, branches, { prs, holder, inTrunk }, input.existing);
  }

  const previous = task.run_branch;
  if (!previous || !SAFE_BRANCH.test(previous)) return { ok: false, error: `${name} ran before on a branch that is not usable (${JSON.stringify(previous ?? "")}).` };
  if (trunks.has(previous)) {
    // A tracked checkout on the trunk: its work is the trunk's, so the next start begins a task
    // branch of its own, never on the trunk and never in that checkout.
    if (left() <= 0) return late;
    const branches = await branchesOf();
    if (!branches) return unknown;
    return fresh(planned, previous, branches, `a fresh branch: the previous run worked on the trunk ${previous}`);
  }
  if (left() <= 0) return late;
  // The forge's PRs/MRs and origin's branches do not depend on each other: both are asked at once.
  const [prs, branches] = await Promise.all([
    lookup(`prs\n${root}\n${input.remote}\n${previous}`, () => input.forge.byBranch(root, input.remote, previous, left())),
    branchesOf(),
  ]);
  if (!prs) {
    return {
      ok: false,
      error: `Cannot tell whether the previous run's PR/MR on ${previous} was merged (gh or glab did not answer here in time); start it in Paseo, or check the CLI's login.`,
    };
  }
  const latest = prs[0];
  if (!branches) return left() <= 0 ? late : unknown;

  if (latest?.state === "merged") {
    // A new run never starts on top of merged work: the planned name with the first free suffix.
    return fresh(planned, previous, branches, `a fresh branch: ${latest.label} of the previous run was merged`, false);
  }

  const elsewhere = task.run_host && task.run_host !== input.host;
  const note = [
    `continues ${task.run_by ?? "the previous"}'s released run`,
    latest?.state === "open" ? `${latest.label} stays open` : latest?.state === "closed" ? `${latest.label} was closed without a merge; open a new one` : "",
    elsewhere ? `their agent on ${task.run_host} may still push to it` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const continuesPr = latest?.state === "open" ? latest.url : undefined;

  if (input.previous && !elsewhere && (input.previous.kind ?? "worktree") === "worktree") {
    if (input.previous.agentStatus === "unknown") {
      return { ok: false, error: `Cannot tell whether the previous run's agent still works in ${task.project}:${previous}; try the start again.` };
    }
    if (input.previous.agentStatus && WORKING.has(input.previous.agentStatus)) {
      return { ok: false, error: `The previous run's agent still works in ${task.project}:${previous}; stop the previous run's agent first.` };
    }
    return { ok: true, branch: previous, workspace: { kind: "reuse", workspaceId: input.previous.workspaceId }, note, continuesPr };
  }
  return { ok: true, branch: previous, workspace: { kind: "new", action: branches.has(previous) ? "checkout" : "branch-off" }, note, continuesPr };
}

/**
 * A branch no run used: the planned name itself when `plannedFirst` and it is free, else the planned
 * name with the first free numeric suffix; never the previous run's branch.
 */
function fresh(planned: string, previous: string, branches: { has(branch: string): boolean }, note: string, plannedFirst = true): BranchPlan {
  if (plannedFirst && planned !== previous && !branches.has(planned)) return { ok: true, branch: planned, workspace: { kind: "new", action: "branch-off" }, note };
  const candidate = suffixed(planned, previous, branches);
  if (candidate) return { ok: true, branch: candidate, workspace: { kind: "new", action: "branch-off" }, note };
  return { ok: false, error: `No free branch name after ${planned}-99; set the task's branch.` };
}

/** The planned name with the first free numeric suffix (`-2`, `-3`, …), never `previous`; "" when none up to 99 is free. */
function suffixed(planned: string, previous: string, branches: { has(branch: string): boolean }): string {
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${planned}-${n}`;
    if (candidate !== previous && SAFE_BRANCH.test(candidate) && !branches.has(candidate)) return candidate;
  }
  return "";
}

/**
 * A task that never ran meets a branch of its planned name (03-model.md, Branch names). Its work is
 * merged when the branch's latest PR/MR is merged, or when the trunk took it in through a merge: the
 * start then never continues on it, and the person marks the task done or takes the suffixed name.
 * Otherwise the person continues on it (unless another worktree holds it, or the forge or git could
 * not tell) or takes the suffixed name, which decideBranch gives without these lookups. Without a
 * choice nothing starts.
 */
function existingBranch(
  task: Task,
  planned: string,
  branches: KnownBranches,
  found: { prs: Awaited<ReturnType<ForgeCli["byBranch"]>>; holder: { path: string } | undefined; inTrunk: string | undefined | null },
  choice: "continue" | undefined,
): BranchPlan {
  const name = `«${task.title}» (${task.id})`;
  const latest = found.prs?.[0];
  // Merged when the forge or the trunk says so; not merged only when both answered.
  const merged = latest?.state === "merged" || found.inTrunk ? true : found.prs && found.inTrunk !== null ? false : undefined;
  const where = [
    branches.local(planned) ? "on this Mac" : "",
    branches.origin(planned) ? "on origin" : "",
    found.holder?.path ? `checked out in ${found.holder.path}` : "",
  ].filter(Boolean);
  const freshName = suffixed(planned, "", branches);
  const cannotContinue = merged
    ? "its work is merged already"
    : merged === undefined
      ? found.prs
        ? "git did not answer in time, so whether it was merged into the trunk cannot be told"
        : "gh or glab did not answer, so whether its PR/MR was merged cannot be told"
      : !found.holder
        ? "git did not say in time whether another worktree has it checked out"
        : found.holder.path
          ? `it is checked out in ${found.holder.path}, where git keeps it while it is; switch that checkout to another branch first`
          : "";
  const existing: ExistingBranch = {
    branch: planned,
    where,
    merged,
    ...(latest ? { pr: { label: latest.label, url: latest.url, state: latest.state, ...(latest.mergedAt ? { mergedAt: latest.mergedAt } : {}) } } : {}),
    ...(found.inTrunk ? { inTrunk: found.inTrunk } : {}),
    fresh: freshName,
    cannotContinue,
  };
  const what = latest?.state === "merged" ? `${latest.label} was merged` : found.inTrunk ? `it was merged into origin/${found.inTrunk}` : "";
  const whereText = where.length ? ` (${where.join("; ")})` : "";

  if (choice === "continue" && !cannotContinue) {
    const open = latest?.state === "open" ? latest : undefined;
    return {
      ok: true,
      branch: planned,
      workspace: { kind: "new", action: "checkout" },
      note: [`continues the existing branch ${where.join(" and ")}, which no run of this task made`, open ? `${open.label} stays open` : ""].filter(Boolean).join("; "),
      ...(open ? { continuesPr: open.url } : {}),
      continues: true,
    };
  }
  const suffix = freshName ? `start it on ${freshName}` : "set the task's branch to another name";
  if (merged) {
    return {
      ok: false,
      error: `A branch ${planned} already exists in ${task.project}${whereText} and its work is merged: ${what}. Mark ${name} done if that was its work, or ${suffix} (Paseo Dash's start confirmation offers both).`,
      existing,
    };
  }
  const refused = choice === "continue" ? ` It cannot be continued: ${cannotContinue}.` : "";
  const offer = cannotContinue ? `${suffix[0]!.toUpperCase()}${suffix.slice(1)} from Paseo Dash's start confirmation, since it cannot be continued now: ${cannotContinue}.` : `Choose in Paseo Dash's start confirmation: continue on it, or ${suffix}.`;
  return {
    ok: false,
    error: `A branch ${planned} already exists in ${task.project}${whereText} and belongs to no run of ${name}.${refused || ` ${offer}`}`,
    existing,
  };
}
