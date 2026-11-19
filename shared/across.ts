import { ID_PATTERN } from "./model.ts";

/**
 * The all-spaces view (04-ux.md, All spaces): one list across spaces, and writes that go to one of
 * them. Pure, so the screens and their tests agree.
 */

/** The space a plan id belongs to, from its key prefix: `LAC-7K3QX` → `LAC`; empty for anything else. */
export function spaceOfId(id: string): string {
  return ID_PATTERN.test(id) ? id.slice(0, id.indexOf("-")) : "";
}

/**
 * Where a task created in the all-spaces view goes. A project key held by one space decides it; a
 * key several spaces hold (`core`), or no project at all (a draft), leaves `choices` to ask from, and
 * `space` is the one picked among them, else empty until the person picks.
 */
export function spaceForTask(spaces: { space: string; projects: string[] }[], project: string, picked: string): { space: string; choices: string[] } {
  const holding = project ? spaces.filter((s) => s.projects.includes(project)).map((s) => s.space) : [];
  const choices = holding.length ? holding : spaces.map((s) => s.space);
  if (choices.length === 1) return { space: choices[0]!, choices };
  return { space: choices.includes(picked) ? picked : "", choices };
}
