import { z } from "zod";

/**
 * The latest call of a running task's agent, as the board and the map show it
 * (server/tracker/follow.ts). Present only for a run this
 * machine follows.
 */
export const liveNow = z.object({
  /** read, edit, write, shell, search, fetch, agent or tool. */
  op: z.string(),
  /** A path relative to the repository root, a command's program, a query, a host, a sub-agent's task or a tool's name. */
  target: z.string(),
  /** When the call was first seen (ISO). */
  at: z.string(),
});

export type LiveNow = z.output<typeof liveNow>;

/** Files a run shares before "+N": what fits on a card. */
export const OVERLAP_FILES = 5;

/**
 * Another task whose run on this machine changes some of the same files in the same repository
 * (server/tracker/follow.ts `overlaps`): a merge conflict in the making.
 */
export const liveOverlap = z.object({
  task: z.string(),
  /** The shared files, sorted, at most OVERLAP_FILES; `more` counts the rest. */
  files: z.array(z.string()),
  more: z.number(),
});

export type LiveOverlap = z.output<typeof liveOverlap>;

/** "ERG-WDJ7X: notes.txt, a.ts +2", for a card or a read. */
export function overlapText(overlap: LiveOverlap): string {
  // Two files of one name (src/a/index.ts, src/b/index.ts) keep their paths, so they read apart.
  const names = overlap.files.map(baseName);
  const files = overlap.files.map((file, i) => (names.indexOf(names[i]!) !== names.lastIndexOf(names[i]!) ? file : names[i])).join(", ");
  return `${overlap.task}: ${files}${overlap.more ? ` +${overlap.more}` : ""}`;
}

/**
 * How long a call reads as happening now, from its start. A Codex edit takes milliseconds, so a state
 * tied to the call's own running time would never be seen; mission-control lights a file for the same 5 s.
 */
export const LIVE_GLOW_MS = 5_000;

const MARK: Record<string, string> = { read: "◉", edit: "✎", write: "✚", shell: "▶", search: "⌕", fetch: "⇣", agent: "⑂", tool: "⚙" };

/**
 * Claude's own tools whose path or command arrives a moment after the call (the probe, finding 3):
 * until it does, the call reads as what it is doing.
 */
const PENDING: Record<string, string> = {
  Read: "◉ reading",
  Edit: "✎ editing",
  MultiEdit: "✎ editing",
  Write: "✚ writing",
  NotebookEdit: "✎ editing",
  Bash: "▶ running a command",
  Grep: "⌕ searching",
  Glob: "⌕ searching",
  Agent: "⑂ starting a sub-agent",
  Task: "⑂ starting a sub-agent",
};

/** A tool's name as a person reads it: an MCP tool by its own name; Paseo Dash's report tool as what it does. */
export function toolName(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  const tool = mcp ? mcp[2]! : name;
  return mcp?.[1] === "dashboard" && tool === "task_report" ? "progress report" : tool.replace(/_/g, " ");
}

/** The last part of a path: what fits under a station. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A call first seen this late after its start still glows from when it is seen; an older one does not. */
export const LATE_GLOW_MS = 3 * LIVE_GLOW_MS;

/** Whether the call started within the glow window. A client clock behind the server's counts the call as just started. */
export function liveFresh(now: LiveNow, nowMs: number): boolean {
  const at = Date.parse(now.at);
  return Number.isFinite(at) && nowMs - at < LIVE_GLOW_MS;
}

/** How long ago the call started: "now", "12 s", "3 min", "2 h". */
export function liveAge(now: LiveNow, nowMs: number): string {
  const at = Date.parse(now.at);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (seconds < LIVE_GLOW_MS / 1000) return "now";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

/** "✎ src/a.ts · 12 s"; `short` keeps only a path's file name, for a station's line. */
export function liveText(now: LiveNow, nowMs: number, short = false): string {
  const pending = now.op === "tool" ? PENDING[now.target] : undefined;
  if (pending) return [pending, liveAge(now, nowMs)].filter(Boolean).join(" · ");
  const target = now.op === "tool" ? toolName(now.target) : short && (now.op === "read" || now.op === "edit" || now.op === "write") ? baseName(now.target) : now.target;
  const age = liveAge(now, nowMs);
  return [`${MARK[now.op] ?? MARK.tool} ${target}`.trim(), age].filter(Boolean).join(" · ");
}

const SPOKEN: Record<string, string> = { read: "reading", edit: "editing", write: "writing", shell: "running", search: "searching for", fetch: "fetching from", agent: "sub-agent:", tool: "using" };

/**
 * Whether a live line glows: LIVE_GLOW_MS from the call's start, or, for a call first seen late (the
 * change poll and the follower's throttle can take most of the window), LIVE_GLOW_MS from when it was
 * first seen, if that was within LATE_GLOW_MS of its start.
 */
export function liveGlow(now: LiveNow, nowMs: number, firstSeenMs: number): boolean {
  if (liveFresh(now, nowMs)) return true;
  const start = Date.parse(now.at);
  return Number.isFinite(start) && nowMs - start < LATE_GLOW_MS && nowMs - firstSeenMs < LIVE_GLOW_MS;
}

/**
 * The same line in words, for screen readers: "editing src/a.ts, 12 seconds ago". Without `withAge`,
 * for a label that is not redrawn as the time passes: "editing src/a.ts".
 */
export function liveSpoken(now: LiveNow, nowMs: number, withAge = true): string {
  const pending = now.op === "tool" ? PENDING[now.target] : undefined;
  const what = pending ? pending.replace(/^\S+\s/, "") : `${SPOKEN[now.op] ?? "using"} ${now.op === "tool" ? toolName(now.target) : now.target}`;
  const at = Date.parse(now.at);
  if (!withAge || !Number.isFinite(at)) return what;
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  const ago = seconds < LIVE_GLOW_MS / 1000 ? "just now" : seconds < 60 ? `${seconds} seconds ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} minutes ago` : `${Math.floor(seconds / 3600)} hours ago`;
  return `${what}, ${ago}`;
}
