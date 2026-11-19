import { isAbsolute, join, relative } from "node:path";
import type { GitRunner } from "../sync/git.ts";
import type { PaseoApi } from "../paseo.ts";
import { originHead } from "../runner/branch.ts";
import type { CodeFile } from "./codemap.ts";
import type { RunRecord, RunStore } from "../runner/runs.ts";

/**
 * What each running task's agent touches, live. The
 * agent's timeline stream gives every tool call it makes itself, with its path or command; git
 * gives the files the run really changed, shell writes and sub-agents' edits included. Kept in
 * memory only: after a reload a run is followed again, its tail refetched and git read.
 *
 * Invariants:
 * - A run is followed from the moment it has an agent (the runner's `onAgent`: the first turn starts
 *   before the run knows its agent, so no turn hook can), and on every later turn and reconcile pass.
 * - A run is in `followed` only while its subscription is live: an error, a throw, another agent on
 *   the run, a stopped run or a lost data ownership unfollows it, and the next turn or reconcile
 *   pass follows it again.
 * - A call's state is the merge of all its events in time order, from the stream or a refetched
 *   page alike: the latest status, and the latest detail that says something.
 * - `changed` is git's latest answer (read when following starts and at every turn's end; an older
 *   answer never replaces a newer one) plus the edits and writes completed after it.
 * - Paths are relative to the repository root, which is known before the first event is taken.
 * - The change revision moves only when what a screen shows moves: the latest call's operation,
 *   target or start (a screen shows its age), or `changed`; a status alone does not move it.
 *
 * Git's base is the fork point with the checkout's default branch (`origin/HEAD`), not the task's own
 * base branch; without `origin/HEAD` it is HEAD, so committed work then no longer counts. A failed
 * run whose agent waits is followed again only when its next turn starts.
 */

/** What a call does, as a person reads it. */
export type CallOp = "read" | "edit" | "write" | "shell" | "search" | "fetch" | "agent" | "tool";

export interface CallState {
  callId: string;
  name: string;
  status: string;
  op: CallOp;
  /** A path relative to the repository root, a command's program, a query, a host or a sub-agent's task. */
  target: string;
  /** The path is inside the repository (an edit or a write of the run's own files). */
  inRepo: boolean;
  /**
   * When the call was first seen and last updated, ms since the epoch. A call known only from a
   * refetched page (after a reload) carries its last update's time in both.
   */
  startedAt: number;
  at: number;
}

export interface RunLive {
  /** The latest call, or null before the agent made one. */
  now: { op: CallOp; target: string; status: string; at: string } | null;
  /** Files the run changed (git's latest answer, plus edits completed since), sorted, at most CHANGED_MAX. */
  changed: string[];
  /** How many more changed files there are beyond `changed`. */
  more: number;
}

