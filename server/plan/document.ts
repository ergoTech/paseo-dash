import { createHash } from "node:crypto";
import { isMap, isScalar, type Node, parseDocument, stringify } from "yaml";

/**
 * One entity file: YAML front matter between `---` lines, then a Markdown body. Field edits are
 * surgical: the key's position comes from the YAML syntax tree, and only the text of its value is
 * replaced, so comments, spacing, key order and every other line stay byte for byte. A file the
 * plugin does not edit is never rewritten at all.
 */
export interface EntityDocument {
  /** The front matter's text, without the `---` lines, with LF line endings. */
  frontText: string;
  /** The body, with LF line endings. */
  body: string;
  /** The file's own line ending, restored on write. */
  eol: "\n" | "\r\n";
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function parseFront(text: string) {
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`front matter: ${document.errors[0]!.message}`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error("front matter is not a key: value map");
  return document;
}

function dataOf(text: string): Record<string, unknown> {
  const value = parseFront(text).toJS() as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseEntity(text: string): EntityDocument {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const match = FRONT_MATTER.exec(normalized);
  if (!match) throw new Error("no YAML front matter (--- … ---) at the start of the file");
  parseFront(match[1]!);
  return { frontText: match[1]!, body: normalized.slice(match[0].length), eol };
}

export function serializeEntity(entity: EntityDocument): string {
  const text = `---\n${entity.frontText}\n---\n${entity.body}`;
  return entity.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function frontData(entity: EntityDocument): Record<string, unknown> {
  return dataOf(entity.frontText);
}

/**
 * A value as one line of YAML: lists and maps in flow style; a string with a line break as a
 * double-quoted scalar, which keeps it on one line.
 */
function inline(value: unknown): string {
  if (typeof value === "string" && /[\r\n]/.test(value)) return JSON.stringify(value);
  return stringify(value, { lineWidth: 0, collectionStyle: "flow", flowCollectionPadding: false }).trimEnd();
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Where a value's own text ends: its node range can run on over the newline into the next key. */
function contentEnd(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/.test(text[end - 1]!)) end -= 1;
  return end;
}

function edited(text: string, key: string, value: unknown): string {
  const document = parseFront(text);
  const items = isMap(document.contents) ? document.contents.items : [];
  const pair = items.find((item) => isScalar(item.key) && item.key.value === key);
  if (!pair) {
    if (isEmpty(value)) return text;
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}${key}: ${inline(value)}`;
  }
  const keyNode = pair.key as Node;
  const colon = text.indexOf(":", keyNode.range![1]);
  const valueNode = pair.value as Node | null;
  const end = valueNode?.range ? Math.max(colon + 1, contentEnd(text, colon + 1, valueNode.range[1])) : colon + 1;
  if (isEmpty(value)) {
    const lineStart = text.lastIndexOf("\n", keyNode.range![0] - 1) + 1;
    const newline = text.indexOf("\n", end);
    return (text.slice(0, lineStart) + (newline === -1 ? "" : text.slice(newline + 1))).replace(/\n$/, "");
  }
  let rest = text.slice(end);
  // An empty value followed by a comment: keep a space between the new value and the "#".
  if (/^#/.test(rest)) rest = ` ${rest}`;
  return `${text.slice(0, colon + 1)} ${inline(value)}${rest}`;
}

/**
 * Sets a top-level key; an empty value removes it, since files carry only fields with a value.
 * The edit proves itself: the result must read back with exactly this key changed and every other
 * key as it was, or it is refused and nothing changes.
 */
export function setField(entity: EntityDocument, key: string, value: unknown): void {
  const before = dataOf(entity.frontText);
  const text = edited(entity.frontText, key, value);
  let after: Record<string, unknown>;
  try {
    after = dataOf(text);
  } catch (error) {
    throw new Error(`could not edit ${key} safely: ${(error as Error).message}`);
  }
  const expected = { ...before };
  if (isEmpty(value)) delete expected[key];
  else expected[key] = value;
  const keys = new Set([...Object.keys(expected), ...Object.keys(after)]);
  for (const name of keys) {
    if (!sameJson(after[name], expected[name])) throw new Error(`could not edit ${key} safely: ${name} would change`);
  }
  entity.frontText = text;
}

export function newEntity(fields: Record<string, unknown>, body: string): EntityDocument {
  const entity: EntityDocument = { frontText: "", body, eol: "\n" };
  for (const [key, value] of Object.entries(fields)) setField(entity, key, value);
  return entity;
}

// ---- Body sections ---------------------------------------------------------------------------

const HEADING = /^##[ \t]+(.+?)[ \t]*$/;

interface Section {
  title: string;
  /** Index of the heading line. */
  start: number;
  /** Index of the line after the section's last line. */
  end: number;
}

function sections(lines: string[]): Section[] {
  const found: Section[] = [];
  lines.forEach((line, index) => {
    const match = HEADING.exec(line);
    if (!match) return;
    if (found.length) found[found.length - 1]!.end = index;
    found.push({ title: match[1]!.trim(), start: index, end: lines.length });
  });
  return found;
}

function findSection(lines: string[], title: string): Section | undefined {
  return sections(lines).find((section) => section.title.toLowerCase() === title.toLowerCase());
}

function readSection(body: string, title: string): string {
  const lines = body.split("\n");
  const section = findSection(lines, title);
  return section ? lines.slice(section.start + 1, section.end).join("\n").trim() : "";
}

/** The text of `## Brief`, trimmed; empty when there is none. */
export function readBrief(body: string): string {
  return readSection(body, "Brief");
}

/** The text of `## Notes`, trimmed; empty when there is none. */
export function readNotes(body: string): string {
  return readSection(body, "Notes");
}

export function briefHash(brief: string): string {
  return createHash("sha256").update(brief.trim()).digest("hex").slice(0, 16);
}

/** Replaces the text of `## Brief`, adding the section at the top when it is missing. */
export function writeBrief(body: string, brief: string): string {
  const lines = body.split("\n");
  const section = findSection(lines, "Brief");
  const content = ["", ...brief.trim().split("\n"), ""];
  if (section) {
    lines.splice(section.start + 1, section.end - section.start - 1, ...content);
    return lines.join("\n");
  }
  return ["## Brief", ...content, body].join("\n");
}

const CHECKBOX = /^(\s*[-*][ \t]+\[)([ xX])(\][ \t]+)(.*)$/;

export interface AcceptanceLine {
  text: string;
  done: boolean;
}

/** The checkbox lines under `## Acceptance`. */
export function readAcceptance(body: string): AcceptanceLine[] {
  const lines = body.split("\n");
  const section = findSection(lines, "Acceptance");
  if (!section) return [];
  return lines.slice(section.start + 1, section.end).flatMap((line) => {
    const match = CHECKBOX.exec(line);
    return match ? [{ text: match[4]!.trim(), done: match[2] !== " " }] : [];
  });
}

/**
 * Ticks or unticks the acceptance line with exactly this text; only that character of the file
 * changes. Returns undefined when there is no such line.
 */
export function writeAcceptance(body: string, text: string, done: boolean): string | undefined {
  const lines = body.split("\n");
  const section = findSection(lines, "Acceptance");
  if (!section) return undefined;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const match = CHECKBOX.exec(lines[index]!);
    if (match && match[4]!.trim() === text.trim()) {
      lines[index] = `${match[1]}${done ? "x" : " "}${match[3]}${match[4]}`;
      return lines.join("\n");
    }
  }
  return undefined;
}

/** What a run's agent left for the next run (`## Handoff`); `run_id` and `at` are empty when a person wrote it. */
export interface Handoff {
  run_id: string;
  at: string;
  text: string;
}

const HANDOFF_STAMP = /^\*Run (\S+) · (\S+)\*$/;

/**
 * Text from an agent or a person stays text inside a section: no line of it may open another one.
 * Line endings become LF, so the text never turns an LF file into a CRLF one.
 */
export function demoteHeadings(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^#{1,2}(?=[ \t])/gm, "###").trim();
}

/** The text of `## Handoff` with the run that wrote it; undefined when there is none or it is empty. */
export function readHandoff(body: string): Handoff | undefined {
  const lines = body.split("\n");
  const section = findSection(lines, "Handoff");
  if (!section) return undefined;
  const content = lines.slice(section.start + 1, section.end).join("\n").trim();
  const [first = "", ...rest] = content.split("\n");
  const stamp = HANDOFF_STAMP.exec(first.trim());
  const text = stamp ? rest.join("\n").trim() : content;
  if (!text) return undefined;
  return { run_id: stamp?.[1] ?? "", at: stamp?.[2] ?? "", text };
}

/**
 * Replaces the text of `## Handoff` with this run's; a task without one gets the section after
 * `## Acceptance` (else after `## Brief`, else at the end), so `## Notes` stays last.
 */
export function writeHandoff(body: string, handoff: Handoff): string {
  const lines = body.split("\n");
  const content = ["", `*Run ${handoff.run_id} · ${handoff.at}*`, "", ...demoteHeadings(handoff.text).split("\n"), ""];
  const section = findSection(lines, "Handoff");
  if (section) {
    lines.splice(section.start + 1, section.end - section.start - 1, ...content);
    return lines.join("\n");
  }
  const after = findSection(lines, "Acceptance") ?? findSection(lines, "Brief");
  if (!after) return [...(body.trim() ? [body.replace(/\n*$/, ""), ""] : []), "## Handoff", ...content].join("\n");
  // Section ends include the blank lines before the next heading; the new one goes right after them.
  const gap = after.end > 0 && lines[after.end - 1]!.trim() !== "" ? [""] : [];
  lines.splice(after.end, 0, ...gap, "## Handoff", ...content);
  return lines.join("\n");
}

/** A person's clarification of a task's instructions, given when starting it (`## Clarifications`). */
export interface Clarification {
  by: string;
  at: string;
  text: string;
}

/** The text of `## Clarifications`, with each entry's stamp, trimmed; empty when there is none. */
export function readClarifications(body: string): string {
  return readSection(body, "Clarifications");
}

const CLARIFICATION_STAMP = /^\*(.+) · (\S+)\*$/;

/** Who gave a clarification, as its entry's stamp names them. */
function stampName(by: string): string {
  return by.replace(/[\r\n*]+/g, " ").trim() || "someone";
}

/** One entry of `## Clarifications`: who gave it and when, then the text. */
export function clarificationEntry(clarification: Clarification): string {
  return `*${stampName(clarification.by)} · ${clarification.at}*\n\n${demoteHeadings(clarification.text)}`;
}

/**
 * Whether the last entry of `## Clarifications` (its text, as `readClarifications` returns it) is
 * this person's with this text, whenever it was given: a start tried again does not add it twice.
 */
export function isLastClarification(clarifications: string | undefined, clarification: Omit<Clarification, "at">): boolean {
  const lines = (clarifications ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const stamp = CLARIFICATION_STAMP.exec(lines[index]!.trim());
    if (stamp) return stamp[1] === stampName(clarification.by) && lines.slice(index + 1).join("\n").trim() === demoteHeadings(clarification.text);
  }
  return false;
}

/**
 * Adds a clarification at the end of `## Clarifications`, after the earlier ones; a task without the
 * section gets it after `## Acceptance` (else after `## Brief`, else at the end), so `## Notes` stays last.
 */
export function addClarification(body: string, clarification: Clarification): string {
  const lines = body.split("\n");
  const entry = clarificationEntry(clarification).split("\n");
  const section = findSection(lines, "Clarifications");
  if (section) {
    const earlier = lines.slice(section.start + 1, section.end).join("\n").trim();
    lines.splice(section.start + 1, section.end - section.start - 1, "", ...(earlier ? [...earlier.split("\n"), ""] : []), ...entry, "");
    return lines.join("\n");
  }
  const content = ["", ...entry, ""];
  const after = findSection(lines, "Acceptance") ?? findSection(lines, "Brief");
  if (!after) return [...(body.trim() ? [body.replace(/\n*$/, ""), ""] : []), "## Clarifications", ...content].join("\n");
  // Section ends include the blank lines before the next heading; the new one goes right after them.
  const gap = after.end > 0 && lines[after.end - 1]!.trim() !== "" ? [""] : [];
  lines.splice(after.end, 0, ...gap, "## Clarifications", ...content);
  return lines.join("\n");
}

/** The body of a new task. */
export function taskBody(brief: string, acceptance: string[]): string {
  const parts = ["## Brief", "", brief.trim(), "", "## Acceptance", ""];
  for (const line of acceptance) parts.push(`- [ ] ${line.trim()}`);
  parts.push("", "## Notes", "");
  return parts.join("\n");
}
