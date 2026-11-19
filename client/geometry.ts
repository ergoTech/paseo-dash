import type { MetroMap } from "../shared/map.ts";

/** The metro's grid cells to pixels; pure, so the drawing and its tests agree. */

/** Room above the first line for a release's title, due date, progress bar and counts. */
export const HEADER_H = 86;
/** Space between two columns, so each release reads as its own panel. */
export const COLUMN_GAP = 10;
/** A stretched map stops growing here: a release twice as wide as it needs is still readable. */
const MAX_STRETCH = 2.2;
/** In the near view a station sits this far into its slot. */
const NEAR_ANCHOR = 26;

/** A cluster's count badge: at most three characters, so the badge never grows into the station's title. */
export function countBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export interface MetroGeometry {
  rowH: number;
  columnX: number[];
  columnW: number[];
  width: number;
  height: number;
  /** A slot's width in a column: columns stretch to the room they get, so slots differ per column. */
  slotW(column: number): number;
  /** Where a slot starts. */
  slotX(column: number, slot: number): number;
  /** A station's or interchange's center: mid-slot in the far view; near the slot's start in the near view, so the title has the rest. */
  x(column: number, slot: number): number;
  y(row: number): number;
}

/**
 * Columns take the room their slots need (labels on: room for a title by each station), at least
 * enough for the release header; with `available` wider than that, they stretch in proportion, up
 * to MAX_STRETCH, so the map fills the screen instead of hugging its left edge.
 */
export function geometry(map: MetroMap, labels: boolean, available = 0): MetroGeometry {
  const slotBase = labels ? 172 : 48;
  const rowH = labels ? 66 : 44;
  const pad = 14;
  const minW = labels ? 176 : 124;
  const base = map.columns.map((c) => Math.max(minW, Math.max(1, c.slots) * slotBase + pad * 2));
  const gaps = COLUMN_GAP * Math.max(0, base.length - 1);
  const needed = base.reduce((sum, w) => sum + w, 0);
  const stretch = available > needed + gaps && needed > 0 ? Math.min(MAX_STRETCH, (available - gaps) / needed) : 1;
  const columnW = base.map((w) => Math.floor(w * stretch));
  const columnX: number[] = [];
  let x = 0;
  for (const w of columnW) {
    columnX.push(x);
    x += w + COLUMN_GAP;
  }
  const slotW = (column: number) => (columnW[column]! - pad * 2) / Math.max(1, map.columns[column]?.slots ?? 1);
  const slotX = (column: number, slot: number) => columnX[column]! + pad + slot * slotW(column);
  return {
    rowH,
    columnX,
    columnW,
    width: Math.max(x - COLUMN_GAP, 1),
    height: HEADER_H + Math.max(1, map.lines.length) * rowH + 16,
    slotW,
    slotX,
    x: (column, slot) => slotX(column, slot) + (labels ? Math.min(NEAR_ANCHOR, slotW(column) / 2) : slotW(column) / 2),
    y: (row) => HEADER_H + row * rowH + rowH / 2,
  };
}
