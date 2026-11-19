import { ENTITY_DIRS } from "../../shared/model.ts";
import { git, type GitRunner } from "../sync/git.ts";
import { frontData, parseEntity, readHandoff } from "./document.ts";

/**
 * A task's runs as the plan's history has them (03-model.md, Task): a claim writes a new `run_id` and
 * replaces every `run_*` field, so earlier runs live only in the commits of the task's file. Read on
 * demand from the clone's commits and cached per clone HEAD; nothing here writes. A run counts only
 * when a commit of the plan carries its `run_id`, and the task's file is found by its `id` field, so a
 * file renamed by hand keeps its history.
 */

export interface PlanRun {
  run_id: string;
  by: string;
  host: string;
  branch: string;
  started: string;
  ended: string;
  /**
   * `live` while it holds the task; else the status the task had when the run ended (`done`, `todo`,
   * `canceled`, …), or `replaced` when it is no longer the task's run and no end was written (a later
   * claim or a hand edit).
   */
  result: string;
  pr: string;
  progress_done?: number;
  progress_total?: number;
  progress_note: string;
  /** The last handoff this run's agent left (its `## Handoff` stamp names the run). */
  handoff?: { at: string; text: string };
}

const GIT_MS = 15_000;
/** Context wide enough that each file's diff carries the whole file as of the commit. */
export const WHOLE_FILE = "-U100000000";
/** Settings of the user's that would change what `git log` prints here. */
export const PLAIN_LOG = ["-c", "diff.suppressBlankEmpty=false", "-c", "log.follow=false", "-c", "log.showSignature=false", "--literal-pathspecs"];

function scalar(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The files of each commit as `git log -p` with whole-file context shows them, newest commit first:
 * the context and added lines of a file's diff are the file after the commit. A deleted file has
 * none and yields nothing.
 */
export function parseWholeFileLog(output: string): string[][] {
  const commits: string[][] = [];
  for (const record of output.split("\0").slice(1)) {
    const files: string[] = [];
    let lines: string[] | undefined;
    let inHunk = false;
    const close = () => {
      if (lines?.length) files.push(lines.join("\n"));
      lines = undefined;
      inHunk = false;
    };
    for (const line of record.split("\n").slice(1)) {
      if (line.startsWith("diff --git ")) {
        close();
        lines = [];
      } else if (lines && !inHunk) {
        inHunk = line.startsWith("@@");
      } else if (lines && (line.startsWith(" ") || line.startsWith("+"))) {
        lines.push(line.slice(1));
      }
    }
    close();
    commits.push(files);
  }
  return commits;
}

interface Snapshot {
  front: Record<string, unknown>;
  handoff?: { run_id: string; at: string; text: string };
}

function snapshotOf(text: string, taskId: string): Snapshot | undefined {
  try {
    const document = parseEntity(text);
    const front = frontData(document);
    if (scalar(front.id) !== taskId) return undefined;
    return { front, handoff: readHandoff(document.body) };
  } catch {
    // A commit that left the file unreadable says nothing about runs.
    return undefined;
  }
}

/** The runs in a task file's versions, oldest version first; the result is newest run first. */
export function runsFromSnapshots(snapshots: Snapshot[]): PlanRun[] {
  const runs = new Map<string, PlanRun>();
  const handoffs = new Map<string, { at: string; text: string }>();
  let last = "";
  for (const { front, handoff } of snapshots) {
    if (handoff?.run_id) handoffs.set(handoff.run_id, { at: handoff.at, text: handoff.text });
    const id = scalar(front.run_id);
    last = id;
    if (!id) continue;
    const ended = scalar(front.run_ended);
    const known = runs.get(id);
    // The status when the end was first written; a later reopen of the task does not change it.
    const result = ended ? (known?.ended ? known.result : scalar(front.status)) : "";
    runs.set(id, {
      run_id: id,
      by: scalar(front.run_by),
      host: scalar(front.run_host),
      branch: scalar(front.run_branch),
      started: scalar(front.run_started),
      ended,
      result,
      pr: scalar(front.run_pr),
      progress_done: count(front.progress_done),
      progress_total: count(front.progress_total),
      progress_note: scalar(front.progress_note),
    });
  }
  const out = [...runs.values()].map((run) => {
    const handoff = handoffs.get(run.run_id);
    const result = run.ended ? run.result || "ended" : run.run_id === last ? "live" : "replaced";
    return { ...run, result, ...(handoff ? { handoff } : {}) };
  });
  return out.reverse();
}

/** The `id:` line of a task's front matter, as git's extended regular expressions write it. */
function idLine(taskId: string): string {
  return `^id:[[:space:]]*["']?${taskId}["']?[[:space:]]*(#.*)?$`;
}

/**
 * Reads the runs from the commits up to `head`: first every path under `tasks/` that ever held the
 * task's `id` line (so a hand rename is followed), then each of those files as of every commit that
 * changed it, in one `git log` each.
 */
export async function readTaskRuns(runner: GitRunner, root: string, taskId: string, path: string, head: string): Promise<PlanRun[]> {
  const named = await git(
    runner,
    root,
    [...PLAIN_LOG, "log", "-z", "--no-renames", "--format=", "--name-only", `-G${idLine(taskId)}`, head, "--", `${ENTITY_DIRS.task}/`],
    GIT_MS,
  );
  const paths = [...new Set([path, ...named.split("\0")].filter(Boolean))];
  const log = await git(
    runner,
    root,
    [
      ...PLAIN_LOG,
      "log",
      "--no-renames",
      "--topo-order",
      "--diff-merges=first-parent",
      "-p",
      WHOLE_FILE,
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--format=%x00%H",
      head,
      "--",
      ...paths,
    ],
    GIT_MS,
  );
  const snapshots: Snapshot[] = [];
  for (const files of parseWholeFileLog(log).reverse()) {
    for (const text of files) {
      const snapshot = snapshotOf(text, taskId);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return runsFromSnapshots(snapshots);
}

/**
 * The run histories read so far, per clone and task, each valid for the clone HEAD it was read at:
 * any commit (the plugin's own or a fetched one) makes the next read go to git again. Bounded, the
 * oldest read dropped first.
 */
export class RunHistory {
  private readonly entries = new Map<string, { head: string; runs: Promise<PlanRun[]> }>();
  private readonly max: number;
  /** Reads of git that finished, so the changes token moves when a history a screen waited for is in. */
  settled = 0;

  constructor(max = 200) {
    this.max = max;
  }

  async read(runner: GitRunner, root: string, taskId: string, path: string): Promise<PlanRun[]> {
    const head = (await git(runner, root, ["rev-parse", "--verify", "--quiet", "HEAD"], GIT_MS)).trim();
    const key = `${root}\0${taskId}`;
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit?.head === head) {
      this.entries.set(key, hit);
      return hit.runs;
    }
    const runs = readTaskRuns(runner, root, taskId, path, head);
    this.entries.set(key, { head, runs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
    runs.then(
      () => void this.settled++,
      () => {
        if (this.entries.get(key)?.runs === runs) this.entries.delete(key);
      },
    );
    return runs;
  }
}
