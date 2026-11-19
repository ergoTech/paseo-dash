import { posix } from "node:path";

/**
 * A run's code map, after mission-control's code view: the files the run changed or read as nodes,
 * and the relative imports between them as edges (a file under the files that import it). Imports are
 * read from the files themselves: JavaScript and TypeScript (`import … from`, `export … from`,
 * `import()`, `require()`) and Python (`from .x import …`, parenthesised too). Other files have none
 * and are not read. A file a changed file imports but the run did not touch is shown as `linked`, one
 * step out, its own imports unread. The patterns are a heuristic: an import written inside a comment
 * still counts.
 */

export type CodeState = "changed" | "read" | "linked";

export interface CodeFile {
  /** Relative to the repository root. */
  path: string;
  state: "changed" | "read";
  /** When the run's agent last touched it (ISO), or empty when only git lists it. */
  at: string;
}

export interface CodeNode {
  path: string;
  state: CodeState;
  at: string;
  /** The nodes this file imports, by path, sorted. */
  imports: string[];
}

export interface CodeMap {
  nodes: CodeNode[];
  /** Files left out beyond the limit. */
  more: number;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const PYTHON = /\.py$/;
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const JS_PATTERNS = [
  // Bounded, so a long stretch without quotes or semicolons cannot make the match quadratic.
  /(?:^|[\s;])(?:import|export)\s[^'"`;]{0,1000}?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];
const PY_FROM = /^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w*, \t]+))/gm;

/** The relative import specifiers a file names: "./a", "../b/c" for scripts; ".a", "..b.c" (with names) for Python. */
export function importsOf(path: string, text: string): { spec: string; names: string[] }[] {
  const found: { spec: string; names: string[] }[] = [];
  if (SCRIPT.test(path)) {
    for (const pattern of JS_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const spec = match[1]!;
        if (spec.startsWith("./") || spec.startsWith("../")) found.push({ spec, names: [] });
      }
    }
  } else if (PYTHON.test(path)) {
    for (const match of text.matchAll(PY_FROM)) {
      const names = (match[3] ?? match[4] ?? "")
        .replace(/#[^\n]*/g, "")
        .split(",")
        .map((name) => name.trim().split(/\s+/)[0] ?? "")
        .filter((name) => name && name !== "*");
      // `from . import a, b`: each name is a module of the package, an edge of its own.
      if (!match[2]) for (const name of names) found.push({ spec: match[1]!, names: [name] });
      else found.push({ spec: `${match[1]}${match[2]}`, names });
    }
  }
  return found;
}

/** Whether a file's imports are read: scripts and Python. */
export const readsImports = (path: string) => SCRIPT.test(path) || PYTHON.test(path);

/**
 * The candidate files a specifier may name, relative to the root, in the order they are tried: as
 * TypeScript resolves them from a TypeScript file (a `.js` name finds its `.ts` source first), as
 * Node does otherwise.
 */
export function candidates(from: string, spec: string, names: string[] = []): string[] {
  const dir = posix.dirname(from);
  if (PYTHON.test(from)) {
    const dots = /^\.+/.exec(spec)![0].length;
    let base = dir;
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const module = spec.slice(dots).replace(/\./g, "/");
    const at = module ? posix.join(base, module) : base;
    const out = module ? [`${at}.py`, posix.join(at, "__init__.py")] : [];
    // `from . import a`: a may be a module of the package.
    for (const name of names) out.push(posix.join(at, `${name}.py`), posix.join(at, name, "__init__.py"));
    if (!module) out.push(posix.join(at, "__init__.py"));
    return out.map(clean);
  }
  const base = posix.join(dir, spec);
  const out = [base, ...SCRIPT_EXTENSIONS.map((ext) => base + ext), ...SCRIPT_EXTENSIONS.map((ext) => posix.join(base, `index${ext}`))];
  // ESM TypeScript names its imports by their emitted ".js".
  const emitted = /\.(m|c)?js$/.exec(base);
  if (emitted) {
    const stem = base.slice(0, -emitted[0].length);
    const sources = [`${stem}.${emitted[1] ?? ""}ts`, `${stem}.tsx`];
    if (/\.[cm]?tsx?$/.test(from)) out.unshift(...sources);
    else out.push(...sources);
  }
  return out.map(clean);
}

const clean = (path: string) => posix.normalize(path).replace(/^\.\//, "");
const inside = (path: string) => path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path);

/**
 * The map of a run's files: `read` gives a file's text (undefined when it cannot be read) and
 * `exists` whether a file is there, both relative to the repository root. At most `limit` nodes; the
 * changed files come first, then the read ones, each newest first, then the linked ones.
 */
export function buildCodeMap(
  files: CodeFile[],
  read: (path: string) => string | undefined,
  exists: (path: string) => boolean,
  limit = 60,
): CodeMap {
  const rank = (file: CodeFile) => (file.state === "changed" ? 0 : 1);
  const ordered = [...files].filter((file) => inside(file.path)).sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at) || a.path.localeCompare(b.path));
  const kept = ordered.slice(0, limit);
  let more = ordered.length - kept.length;
  const nodes = new Map<string, CodeNode>(kept.map((file) => [file.path, { path: file.path, state: file.state, at: file.at, imports: [] }]));
  const left = new Set<string>();
  for (const node of [...nodes.values()]) {
    if (!readsImports(node.path)) continue;
    const text = read(node.path);
    if (text === undefined) continue;
    const imports = new Set<string>();
    for (const { spec, names } of importsOf(node.path, text)) {
      const target = candidates(node.path, spec, names).filter(inside).find((path) => nodes.has(path) || exists(path));
      if (!target || target === node.path) continue;
      if (!nodes.has(target)) {
        // One step out, from a changed file only: what the change reaches.
        if (node.state !== "changed") continue;
        if (nodes.size >= limit) {
          left.add(target);
          continue;
        }
        nodes.set(target, { path: target, state: "linked", at: "", imports: [] });
      }
      imports.add(target);
    }
    node.imports = [...imports].sort();
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path)), more: more + left.size };
}
