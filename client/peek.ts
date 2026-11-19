/**
 * The inspector beside the dashboard's map and lists (04-ux.md, The inspector): what it shows, and
 * the way back and forward through what it showed. Paseo 0.13 gives plugin screens no back
 * navigation and pushes a screen on every `openScreen`, so a task, a station, a feature or a line
 * opened from the space screen shows in this panel of the same screen: the map stays mounted, with
 * its scroll and filters, and the panel keeps its own steps. Pure, so the cases are tested
 * (server/peek.test.ts).
 *
 * - Opening an entry drops the steps ahead of the current one (as a browser does) and never repeats
 *   the entry on view.
 * - A task opened from a list carries that list: "previous" and "next" walk it in place, replacing
 *   the task on view, so back still leads to where the list was.
 * - The entry on view travels in the space screen's params (`peek`), without its list, so a screen
 *   reached from the panel leads back to the space with the panel open on it.
 */

/** A task of the list a task was opened from: its id and its title. */
export interface Sibling {
  id: string;
  title: string;
}

export type Peek =
  | { kind: "task"; task: string; title?: string; list?: Sibling[] }
  | { kind: "station"; space: string; key: string; project: string; title: string }
  | { kind: "feature"; feature: string; title?: string }
  | { kind: "line"; space: string; project: string };

export interface PeekState {
  entries: Peek[];
  /** The entry on view; -1 when the panel is closed. */
  at: number;
}

export const CLOSED: PeekState = { entries: [], at: -1 };
export const MAX_STEPS = 50;

/** The entry's identity: what makes two entries the same place. */
export function peekKey(peek: Peek): string {
  switch (peek.kind) {
    case "task":
      return `task:${peek.task}`;
    case "station":
      return `station:${peek.space}:${peek.key}`;
    case "feature":
      return `feature:${peek.feature}`;
    case "line":
      return `line:${peek.space}:${peek.project}`;
  }
}

export function current(state: PeekState): Peek | undefined {
  return state.at >= 0 ? state.entries[state.at] : undefined;
}

export function open(state: PeekState, peek: Peek): PeekState {
  const on = current(state);
  // The entry on view again (a row tapped twice, a list refreshed): keep the place, take the newer list.
  if (on && peekKey(on) === peekKey(peek)) {
    const entries = [...state.entries];
    entries[state.at] = { ...on, ...Object.fromEntries(Object.entries(peek).filter(([, value]) => value !== undefined)) } as Peek;
    return { entries, at: state.at };
  }
  const entries = [...state.entries.slice(0, state.at + 1), peek];
  const drop = Math.max(0, entries.length - MAX_STEPS);
  return { entries: entries.slice(drop), at: entries.length - 1 - drop };
}

export function canStep(state: PeekState, delta: -1 | 1): boolean {
  const to = state.at + delta;
  return state.at >= 0 && to >= 0 && to < state.entries.length;
}

/** Back (-1) or forward (+1) through the steps; nothing beyond either end. */
export function step(state: PeekState, delta: -1 | 1): PeekState {
  return canStep(state, delta) ? { entries: state.entries, at: state.at + delta } : state;
}

/** Where the task on view stands in the list it was opened from: its index and the list's length. */
export function position(state: PeekState): { index: number; count: number } | undefined {
  const on = current(state);
  if (on?.kind !== "task" || !on.list || on.list.length < 2) return undefined;
  const index = on.list.findIndex((s) => s.id === on.task);
  return index === -1 ? undefined : { index, count: on.list.length };
}

/**
 * The previous (-1) or next (+1) task of the list, in place of the task on view. The steps ahead
 * led from the task it replaces, so they are dropped.
 */
export function sibling(state: PeekState, delta: -1 | 1): PeekState {
  const on = current(state);
  const at = position(state);
  if (on?.kind !== "task" || !at) return state;
  const next = on.list![at.index + delta];
  if (!next) return state;
  const entries = state.entries.slice(0, state.at + 1);
  entries[state.at] = { kind: "task", task: next.id, title: next.title, list: on.list };
  return { entries, at: state.at };
}

/** The `peek` param for the entry: its identity only, never its list. */
export function encode(peek: Peek | undefined): string {
  if (!peek) return "";
  switch (peek.kind) {
    case "task":
      return JSON.stringify({ kind: "task", task: peek.task });
    case "station":
      return JSON.stringify({ kind: "station", space: peek.space, key: peek.key, project: peek.project, title: peek.title });
    case "feature":
      return JSON.stringify({ kind: "feature", feature: peek.feature });
    case "line":
      return JSON.stringify({ kind: "line", space: peek.space, project: peek.project });
  }
}

/** A `peek` param back into an entry; anything else (a hand-edited link, an old shape) is none. */
export function decode(param: string | undefined): Peek | undefined {
  if (!param) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(param);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" && v[key] !== "" ? (v[key] as string) : undefined);
  switch (v.kind) {
    case "task":
      return text("task") ? { kind: "task", task: text("task")! } : undefined;
    case "station":
      return text("space") && text("key") && text("project")
        ? { kind: "station", space: text("space")!, key: text("key")!, project: text("project")!, title: text("title") ?? "" }
        : undefined;
    case "feature":
      return text("feature") ? { kind: "feature", feature: text("feature")! } : undefined;
    case "line":
      return text("space") && text("project") ? { kind: "line", space: text("space")!, project: text("project")! } : undefined;
    default:
      return undefined;
  }
}
