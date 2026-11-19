import { createHash } from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../json-file.ts";

/**
 * The instructions the local user last saw or wrote in Paseo (05-architecture.md, Security): per
 * task, its brief, acceptance list and latest handoff; per space, its start template. A start says whether they
 * changed since, and the Paseo UI shows the diff. Only Paseo's own task screen, the user's own edits
 * there and the start confirmation that showed them mark them seen; reads through God Mode and writes
 * through ChatGPT, an import or a run's agent do not, since they carry other people's words.
 */

/** One part of the instructions: a task's brief, acceptance and handoff, or a space's start template. */
export interface InstructionsPart {
  /** `task:<id>` or `template`. */
  key: string;
  /** What a person calls it: "the brief and acceptance", "the space's start template". */
  name: string;
  text: string;
  /** The git author of its file's last change, a hint only. */
  author: string;
}

export interface DiffLine {
  op: "+" | "-" | " " | "…";
  text: string;
}

export interface PartFact {
  key: string;
  name: string;
  hash: string;
  state: "unchanged" | "changed" | "unseen";
  author: string;
  /** For a changed part the changed lines with context; for an unseen part all of it; else empty. */
  diff: DiffLine[];
}

/** `text` is null when the seen text was too long to keep; then a change shows no diff. */
const entry = z.object({ hash: z.string(), text: z.string().nullable() });
type Entry = z.output<typeof entry>;
// Version 1 kept one hash for the brief, acceptance and template together, which cannot show what
// changed; its records are dropped, so everything reads as not seen once.
const fileSchema = z.union([
  z.object({ version: z.literal(2), seen: z.record(z.string(), entry).default({}) }),
  z.object({ version: z.literal(1) }).transform(() => ({ version: 2 as const, seen: {} as Record<string, Entry> })),
]);

/** A seen text longer than this is kept as its hash only, and a change of it shows no diff. */
const MAX_KEPT = 64_000;
/** Lines of context around a change. */
const CONTEXT = 2;
/** Longest diff an answer carries; the rest is cut with a note. */
const MAX_DIFF_LINES = 400;
/** Above this many line pairs the common lines are not searched for; the change shows whole. */
const MAX_PAIRS = 4_000_000;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export const TEMPLATE_PART = "template";

export function taskPartKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * A task's brief, acceptance lines and latest handoff as one text, the way the task screen shows
 * them. Without a handoff the text is what it was before handoffs existed, so seen records stay valid.
 */
export function taskInstructions(brief: string, acceptance: string[], handoff = "", clarifications = ""): string {
  const lines = acceptance.map((a) => `- [ ] ${a.trim()}`);
  return [
    brief.trim(),
    lines.length ? `Acceptance:\n${lines.join("\n")}` : "",
    clarifications.trim() ? `Clarifications:\n${clarifications.trim()}` : "",
    handoff.trim() ? `Handoff:\n${handoff.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the task part of the instructions is called, as a start confirmation names it. */
export function taskPartName(handoff: string | undefined, clarifications?: string): string {
  const names = ["the brief", "acceptance", ...(clarifications ? ["clarifications"] : []), ...(handoff ? ["handoff"] : [])];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export class SeenStore {
  private readonly path: string;
  private readonly seen: Record<string, Entry>;
  readonly movedAside: string | undefined;

  constructor(path: string) {
    this.path = path;
    const read = readJsonFile(path, fileSchema, () => ({ version: 2 as const, seen: {} }));
    this.seen = read.value.seen;
    this.movedAside = read.movedAside;
  }

  mark(space: string, part: Pick<InstructionsPart, "key" | "text">): void {
    this.seen[`${space}/${part.key}`] = { hash: hashText(part.text), text: part.text.length <= MAX_KEPT ? part.text : null };
    writeJsonFile(this.path, { version: 2, seen: this.seen });
  }

  /** Whether each part changed since the local user last saw it, with what changed. */
  facts(space: string, parts: InstructionsPart[]): PartFact[] {
    return parts.map((part): PartFact => {
      const hash = hashText(part.text);
      const last = this.seen[`${space}/${part.key}`];
      const base = { key: part.key, name: part.name, hash, author: part.author };
      if (!last) return { ...base, state: "unseen", diff: cap(part.text.split("\n").map((text) => ({ op: "+", text }))) };
      if (last.hash === hash) return { ...base, state: "unchanged", diff: [] };
      const diff: DiffLine[] = last.text !== null ? lineDiff(last.text, part.text) : [{ op: "…", text: "too long to compare; read it in full" }];
      return { ...base, state: "changed", diff };
    });
  }
}

/**
 * One sentence for all parts, as God Mode's start confirmation reads it: "unchanged since you last
 * saw them", "changed since you last saw them (per git: anna)", "not seen by you yet (per git: anna)";
 * when the parts differ, each is named.
 */
export function factText(facts: PartFact[]): string {
  const phrase = (fact: PartFact) => {
    const by = fact.author ? ` (per git: ${fact.author})` : "";
    if (fact.state === "unchanged") return "unchanged since you last saw them";
    return fact.state === "changed" ? `changed since you last saw them${by}` : `not seen by you yet${by}`;
  };
  const phrases = facts.map(phrase);
  if (new Set(phrases).size <= 1) return phrases[0] ?? "unchanged since you last saw them";
  return facts.map((fact, index) => `${fact.name}: ${phrases[index]}`).join("; ");
}

function cap(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [...lines.slice(0, MAX_DIFF_LINES), { op: "…", text: `${lines.length - MAX_DIFF_LINES} more lines` }];
}

/** A line diff of two texts: the changed lines with a little context, each gap marked "…". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let full: DiffLine[];
  if (a.length * b.length > MAX_PAIRS) {
    full = [...a.map((text): DiffLine => ({ op: "-", text })), ...b.map((text): DiffLine => ({ op: "+", text }))];
  } else {
    // lcs[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    full = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        full.push({ op: " ", text: a[i]! });
        i++;
        j++;
      } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        full.push({ op: "+", text: b[j]! });
        j++;
      } else {
        full.push({ op: "-", text: a[i]! });
        i++;
      }
    }
  }
  const changed = full.map((line) => line.op !== " ");
  const out: DiffLine[] = [];
  full.forEach((line, index) => {
    let near = false;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(full.length - 1, index + CONTEXT) && !near; k++) near = changed[k]!;
    if (near) out.push(line);
    else if (out.at(-1)?.op !== "…") out.push({ op: "…", text: "" });
  });
  return cap(out);
}
