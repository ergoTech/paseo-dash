/** ROADMAP.md's Mermaid colors for the theme the dashboard shows it in; pure, so it is tested. */

/** The same states as ROADMAP.md's `classDef`s (server/plan/roadmap.ts), as dark fills with light text. */
export const DARK_CLASSES: Record<string, string> = {
  done: "fill:#173d26,stroke:#3fb96b,color:#e6f4ea",
  review: "fill:#1c2a4d,stroke:#6d8fe8,color:#e3eaff",
  progress: "fill:#3d3112,stroke:#d6a531,color:#fbf0d0",
  blocked: "fill:#2b2b2b,stroke:#808080,color:#d4d4d4",
  todo: "fill:#202020,stroke:#8a8a8a,stroke-dasharray:4 3,color:#e4e4e4",
};

export function forTheme(text: string, dark: boolean): string {
  if (!dark) return text;
  return text.replace(/^( *classDef (\w+) ).*$/gm, (line, head: string, name: string) => (DARK_CLASSES[name] ? `${head}${DARK_CLASSES[name]}` : line));
}

/** Whether a `#rgb`, `#rrggbb` or `#rrggbbaa` background is dark (alpha ignored); anything else counts as light. */
export function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color.trim())?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}
