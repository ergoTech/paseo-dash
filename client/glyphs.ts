import type { PluginTheme } from "@getpaseo/plugin";
import { type Glyph, glyphCounts } from "../shared/map.ts";

/** The metro's marks (04-ux.md): a character and a theme color, never color alone. */
export const GLYPH_CHAR: Record<Glyph, string> = {
  done: "✓",
  review: "◇",
  working: "►",
  needs_you: "!",
  failed: "✕",
  elsewhere: "◐",
  todo: "○",
  blocked: "⊘",
};

export const GLYPH_LABEL: Record<Glyph, string> = {
  done: "done",
  review: "in review",
  working: "agent working",
  needs_you: "needs you",
  failed: "failed",
  elsewhere: "in progress, not working here",
  todo: "todo",
  blocked: "blocked",
};

/** Short names for counting a station's tasks by mark ("4 review · 8 done"). */
export const GLYPH_SHORT: Record<Glyph, string> = {
  done: "done",
  review: "review",
  working: "working",
  needs_you: "needs you",
  failed: "failed",
  elsewhere: "in progress",
  todo: "todo",
  blocked: "blocked",
};

/**
 * A station's status line: one task's mark in full; several tasks counted by mark, most urgent first,
 * so "13 tasks" never reads as if all of them had the station's mark.
 */
export function stationStatus(glyphs: Glyph[]): string {
  if (glyphs.length === 1) return GLYPH_LABEL[glyphs[0]!];
  return `${glyphs.length} tasks · ${glyphCounts(glyphs)
    .map(({ glyph, count }) => `${count} ${GLYPH_SHORT[glyph]}`)
    .join(" · ")}`;
}

export function glyphColor(theme: PluginTheme, glyph: Glyph): string {
  switch (glyph) {
    case "done":
      return theme.colors.statusSuccess;
    case "review":
    case "working":
      return theme.colors.accent;
    case "needs_you":
    case "failed":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}