export interface FollowerOptions {
  runs: () => RunStore | undefined;
  paseo: () => PaseoApi | undefined;
  git: GitRunner;
  /** Something a screen shows changed; called at most once per `throttleMs`. */
  onChange?: () => void;
  throttleMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const TAIL = 100;
/** Repository files a run remembers as touched, for its code map. */
const TOUCHED_MAX = 300;
const GIT_MS = 10_000;
const TARGET_CHARS = 120;
export const CHANGED_MAX = 200;
/** The prompt a person or another agent sends shows as a call too; it is not the agent's work. */
const PROMPT_CALLS = new Set(["agent_message"]);

type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (value: string) => (value.length <= TARGET_CHARS ? value : `${value.slice(0, TARGET_CHARS - 1)}…`);

/** Real paths on macOS put temporary directories under /private; both spellings are the same file. */
function bare(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

/**
 * A path an agent reported, relative to the repository root, or null when it lies outside. Claude
 * reports absolute paths, Codex paths relative to its cwd.
 */
export function repoPath(path: string, cwd: string, root: string): string | null {
  if (!path) return null;
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  const inside = relative(bare(root), bare(absolute));
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  return inside;
}

/** The program a shell command runs: its first word after any `cd …&&` and variable assignments. */
export function program(command: string): string {
  const parts = command.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
  const first = parts.find((part) => !/^cd\s/.test(part)) ?? parts[0] ?? "";
  const words = first.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return words[0] ?? "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A call's op and target from one event's detail, or null when the detail says nothing yet. */
function described(detail: unknown, cwd: string, root: string): Pick<CallState, "op" | "target" | "inRepo"> | null {
  const d = (detail && typeof detail === "object" ? detail : {}) as Json;
  switch (d.type) {
    case "read":
    case "edit":
    case "write": {
      const raw = text(d.filePath);
      if (!raw) return null;
      const inside = repoPath(raw, cwd, root);
      // A path of the run stays whole: it is compared with what git lists.
      return { op: d.type, target: inside ?? clip(raw), inRepo: inside !== null };
    }
    case "shell": {
      const command = text(d.command);
      return command ? { op: "shell", target: clip(program(command)), inRepo: false } : null;
    }
    case "search":
      return { op: "search", target: clip(text(d.query)), inRepo: false };
    case "fetch":
      return { op: "fetch", target: clip(hostOf(text(d.url))), inRepo: false };
    case "sub_agent":
      return { op: "agent", target: clip(text(d.description) || text(d.subAgentType)), inRepo: false };
    default:
      // `unknown`, `plain_text`, `plan` and the rest: nothing a file map can use.
      return null;
  }
}

/**
 * Merges one event of a call into what is known of it: the status of the latest event, the detail
 * of the latest event that says something. A Claude call starts as `unknown` and gets its path a
 * moment later; a Claude sub-agent's last event falls back to `unknown` (the probe, findings 3, 8).
 */
export function mergeCall(previous: CallState | undefined, item: Json, at: number, cwd: string, root: string): CallState {
  const known = described(item.detail, cwd, root);
  const name = text(item.name) || previous?.name || "tool";
  const base = known ?? (previous ? { op: previous.op, target: previous.target, inRepo: previous.inRepo } : { op: "tool" as const, target: clip(name), inRepo: false });
  return {
    callId: text(item.callId),
    name,
    status: text(item.status) || previous?.status || "running",
    ...base,
    startedAt: previous ? Math.min(previous.startedAt, at) : at,
    at: previous ? Math.max(previous.at, at) : at,
  };
}

interface Followed {
  runId: string;
  agentId: string;
  cwd: string;
  root: string;
  release: (() => void) | undefined;
  calls: Map<string, CallState>;
  /**
   * The repository files the agent read, edited or wrote, with the last time, newest last; kept past
   * git's reads (unlike `calls`), at most TOUCHED_MAX. What a code map draws besides the changed files.
   */
  touched: Map<string, { op: "read" | "edit" | "write"; at: number }>;
  /** Files git showed changed at its latest read, and when it was asked. */
  git: { files: string[]; at: number } | undefined;
  /** What a screen showed last, to move the revision only when it moves. */
  shown: string;
}

export class RunFollower {
  private readonly options: FollowerOptions;
  private readonly followed = new Map<string, Followed>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastChange = 0;
  /** Counts what a screen shows; the change token reads it. */
  revision = 0;

  constructor(options: FollowerOptions) {
    this.options = options;
  }

  private time(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Bumps the revision now, or once the throttle allows; never more than once per window. */
  private changed(): void {
    if (this.timer) return;
    const wait = (this.options.throttleMs ?? 2_000) - (this.time() - this.lastChange);
    const bump = () => {
      this.timer = undefined;
      this.lastChange = this.time();
      this.revision += 1;
      this.options.onChange?.();
    };
    if (wait <= 0) bump();
    else {
      this.timer = setTimeout(bump, wait);
      this.timer.unref?.();
    }
  }

  /** Moves the revision if what a screen shows of this run moved. */
  private shown(entry: Followed): void {
    const view = this.viewOf(entry);
    const shown = JSON.stringify([view.now?.op, view.now?.target, view.now?.at, view.changed, view.more]);
    if (shown === entry.shown) return;
    entry.shown = shown;
    this.changed();
  }

  private current(entry: Followed): boolean {
    return this.followed.get(entry.runId) === entry;
  }

  isFollowing(runId: string): boolean {
    return this.followed.has(runId);
  }

  /**
   * Follows a run's agent: reads the repository root, subscribes, refetches the tail once the
   * subscription is ready (a turn may have started before it, the probe's finding 10), and reads git.
   * Idempotent for the same agent; another agent on the run replaces the old one's following.
   */
  async follow(run: RunRecord, cwd?: string): Promise<void> {
    const paseo = this.options.paseo();
    if (!paseo || !run.agentId) return;
    const existing = this.followed.get(run.run_id);
    if (existing?.agentId === run.agentId) return;
    if (existing) this.unfollow(run.run_id);
    const entry: Followed = { runId: run.run_id, agentId: run.agentId, cwd: cwd ?? "", root: cwd ?? "", release: undefined, calls: new Map(), touched: new Map(), git: undefined, shown: "" };
    this.followed.set(run.run_id, entry);
    try {
      if (!entry.cwd) {
        // From the runner: the agent's cwd comes from its snapshot.
        const refreshed = await paseo.agents.ref(run.agentId).refresh();
        entry.cwd = entry.root = (refreshed?.agent as { cwd?: string } | undefined)?.cwd ?? "";
        if (!this.current(entry)) return;
        if (!entry.cwd) throw new Error("the agent reports no directory");
      }
      const top = await this.options.git.run(entry.cwd, ["rev-parse", "--show-toplevel"], GIT_MS);
      if (top.code === 0 && top.stdout.trim()) entry.root = top.stdout.trim();
      if (!this.current(entry)) return;
      const subscription = paseo.agents.ref(run.agentId).timeline.subscribe((message) => this.onMessage(entry, message));
      entry.release = () => subscription();
      if (!this.current(entry)) return entry.release();
      await subscription.ready;
    } catch (error) {
      this.log(`run ${run.run_id}: following its agent: ${(error as Error).message}`);
      if (this.current(entry)) this.unfollow(run.run_id);
      return;
    }
    await this.backfill(entry);
    if (this.current(entry) && !entry.git) await this.readGit(entry);
  }

  /** Stops following a run and forgets what was seen. */
  unfollow(runId: string): void {
    const entry = this.followed.get(runId);
    if (!entry) return;
    this.followed.delete(runId);
    try {
      entry.release?.();
    } catch {
      // Already released by the daemon.
    }
    this.changed();
  }

  /**
   * Drops every run that is no longer this machine's live run with the same agent: stopped, gone,
   * another attempt's agent, or every run once this plugin no longer owns the data.
   */
  sweep(): void {
    const store = this.options.runs();
    for (const [runId, entry] of [...this.followed]) {
      const run = store?.runs.get(runId);
      if (!run || run.activity === "stopped" || run.agentId !== entry.agentId) this.unfollow(runId);
    }
  }

  stop(): void {
    for (const runId of [...this.followed.keys()]) this.unfollow(runId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Takes one event of a call, from the stream or a refetched page, unless it is older than what is known. */
  private take(entry: Followed, item: Json, timestamp: unknown): void {
    if (item.type !== "tool_call" || PROMPT_CALLS.has(text(item.name))) return;
    const callId = text(item.callId);
    if (!callId) return;
    const parsed = Date.parse(text(timestamp));
    const at = Number.isFinite(parsed) ? parsed : this.time();
    const previous = entry.calls.get(callId);
    if (previous && at < previous.at) return;
    const next = mergeCall(previous, item, at, entry.cwd, entry.root);
    entry.calls.set(callId, next);
    if (next.inRepo && (next.op === "read" || next.op === "edit" || next.op === "write")) {
      entry.touched.delete(next.target);
      entry.touched.set(next.target, { op: next.op, at: next.at });
      if (entry.touched.size > TOUCHED_MAX) entry.touched.delete(entry.touched.keys().next().value!);
    }
  }

  private onMessage(entry: Followed, message: unknown): void {
    if (!this.current(entry)) return;
    const event = ((message ?? {}) as { event?: Json }).event;
    if (!event) return;
    if (event.type === "error") {
      // The SDK releases the observation on an error; the run is followed again on its next turn.
      this.log(`run ${entry.runId}: its timeline subscription failed: ${text(event.error)}`);
      this.unfollow(entry.runId);
      return;
    }
    if (event.type === "subscription_restored" || event.type === "replacement") {
      // History may have been missed meanwhile; the SDK's advice is to refetch it.
      void this.backfill(entry);
      return;
    }
    if (event.type !== "timeline") return;
    this.take(entry, (event.item ?? {}) as Json, event.timestamp);
    this.shown(entry);
  }

  private async backfill(entry: Followed): Promise<void> {
    const paseo = this.options.paseo();
    if (!paseo || !this.current(entry)) return;
    try {
      const page = (await paseo.agents.ref(entry.agentId).timeline.refetch({ direction: "tail", limit: TAIL })) as {
        entries?: { item?: Json; timestamp?: string }[];
      };
      if (!this.current(entry)) return;
      for (const { item, timestamp } of page.entries ?? []) if (item) this.take(entry, item, timestamp);
      this.shown(entry);
    } catch (error) {
      this.log(`run ${entry.runId}: refetching its timeline: ${(error as Error).message}`);
    }
  }

  /** At a turn's end, git's answer replaces the edits seen during the turn (the probe, findings 7, 9). */
  async turnEnded(runId: string): Promise<void> {
    const entry = this.followed.get(runId);
    if (entry) await this.readGit(entry);
  }

  /**
   * What the run changed according to git: the branch's changes against its fork point with the
   * checkout's default branch, and untracked files. `--no-optional-locks`: the agent may be committing.
   */
  private async readGit(entry: Followed): Promise<void> {
    const at = this.time();
    const run = (args: string[]) => this.options.git.run(entry.root, ["--no-optional-locks", ...args], GIT_MS);
    const head = await originHead(this.options.git, entry.root).catch(() => undefined);
    const fork = head ? await run(["merge-base", "HEAD", `origin/${head}`]) : undefined;
    const base = fork?.code === 0 && fork.stdout.trim() ? fork.stdout.trim() : "HEAD";
    const [diff, untracked] = await Promise.all([run(["diff", "--name-only", "-z", base]), run(["ls-files", "-z", "--others", "--exclude-standard"])]);
    if (diff.code !== 0 || untracked.code !== 0) {
      this.log(`run ${entry.runId}: reading its changed files: ${(diff.stderr || untracked.stderr).trim()}`);
      return;
    }
    // A run unfollowed meanwhile, or a newer answer already in: this one is dropped.
    if (!this.current(entry) || (entry.git && entry.git.at > at)) return;
    const paths = (out: string) => out.split("\0").filter(Boolean);
    entry.git = { files: [...new Set([...paths(diff.stdout), ...paths(untracked.stdout)])].sort(), at };
    // What git now covers needs no keeping: only the latest call and the calls still running stay.
    const latest = this.latest(entry);
    for (const [callId, call] of entry.calls) {
      if (call.at <= at && call !== latest && call.status !== "running") entry.calls.delete(callId);
    }
    this.shown(entry);
  }

  private latest(entry: Followed): CallState | undefined {
    let latest: CallState | undefined;
    for (const call of entry.calls.values()) if (!latest || call.startedAt >= latest.startedAt) latest = call;
    return latest;
  }

  /** Every file the run changed: git's latest answer plus the edits and writes completed since, sorted. */
  private changedAll(entry: Followed): string[] {
    const edited = new Set<string>();
    for (const call of entry.calls.values()) {
      const fresh = !entry.git || call.at > entry.git.at;
      if (fresh && call.status === "completed" && call.inRepo && (call.op === "edit" || call.op === "write")) edited.add(call.target);
    }
    return [...new Set([...(entry.git?.files ?? []), ...edited])].sort();
  }

  private viewOf(entry: Followed): RunLive {
    const latest = this.latest(entry);
    const all = this.changedAll(entry);
    return {
      now: latest ? { op: latest.op, target: latest.target, status: latest.status, at: new Date(latest.startedAt).toISOString() } : null,
      changed: all.slice(0, CHANGED_MAX),
      more: Math.max(0, all.length - CHANGED_MAX),
    };
  }

  /** The latest call of a run, without building its changed files; undefined when it is not followed. */
  nowOf(runId: string): RunLive["now"] | undefined {
    const entry = this.followed.get(runId);
    const latest = entry && this.latest(entry);
    return latest ? { op: latest.op, target: latest.target, status: latest.status, at: new Date(latest.startedAt).toISOString() } : undefined;
  }

  /**
   * For each followed run, the other followed runs of the same repository (`groupOf`, the Paseo
   * project) that changed some of the same files, with those files sorted. Compares every changed
   * file, also beyond the CHANGED_MAX a screen lists.
   */
  overlaps(groupOf: (runId: string) => string | undefined): Map<string, { runId: string; files: string[] }[]> {
    const runs = [...this.followed.keys()].flatMap((runId) => {
      const group = groupOf(runId);
      const entry = this.followed.get(runId);
      const files = new Set(entry ? this.changedAll(entry) : []);
      return group && files.size ? [{ runId, group, files }] : [];
    });
    const out = new Map<string, { runId: string; files: string[] }[]>();
    const add = (runId: string, other: string, files: string[]) => out.set(runId, [...(out.get(runId) ?? []), { runId: other, files }]);
    runs.forEach((a, i) => {
      for (const b of runs.slice(i + 1)) {
        if (a.group !== b.group) continue;
        const shared = [...a.files].filter((file) => b.files.has(file)).sort();
        if (!shared.length) continue;
        add(a.runId, b.runId, shared);
        add(b.runId, a.runId, shared);
      }
    });
    return out;
  }

  /**
   * The files of a run's code map (server/tracker/codemap.ts), with its repository root: every changed
   * file, and the files its agent read that it did not change. An edit git no longer lists (reverted)
   * is not a file of the run. Undefined when the run is not followed.
   */
  codeFiles(runId: string): { root: string; files: CodeFile[] } | undefined {
    const entry = this.followed.get(runId);
    if (!entry) return undefined;
    const iso = (ms: number | undefined) => (ms === undefined ? "" : new Date(ms).toISOString());
    const changed = this.changedAll(entry);
    const set = new Set(changed);
    const files: CodeFile[] = changed.map((path) => ({ path, state: "changed", at: iso(entry.touched.get(path)?.at) }));
    for (const [path, touch] of entry.touched) {
      if (!set.has(path) && touch.op === "read") files.push({ path, state: "read", at: iso(touch.at) });
    }
    return { root: entry.root, files };
  }

  /** What a screen shows of a run, or undefined when it is not followed. */
  view(runId: string): RunLive | undefined {
    const entry = this.followed.get(runId);
    return entry ? this.viewOf(entry) : undefined;
  }
}
