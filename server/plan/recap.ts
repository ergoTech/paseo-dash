import { ENTITY_DIRS } from "../../shared/model.ts";
import type { RecapKind } from "../../shared/recap.ts";
import { git, type GitRunner } from "../sync/git.ts";
import { frontData, parseEntity } from "./document.ts";
import { PLAIN_LOG } from "./run-history.ts";

/**
 * What changed in the plan's tasks over a period, read from the commits of the plugin's clone
 * (05-architecture.md, Recap). A commit's diff of a task file whose first hunk starts at line 1 holds
 * the front matter before the commit (context and removed lines) and after it (context and added
 * lines), so the fields are compared directly: a change made by hand reads like one made through the
 * dashboard. Nothing here writes or stores anything.
 */

export interface PlanChange {
  kind: RecapKind;
  task_id: string;
  title: string;
  project: string;
  /** The commit's committer date (ISO 8601, UTC): when the change became part of this clone's history. */
  at: string;
  /** The person who started the run (`started`); else empty. */
  run_by: string;
  author: string;
  email: string;
  detail: string;
  pr: string;
  /** The commit carries no `Dashboard-Op` trailer: a person edited the plan outside the dashboard. */
  by_hand: boolean;
  /** The commit's place in the history read, oldest 0: commits of one second keep git's order. */
  commit: number;
}

export interface ChangesRead {
  /** Oldest first. */
  changes: PlanChange[];
  /** Set when the commit cap cut the read: the committer date of the oldest commit read. */
  cutAt?: string;
}

/** Commits read per period; a busier period is reported as covered only back to the oldest one read. */
export const MAX_COMMITS = 1_000;
const GIT_MS = 15_000;
const TRAILER = "Dashboard-Op";
const DETAIL_CHARS = 200;
const FIELD = "\x1f";
/**
 * Context lines around a change: a change in a front matter of under this many lines gives a first
 * hunk from line 1 through its closing `---`. Only that hunk is read, so a long brief or handoff is
 * not carried in every commit's diff; a change below it leaves the front matter as it was.
 */
const CONTEXT = 100;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface FileVersions {
  /** The file before the commit; undefined when the commit added it. */
  before?: string;
  /** The file after the commit; undefined when the commit deleted it. */
  after?: string;
}

export interface LoggedCommit {
  at: string;
  author: string;
  email: string;
  dashboard: boolean;
  files: FileVersions[];
}

/**
 * The commits of `git log -p` with the header format of `readChanges`, newest first, each file as
 * the start of its first hunk shows it. A file whose first hunk does not start at line 1 (a change
 * below the front matter), or that has no hunk (binary, a mode change), yields nothing.
 */
export function parseChangesLog(output: string): LoggedCommit[] {
  const commits: LoggedCommit[] = [];
  for (const record of output.split("\0").slice(1)) {
    const lines = record.split("\n");
    const [, date = "", author = "", email = "", trailers = ""] = (lines[0] ?? "").split(FIELD);
    const at = Number.isNaN(Date.parse(date)) ? date : new Date(date).toISOString();
    const files: FileVersions[] = [];
    let file: { before: string[]; after: string[]; added: boolean; deleted: boolean; hunk: boolean; skip: boolean } | undefined;
    const close = () => {
      if (file?.hunk && !file.skip) {
        files.push({ ...(file.added ? {} : { before: file.before.join("\n") }), ...(file.deleted ? {} : { after: file.after.join("\n") }) });
      }
      file = undefined;
    };
    for (const line of lines.slice(1)) {
      if (line.startsWith("diff --git ")) {
        close();
        file = { before: [], after: [], added: false, deleted: false, hunk: false, skip: false };
      } else if (!file || file.skip) {
        continue;
      } else if (line.startsWith("@@")) {
        // Hunk lines start with " ", "-" or "+": "@@" is always a header. A later hunk is past the front matter.
        if (file.hunk) {
          close();
          continue;
        }
        const hunk = HUNK.exec(line);
        file.hunk = true;
        file.skip = !hunk || Number(hunk[1]) > 1 || Number(hunk[2]) > 1;
      } else if (!file.hunk) {
        if (line === "--- /dev/null") file.added = true;
        else if (line === "+++ /dev/null") file.deleted = true;
      } else if (line.startsWith(" ")) {
        file.before.push(line.slice(1));
        file.after.push(line.slice(1));
      } else if (line.startsWith("-")) {
        file.before.push(line.slice(1));
      } else if (line.startsWith("+")) {
        file.after.push(line.slice(1));
      }
    }
    close();
    commits.push({ at, author, email, dashboard: trailers.trim() !== "", files });
  }
  return commits;
}

function scalar(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= DETAIL_CHARS ? flat : `${flat.slice(0, DETAIL_CHARS - 1)}…`;
}

type Front = Record<string, unknown>;

/** A task file's front matter, or undefined for anything else, including a file that does not parse. */
function taskFront(text: string | undefined): Front | undefined {
  if (text === undefined) return undefined;
  try {
    const front = frontData(parseEntity(text));
    return scalar(front.type) === "task" && scalar(front.id) ? front : undefined;
  } catch {
    return undefined;
  }
}

const BLOCKED = /^blocked:/i;

