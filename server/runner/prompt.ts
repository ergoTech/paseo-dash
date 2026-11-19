import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refId, type Task } from "../../shared/model.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import { issueSection } from "../issues/link.ts";
import { demoteHeadings, type Handoff } from "../plan/document.ts";

/**
 * The agent's first prompt (05-architecture.md, What a start sends): the space's
 * `templates/start-prompt.md` when present, else the built-in template. Placeholders are
 * `{{name}}`; an unknown one stays as written. The text says the user asked for the
 * implementation, because repositories such as Laconote's tell agents to stop at a plan otherwise.
 * A task linked to a forge issue gets an "## Issue" section with the closing keyword its PR/MR needs
 * (`{{issue}}`); a space template without that placeholder gets the section at its end. The
 * clarifications people gave when starting the task become a "## Clarifications" section
 * (`{{clarifications}}`) that says they win where they disagree with the brief, likewise at the end
 * of a space template without that placeholder. The latest
 * handoff a run left on the task becomes a "## Handoff" section (`{{handoff}}`), likewise at the end of
 * a space template without that placeholder; it is part of the instructions a start checks.
 */

export interface PromptInput {
  /**
   * The space's own start template as the start checked and hashed it; undefined for the built-in
   * one. Never read again here, so the agent gets the text the start showed (05-architecture.md, Security).
   */
  template: string | undefined;
  plan: Plan;
  loaded: LoadedEntity;
  task: Task;
  spaceName: string;
  branch: string;
  base: string;
  /** Whether the agent has the dashboard tools. */
  tools: boolean;
  /**
   * The run continues a released run's branch, with this open PR/MR if any; "existing" when the
   * branch's work was made by no run of this task (a session outside the dashboard).
   */
  continues?: boolean | "existing";
  continuesPr?: string;
}

const BUILT_IN = `The user asked you to implement this task, not only to plan it. Work in this worktree on branch {{branch}} (based on {{base}}), commit there, and open a merge request when the work is ready.{{continues}}

Task {{id}} · {{title}}
Space: {{space}} · project: {{project}}{{feature}}{{milestone}}

## Brief

{{brief}}

## Acceptance

{{acceptance}}

{{clarifications}}## Dependencies

{{dependencies}}

{{handoff}}{{issue}}{{reporting}}`;

const REPORTING_TOOLS = `## Reporting

You have two tools from the "dashboard" MCP server. Call task_report when you finish an acceptance line (pass its text in "done"), when you are blocked (state "blocked" with a short "blocker"), when you open the merge request (pass its URL in "pr_url"), and with state "done" when the work is complete. Before state "done" or "blocked", and before you stop for any other reason, pass "handoff" too: short lines Done, Left, Decisions, Open questions and How to verify, for the agent that continues this task after you; leave secrets out. Call task_brief to read the task again, with your latest handoff, for example after your context was compacted.`;

const REPORTING_PLAIN = `## Reporting

Say in your replies which acceptance lines are finished, and give the merge request's URL once it is open.`;

/** Text other people wrote stays text: no line may close the template's own sections. */
const quoted = demoteHeadings;

/** The clarifications as the prompt's section; empty without any. */
function clarificationsSection(clarifications: string | undefined): string {
  if (!clarifications?.trim()) return "";
  const lead =
    "The user clarified the instructions above when starting this task. Where a clarification disagrees with the brief or the acceptance, follow the clarification; a later one wins over an earlier one.";
  return `## Clarifications\n\n${lead}\n\n${quoted(clarifications)}`;
}

/** The latest handoff as the prompt's section; empty without one. */
function handoffSection(handoff: Handoff | undefined): string {
  if (!handoff) return "";
  const from = handoff.run_id ? `The previous run (${handoff.run_id}, ${handoff.at}) left this for you:` : "Left for you on the task:";
  return `## Handoff\n\n${from}\n\n${quoted(handoff.text)}`;
}

export function buildPrompt(input: PromptInput): string {
  const { plan, task, loaded } = input;
  const feature = plan.entities.get(refId(task.feature) ?? "")?.entity;
  const milestone = plan.entities.get(refId(task.milestone) ?? (feature?.type === "feature" ? (refId(feature.milestone) ?? "") : ""))?.entity;
  const dependencies = task.depends_on.map((ref) => {
    const other = plan.entities.get(refId(ref) ?? "")?.entity;
    return other ? `- ${other.id} «${other.title}»: ${other.status}` : `- ${ref}: not found in the plan`;
  });
  const values: Record<string, string> = {
    id: task.id,
    title: task.title,
    space: input.spaceName,
    project: task.project ?? "",
    feature: feature ? ` · feature: ${feature.title}` : "",
    milestone: milestone ? ` · release: ${milestone.title}` : "",
    branch: input.branch,
    base: input.base,
    brief: quoted(loaded.brief) || "(no brief)",
    acceptance: loaded.acceptance.length ? loaded.acceptance.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n") : "(none listed)",
    dependencies: dependencies.length ? dependencies.join("\n") : "(none)",
    reporting: input.tools ? REPORTING_TOOLS : REPORTING_PLAIN,
    issue: "",
    handoff: "",
    clarifications: "",
    continues: input.continues
      ? ` This branch already has ${input.continues === "existing" ? "work no run of this task made" : "an earlier run's work"}: read it first and continue from there.${input.continuesPr ? ` Its merge request ${input.continuesPr} is open; push to this branch instead of opening a new one.` : ""}`
      : "",
  };
  const issue = issueSection(task, task.project ? plan.space?.projects[task.project] : undefined);
  const handoff = handoffSection(loaded.handoff);
  const clarifications = clarificationsSection(loaded.clarifications);
  const template = input.template ?? BUILT_IN;
  values.issue = issue ? `${issue}\n\n` : "";
  values.handoff = handoff ? `${handoff}\n\n` : "";
  values.clarifications = clarifications ? `${clarifications}\n\n` : "";
  // A space template without a placeholder gets the section at its end.
  const tail = [
    input.template !== undefined && clarifications && !template.includes("{{clarifications}}") ? clarifications : "",
    input.template !== undefined && handoff && !template.includes("{{handoff}}") ? handoff : "",
    input.template !== undefined && issue && !template.includes("{{issue}}") ? issue : "",
  ].filter(Boolean);
  const text = fill(template, values);
  return tail.length ? `${text.trimEnd()}\n\n${tail.join("\n\n")}\n` : text;
}

/** The space's own start template, when it has a usable one; collaborators write it. */
export function spaceTemplate(root: string): string | undefined {
  const path = join(root, "templates", "start-prompt.md");
  // A space's template is used only as a regular file inside the clone, never through a symlink.
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(join(root, "templates")).isSymbolicLink()) return undefined;
  const text = readFileSync(path, "utf8");
  return text.trim() ? text : undefined;
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));
}

/** `<id> · <title>`, cut to Paseo's limit for explicit agent titles. */
export function agentTitle(task: Task): string {
  const title = `${task.id} · ${task.title}`;
  if (title.length <= 200) return title;
  // Cut by whole characters, never inside a surrogate pair, within 200 UTF-16 units with the ellipsis.
  let cutAt = "";
  for (const char of title) {
    if (cutAt.length + char.length > 199) break;
    cutAt += char;
  }
  return `${cutAt}…`;
}
