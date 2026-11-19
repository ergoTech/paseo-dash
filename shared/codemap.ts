/**
 * A code map as rows of a tree (after mission-control's code view): each file under the files that
 * import it. A file imported by none starts a tree; a file met again is shown once more as `again`,
 * without its imports, so a cycle or a shared file does not repeat a whole branch.
 */

export interface MapNode {
  path: string;
  state: "changed" | "read" | "linked";
  at: string;
  imports: string[];
}

export interface TreeRow {
  path: string;
  state: MapNode["state"];
  at: string;
  depth: number;
  /** The file it sits under (that imports it); empty for a file that starts a tree. */
  parent: string;
  /** Shown above already: its imports are not repeated. */
  again: boolean;
}

/** Rows a tree shows at most, and how deep it goes. */
export const TREE_ROWS = 80;
export const TREE_DEPTH = 6;

export function codeTree(nodes: MapNode[]): { rows: TreeRow[]; cut: boolean } {
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const imported = new Set(nodes.flatMap((node) => node.imports.filter((path) => byPath.has(path))));
  // Changed files first, then read ones, then linked, each by path.
  const rank = { changed: 0, read: 1, linked: 2 } as const;
  const order = (a: MapNode, b: MapNode) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path);
  const rows: TreeRow[] = [];
  const shown = new Set<string>();
  // Cut at TREE_DEPTH: not drawn, so not "shown above" when another tree reaches it, and no tree of its own.
  const hidden = new Set<string>();
  let cut = false;
  const children = (node: MapNode) => node.imports.map((path) => byPath.get(path)).filter((child): child is MapNode => Boolean(child));
  // A subtree cut at TREE_DEPTH is not drawn again as a tree of its own: its files are imported.
  const hide = (node: MapNode) => {
    if (shown.has(node.path) || hidden.has(node.path)) return;
    hidden.add(node.path);
    for (const child of children(node)) hide(child);
  };
  const walk = (node: MapNode, depth: number, parent: string) => {
    if (rows.length >= TREE_ROWS) {
      cut = true;
      return;
    }
    const again = shown.has(node.path);
    rows.push({ path: node.path, state: node.state, at: node.at, depth, parent, again });
    if (again) return;
    shown.add(node.path);
    const below = children(node);
    if (below.length && depth + 1 >= TREE_DEPTH) {
      cut = true;
      for (const child of below) hide(child);
      return;
    }
    for (const child of below.sort(order)) walk(child, depth + 1, node.path);
  };
  for (const root of nodes.filter((node) => !imported.has(node.path)).sort(order)) walk(root, 0, "");
  // Files only reachable through a cycle start their own tree.
  for (const node of [...nodes].sort(order)) if (!shown.has(node.path) && !hidden.has(node.path)) walk(node, 0, "");
  return { rows, cut };
}
