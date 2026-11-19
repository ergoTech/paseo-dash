import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { LABEL_PATTERN, type LabelDef, type Person } from "./model.ts";
import { nextLineColor } from "./projects.ts";

/**
 * Labels and people of a space (docs/design/task-manager-v1/03-model.md, `space.yaml`;
 * 09-forge-issues.md, Labels for tasks). A label is named case-insensitively: `Bug` and `bug` are one
 * label, spelled the way the palette (or else the first task) spells it. People are for display and
 * matching only; a person entry grants nothing.
 */

/** Why a typed label is refused; shown to people and to ChatGPT. */
export const LABEL_RULE = "1-40 characters: letters or digits first, then also spaces and - _ . / : + &";

/** The label as it is written: whitespace collapsed; undefined when it is not a usable label. */
export function cleanLabel(text: string): string | undefined {
  const label = text.replace(/\s+/g, " ").trim();
  return LABEL_PATTERN.test(label) ? label : undefined;
}

export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The palette entry a label names, with the key as space.yaml spells it. */
export function findLabel(palette: Record<string, LabelDef>, name: string): [key: string, def: LabelDef] | undefined {
  const key = Object.keys(palette).find((k) => sameLabel(k, name));
  return key === undefined ? undefined : [key, palette[key]!];
}

/** A label as the screens draw it: its palette color, and whether the palette defines it at all. */
export function shownLabel(palette: Record<string, LabelDef>, name: string): { name: string; color: string; defined: boolean } {
  const found = findLabel(palette, name);
  return { name, color: found?.[1].color ?? "", defined: Boolean(found) };
}

/** A new label's color: the first palette color no label uses yet, as new lines get theirs. */
export function nextLabelColor(palette: Record<string, LabelDef>, taken: string[] = []): string {
  return nextLineColor([...Object.values(palette).flatMap((l) => (l.color ? [l.color] : [])), ...taken]);
}

/** The person a git email belongs to, compared case-insensitively; the first one listed wins. */
export function personByEmail(people: Record<string, Person>, email: string): string | undefined {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return undefined;
  return Object.keys(people).find((key) => people[key]!.emails.some((e) => e.toLowerCase() === wanted));
}

/** A person by key or by name, case-insensitively. */
export function findPerson(people: Record<string, Person>, asked: string): string | undefined {
  const wanted = asked.trim().toLowerCase();
  if (!wanted) return undefined;
  const keys = Object.keys(people);
  return keys.find((key) => key.toLowerCase() === wanted) ?? keys.find((key) => people[key]!.name?.trim().toLowerCase() === wanted);
}

const space = z.string().trim().min(1).describe("Space key");
const answer = z.object({ ok: z.boolean(), error: z.string() });
const color = z.string().trim().optional().describe("#rrggbb; empty: the next palette color");

/** Adds a label to the palette or changes its color or description. */
export const labelsPutRpc = defineRpc({
  name: "labels.put",
  input: z.object({
    space,
    name: z.string().trim().min(1).max(40).describe("Label name"),
    color,
    description: z.string().trim().max(200).optional().describe("What the label means; empty: none"),
  }),
  output: answer,
});

/** Takes a label out of the palette; refused while a task carries it. */
export const labelsRemoveRpc = defineRpc({
  name: "labels.remove",
  input: z.object({ space, name: z.string().trim().min(1).describe("Label name") }),
  output: answer,
});

/** Adds a person or replaces what space.yaml says about them. */
export const peoplePutRpc = defineRpc({
  name: "people.put",
  input: z.object({
    space,
    key: z.string().trim().min(1).max(32).describe("Person key: lower-case letters, digits, - and _"),
    name: z.string().trim().max(100).optional(),
    emails: z.array(z.string().trim().min(3).max(200)).max(10).default([]).describe("Git emails this person commits with"),
    github: z.string().trim().max(100).optional(),
    gitlab: z
      .array(z.object({ host: z.string().trim().min(1).max(200), login: z.string().trim().min(1).max(100) }))
      .max(10)
      .default([])
      .describe("GitLab login per host"),
  }),
  output: answer,
});

/** Takes a person out of space.yaml; refused while an open task is assigned to them. */
export const peopleRemoveRpc = defineRpc({
  name: "people.remove",
  input: z.object({ space, key: z.string().trim().min(1).describe("Person key") }),
  output: answer,
});
