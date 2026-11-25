import { openQuestion } from "../auto-start.ts";

/**
 * The Claude model and effort a start picks for a task when nothing more specific names them
 * (JOBBY-1555K). One policy for every start, the dashboard's confirmation, the autopilot and God Mode:
 *
 * - clear: a short brief with a few acceptance lines → Sonnet 5.5, effort medium;
 * - localized: more lines or a longer brief, nothing uncertain or risky → Sonnet 5.5, effort high;
 * - complex: no acceptance criteria, an open question in the brief, many acceptance lines, or a title
 *   or label naming uncertain or risky work (architecture, more than one repository, migration,
 *   security, research or a spike, audit, rewrite, concurrency) → Opus 5.5, effort high.
 *
 * Risk words count only in the title and labels: briefs cite their sources ("per the research of
 * ERG-X", `05-architecture.md`, "no DB migrations"), which a word search cannot tell from the work
 * itself (on the real plans it was tried on, words in briefs sent most tasks to Opus).
 * A long, detailed brief is a clearer task, not a riskier one.
 *
 * It reads only what every task already has (title, brief, acceptance, labels), so tasks written
 * before it get a choice without any new field. It is deterministic and says why it chose, in words
 * a person checks against the task. Nothing here reads usage: Paseo's usage report names windows by
 * free text, not by model, so a used-up limit never swaps the model; the autopilot's hold applies
 * (server/rate-limit.ts).
 */

export const POLICY_PROVIDER = "claude";

export const TIERS = ["clear", "localized", "complex"] as const;
export type Tier = (typeof TIERS)[number];

/** What each tier starts with: a model id and an effort id as Paseo lists them for Claude. */
export const TIER_SETTINGS: Record<Tier, { model: string; effort: string }> = {
  clear: { model: "claude-sonnet-5-5", effort: "medium" },
  localized: { model: "claude-sonnet-5-5", effort: "high" },
  complex: { model: "claude-opus-5-5", effort: "high" },
};

/** What a task says of itself; all of it is in every task file, old or new. */
export interface TaskSignals {
  title: string;
  brief: string;
  acceptance: string[];
  labels: string[];
}

export interface PolicyPick {
  tier: Tier;
  model: string;
  effort: string;
  /** Why, as a person reads it after the model: "3 acceptance lines, a short brief". */
  reason: string;
}

/** Briefs longer than this (characters, trimmed) are not "clear". */
export const CLEAR_BRIEF_MAX = 1000;
/** More acceptance lines than this are not "clear". */
export const CLEAR_ACCEPTANCE_MAX = 3;
/** More acceptance lines than this are "complex": a scope that large is rarely local. */
export const LOCALIZED_ACCEPTANCE_MAX = 6;

/**
 * Words of uncertain or risky work, in English, Ukrainian and Russian, by stem (JavaScript's `\b`
 * does not see Cyrillic word edges), each with how the reason names it.
 */
const RISKY: [RegExp, string][] = [
  [/architect|архітектур|архитектур/i, "architecture"],
  [/cross[- ]?repo|multi[- ]?repo|(?:several|multiple|two|many) repo|across (?:the )?repo|міжрепозитор|(?:кількох|декількох|кілька|двох) репозитор|нескольк\S* репозитор|межрепозитор/i, "more than one repository"],
  [/migrat|міграц|миграц/i, "a migration"],
  [/security|vulnerab|безпек|вразлив|безопасн|уязвим/i, "security"],
  [/research|investigat|\bspike|дослід|исследов|спайк/i, "research"],
  [/audit|аудит/i, "an audit"],
  [/\brewrite|redesign|переписа|перепроєкт|перепроект/i, "a rewrite"],
  [/race condition|concurren|deadlock|конкурентн/i, "concurrency"],
];

/** A word right after "no", "without", "без", "не" is not the work: "without a migration". */
const NEGATED = /(?:\bno|\bnot|\bwithout|(?:^|[\s(])(?:без|не|нет))\s+(?:\S+\s+)?$/i;

/** Code spans and file paths in a title name things, not the work: `05-architecture.md`, docs/security/x. */
const CODE = /`[^`]*`|\S*[/\\]\S*|\S+\.[a-z]{1,5}\b/gi;

/** `labels` are matched as they are: a label such as `area/security` is a name, not a path. */
function risks(title: string, labels: string[]): string[] {
  const plain = [title.replace(CODE, " "), ...labels].join("\n");
  return RISKY.filter(([pattern]) => {
    const global = new RegExp(pattern.source, "gi");
    return [...plain.matchAll(global)].some((m) => !NEGATED.test(plain.slice(Math.max(0, m.index! - 30), m.index!)));
  }).map(([, name]) => name);
}

/** What the policy reads of a task loaded from the plan. */
export function taskSignals(task: { title: string; labels?: string[] }, loaded: { brief: string; acceptance: { text: string }[] }): TaskSignals {
  return { title: task.title, brief: loaded.brief, acceptance: loaded.acceptance.map((a) => a.text), labels: task.labels ?? [] };
}

/** The tier of a task and why, from its own text. */
export function pickForTask(task: TaskSignals): PolicyPick {
  const brief = task.brief.trim();
  const lines = task.acceptance.map((line) => line.trim()).filter(Boolean);
  const said = (count: number) => (count === 1 ? "1 acceptance line" : `${count} acceptance lines`);
  const complex: string[] = [];
  if (!lines.length) complex.push("no acceptance criteria");
  if (openQuestion(brief)) complex.push("an open question in the brief");
  const named = risks(task.title, task.labels);
  if (named.length) complex.push(`its title or labels name ${named.join(", ")}`);
  if (lines.length > LOCALIZED_ACCEPTANCE_MAX) complex.push(said(lines.length));
  if (complex.length) return { tier: "complex", ...TIER_SETTINGS.complex, reason: complex.join("; ") };
  const localized: string[] = [];
  if (lines.length > CLEAR_ACCEPTANCE_MAX) localized.push(said(lines.length));
  if (brief.length > CLEAR_BRIEF_MAX) localized.push("a longer brief");
  if (localized.length) return { tier: "localized", ...TIER_SETTINGS.localized, reason: `${localized.join(", ")}, nothing uncertain or risky named` };
  return { tier: "clear", ...TIER_SETTINGS.clear, reason: `${said(lines.length)}, a short brief, nothing uncertain or risky named` };
}