/** The changes between two versions of one task's front matter; `before` undefined: the task is new. */
export function changesOf(before: Front | undefined, after: Front): { kind: RecapKind; detail: string; run_by?: string }[] {
  const out: { kind: RecapKind; detail: string; run_by?: string }[] = [];
  const status = scalar(after.status);
  const was = before ? scalar(before.status) : "";
  const runId = scalar(after.run_id);
  const started = Boolean(runId) && runId !== scalar(before?.run_id);
  if (!before) out.push({ kind: status === "inbox" ? "draft" : "created", detail: status });
  if (started) {
    const where = [scalar(after.run_host) && `on ${scalar(after.run_host)}`, scalar(after.run_branch) && `branch ${scalar(after.run_branch)}`];
    out.push({ kind: "started", detail: where.filter(Boolean).join(", "), run_by: scalar(after.run_by) });
  }
  if (before && status !== was) {
    // The run's end written in this very change: a merge, a release, or a person marking it done.
    const ended = Boolean(scalar(after.run_ended)) && scalar(after.run_ended) !== scalar(before.run_ended) && !started;
    const change = `${was || "no status"} → ${status || "no status"}`;
    if (status === "done") out.push({ kind: ended && scalar(after.run_pr) ? "merged" : "done", detail: change });
    else if (status === "review") out.push({ kind: "review", detail: change });
    else if (ended && (status === "todo" || status === "canceled")) out.push({ kind: "released", detail: change });
    // A claim moves the task to in_progress; the start says it.
    else if (!(started && status === "in_progress")) out.push({ kind: "status", detail: change });
  }
  const note = scalar(after.progress_note);
  if (BLOCKED.test(note) && note !== scalar(before?.progress_note)) out.push({ kind: "blocked", detail: note });
  return out;
}

/** The changes of commits listed newest first, returned oldest first. */
export function changesFromCommits(commits: LoggedCommit[]): PlanChange[] {
  const out: PlanChange[] = [];
  for (const [index, commit] of [...commits].reverse().entries()) {
    // By id, not by path: a file renamed by hand is its old path removed and its new one added.
    const before = new Map<string, Front>();
    const after = new Map<string, Front>();
    const added = new Set<string>();
    for (const file of commit.files) {
      const old = taskFront(file.before);
      if (old) before.set(scalar(old.id), old);
      const next = taskFront(file.after);
      if (!next) continue;
      after.set(scalar(next.id), next);
      if (file.before === undefined) added.add(scalar(next.id));
    }
    for (const [id, front] of after) {
      const old = before.get(id);
      // A file that did not parse before this commit tells nothing about what changed.
      if (!old && !added.has(id)) continue;
      for (const change of changesOf(old, front)) {
        out.push({
          kind: change.kind,
          task_id: id,
          title: cut(scalar(front.title)),
          project: scalar(front.project),
          at: commit.at,
          run_by: change.run_by ?? "",
          author: commit.author,
          email: commit.email,
          detail: cut(change.detail),
          pr: scalar(front.run_pr),
          by_hand: !commit.dashboard,
          commit: index,
        });
      }
    }
  }
  return out;
}

/** The task changes of the commits since `since` up to `head`, newest commits first, at most MAX_COMMITS of them. */
export async function readChanges(runner: GitRunner, root: string, head: string, since: Date, max = MAX_COMMITS): Promise<ChangesRead> {
  const log = await git(
    runner,
    root,
    [
      ...PLAIN_LOG,
      // The plan's first commit created tasks too.
      "-c",
      "log.showRoot=true",
      "log",
      "--no-renames",
      // A merge's own diff would repeat what its parents' commits already did.
      "--diff-merges=off",
      "-p",
      `-U${CONTEXT}`,
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      `--since=${since.toISOString()}`,
      // One past the cap tells a period that holds more commits from one that holds exactly as many.
      `--max-count=${max + 1}`,
      `--format=%x00%H${FIELD}%cI${FIELD}%an${FIELD}%ae${FIELD}%(trailers:key=${TRAILER},valueonly,separator=%x2C)`,
      head,
      "--",
      `${ENTITY_DIRS.task}/`,
    ],
    GIT_MS,
  );
  const logged = parseChangesLog(log);
  const commits = logged.slice(0, max);
  // git stops at the first commit older than --since only roughly (clock skew); the date decides.
  const changes = changesFromCommits(commits).filter((change) => Date.parse(change.at) >= since.getTime());
  return logged.length > max ? { changes, cutAt: commits[commits.length - 1]!.at } : { changes };
}

/**
 * The last read per clone, valid for the clone HEAD it was read at: a later `since` is answered from
 * it, an earlier one or any commit (the plugin's own or a fetched one) reads git again.
 */
export class PlanRecap {
  private readonly entries = new Map<string, { head: string; from: number; read: Promise<ChangesRead> }>();

  async read(runner: GitRunner, root: string, since: Date): Promise<ChangesRead> {
    const head = (await git(runner, root, ["rev-parse", "--verify", "--quiet", "HEAD"], GIT_MS)).trim();
    const hit = this.entries.get(root);
    let read: Promise<ChangesRead>;
    if (hit && hit.head === head && hit.from <= since.getTime()) {
      read = hit.read;
    } else {
      read = readChanges(runner, root, head, since);
      const entry = { head, from: since.getTime(), read };
      this.entries.set(root, entry);
      read.catch(() => {
        if (this.entries.get(root) === entry) this.entries.delete(root);
      });
    }
    const { changes, cutAt } = await read;
    const shown = changes.filter((change) => Date.parse(change.at) >= since.getTime());
    // A cut read covers a later period in full once it starts at or after the oldest commit read.
    return cutAt && Date.parse(cutAt) >= since.getTime() ? { changes: shown, cutAt } : { changes: shown };
  }
}
