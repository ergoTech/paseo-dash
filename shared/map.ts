import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { liveNow, liveOverlap } from "./live.ts";

/**
 * The metro map of one space (docs/design/task-manager-v1/04-ux.md, The metro in detail): lines are
 * projects, columns are releases, interchanges are features, stations are tasks. The server lays it
 * out as a grid (column, slot within the column, row); the client turns grid cells into positions.
 * Without a space it answers every space's map as a band of its own (04-ux.md, All spaces).
 */

/** `✓` done, `◇` review, `►` working here, `!` needs you (an agent of this Mac waiting for the person or gone), `✕` failed, `◐` in progress elsewhere (or a tracked trunk checkout ended), `○` todo, `⊘` blocked. */
export const GLYPHS = ["done", "review", "working", "needs_you", "failed", "elsewhere", "todo", "blocked"] as const;
export type Glyph = (typeof GLYPHS)[number];

const glyph = z.enum(GLYPHS);

/** The marks from the most urgent to the least: a station shows the first of its tasks' marks. */
export const URGENCY: Glyph[] = ["needs_you", "failed", "working", "review", "elsewhere", "blocked", "todo", "done"];

/** How many tasks carry each mark, most urgent first, marks no task has left out. */
export function glyphCounts(glyphs: Glyph[]): { glyph: Glyph; count: number }[] {
  return URGENCY.map((g) => ({ glyph: g, count: glyphs.filter((x) => x === g).length })).filter((c) => c.count > 0);
}

export const mapInput = z.object({
  /** Empty or absent: every space, each as a band (`bands`). */
  space: z.string().optional().describe("Space key; empty: all spaces"),
  /** Show finished releases as their own columns instead of one folded column. */
  done: z.boolean().optional(),
  /** Only the lines of this group (space.yaml `group`); empty or absent: all. */
  group: z.string().optional(),
  /** Draw listed projects without stations as empty lines; false folds them. Default true. */
  empty: z.boolean().optional(),
});

/** `defined` false: the palette does not define the label; `color` empty: a neutral color shows. */
const stationTask = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  glyph,
  labels: z.array(z.object({ name: z.string(), color: z.string(), defined: z.boolean() })),
  /** The latest call of the task's agent on this machine, while it runs (shared/live.ts). */
  live: liveNow.optional(),
  /** Other tasks whose runs on this machine change some of the same files (shared/live.ts). */
  overlaps: z.array(liveOverlap).optional(),
});

const metroMap = z.object({
  space: z.object({ key: z.string(), name: z.string() }),
  /**
   * Projects in space.yaml order, kept together by group (groups in the order they first appear,
   * projects without one after them). A listed project with no station in the visible columns is an
   * `empty` line, or in `folded` when empty lines are not asked for. `color` is `#rrggbb`, or empty
   * for a project space.yaml does not list.
   */
  lines: z.array(
    z.object({
      project: z.string(),
      row: z.number().int(),
      color: z.string(),
      group: z.string(),
      empty: z.boolean(),
      /** Open Paseo workspaces of the project that no dashboard task runs in, and how many of them an agent is busy in or waits for you. */
      open: z.number().int(),
      busy: z.number().int(),
      /** `open` and `busy` are from an earlier read: the last time Paseo was asked, it could not be read. */
      stale: z.boolean(),
      /**
       * Keys of the other connected spaces that list the same repository as a line. Each has its own
       * tasks for it; where this machine maps those lines to the same Paseo project, `open` and `busy`
       * count the same workspaces under each of them.
       */
      shared_with: z.array(z.string()),
    }),
  ),
  folded: z.array(z.string()),
  /** The space's groups in order, for the group filter; empty when no project has one. */
  groups: z.array(z.string()),
  columns: z.array(
    z.object({
      /** A milestone id, "later" or "done". */
      id: z.string(),
      title: z.string(),
      due: z.string(),
      days_left: z.number().int().nullable(),
      done: z.number().int(),
      total: z.number().int(),
      needs_you: z.number().int(),
      blocked: z.number().int(),
      /** Slots: one per feature in this column, then one for tasks without a feature. */
      slots: z.number().int(),
    }),
  ),
  interchanges: z.array(
    z.object({
      /** Unique: a feature whose tasks are in several releases has an interchange in each. */
      key: z.string(),
      feature: z.string(),
      title: z.string(),
      branch: z.string(),
      status: z.string(),
      column: z.number().int(),
      slot: z.number().int(),
      /** The rows the feature has stations on, and the span its bar covers. */
      rows: z.array(z.number().int()),
      top: z.number().int(),
      bottom: z.number().int(),
    }),
  ),
  stations: z.array(
    z.object({
      key: z.string(),
      column: z.number().int(),
      slot: z.number().int(),
      row: z.number().int(),
      feature: z.string(),
      /** The station's mark: the most urgent of its tasks. */
      glyph,
      tasks: z.array(stationTask),
    }),
  ),
  depot: z.array(z.object({ id: z.string(), title: z.string(), project: z.string() })),
  error: z.string(),
});

export type MetroMap = z.output<typeof metroMap>;
type MapStation = MetroMap["stations"][number];

/** Pairs of stations whose tasks' runs on this machine change the same files, once each. */
export function overlapLinks(map: MetroMap): { key: string; from: MapStation; to: MapStation }[] {
  const stationOf = new Map(map.stations.flatMap((s) => s.tasks.map((t) => [t.id, s] as const)));
  const links = new Map<string, { key: string; from: MapStation; to: MapStation }>();
  for (const s of map.stations) {
    for (const task of s.tasks) {
      for (const overlap of task.overlaps ?? []) {
        const other = stationOf.get(overlap.task);
        // Two tasks of one station share its ring, already red; there is nothing to link.
        if (!other || other === s) continue;
        const key = [s.key, other.key].sort().join("|");
        if (!links.has(key)) links.set(key, { key, from: s, to: other });
      }
    }
  }
  return [...links.values()];
}

/**
 * One space: its map, `bands` empty. All spaces: the top-level map is empty (its `space` key empty)
 * and `bands` holds each space's own map in the order the spaces were connected. Project keys, column
 * ids ("later", "done") and rows repeat across bands, so a band's `space` qualifies them; station and
 * interchange keys are prefixed with the space key (`TST/later:-:core`).
 */
export const mapOutput = metroMap.extend({ bands: z.array(metroMap) });

export type MapAnswer = z.output<typeof mapOutput>;

export const mapRpc = defineRpc({ name: "map.get", input: mapInput, output: mapOutput });
