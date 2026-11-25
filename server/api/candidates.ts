import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { CANDIDATE_GROUPS, type startCandidatesRpc } from "../../shared/api.ts";
import { hasLiveRun, type RequirementKind, type Task, unheld } from "../../shared/model.ts";
import { sameLabel } from "../../shared/labels.ts";
import { openQuestion } from "../auto-start.ts";
import type { Plan } from "../plan/load.ts";
import { loadProfiles, nextStart } from "./batch.ts";
import type { ReadContext } from "./reads.ts";
import { resolveSpaces } from "./resolve.ts";
import { ownerGate, requirementText } from "./start-verdict.ts";
import { blockers, cut, humanWork, plannedBranch, sortTasks } from "./view.ts";

/**
 * What of the open work can start, and on whom it waits (06-god-mode.md, Start candidates). Read
 * only: it never starts, queues or reorders anything; the order is the board's, the user's own.
 * Each todo task (and each in progress with no run) lands in one group, the first that holds it:
 * dependencies, a person's label, merged work, an owner's or an environment's requirement, an open
 * question in its brief, a label that reads like a person's work the space does not mark, its
 * project not mapped here; else an agent can take it. "agent" says only that nothing the plan
 * records holds it: when no person checked it (readiness_note), `checked` says so.
 */

type Candidates = RpcOutput<typeof startCandidatesRpc>;
type Group = (typeof CANDIDATE_GROUPS)[number];
type Row = Candidates["tasks"][number];

/**
 * Label names that read like a person's work in plans seen so far. A label the space marks
 * (defaults.human_labels) is a person's work; one of these it does not mark is only a question to
 * the person, never a verdict either way.
 */
const PERSON_LIKE = ["manual", "needs-owner", "owner", "live-check", "human", "person", "decision", "needs-decision", "waiting"];

const DECISION: RequirementKind[] = ["owner", "decision"];

/** The group, why and what to do: the first thing that holds the task, as the module comment orders them. */
function classify(ctx: ReadContext, plan: Plan, task: Task, mapped: boolean, brief: string): { group: Group; reason: string; next: string } {
  const waits = blockers(plan, task);
  if (waits.length) return { group: "dependencies", reason: cut(`waits for ${waits.join("; ")}`, 200), next: "finish or start what it waits for first" };
  const human = humanWork(plan, task);
  if (human) return { group: "person", reason: human, next: "the user does it, or removes the label; start_task only if the user asks for this one task" };
  const gate = ownerGate(ctx.dashboard, plan, task);
  if (gate?.needs === "merged") return { group: "merged", reason: gate.reason, next: gate.next };
  if (task.requires.length) {
    const first = task.requires[0]!;
    const group: Group = DECISION.includes(first.kind) ? "decision" : "qa_environment";
    return { group, reason: cut(task.requires.map(requirementText).join("; "), 200), next: "the user settles it and takes it off (update_task requires []), then it can start" };
  }
  const question = openQuestion(brief);
  if (question) return { group: "decision", reason: cut(`an open question in its brief: ${question}`, 200), next: "the user answers it in the brief or a clarification" };
  const marked = plan.space?.defaults.human_labels ?? [];
  const like = task.labels.filter((label) => PERSON_LIKE.some((name) => sameLabel(name, label)) && !marked.some((name) => sameLabel(name, label)));
  if (like.length) {
    return {
      group: "check",
      reason: `label ${like.join(", ")} reads like a person's work, but the space does not mark it so (defaults.human_labels)`,
      next: "the user says whether an agent may do it: mark the label as a person's work in Paseo Dash, record a requirement (update_task requires), or check it (update_task readiness_note)",
    };
  }
  if (!mapped) return { group: "not_here", reason: `project ${task.project ?? "(none)"} is not mapped on this Mac`, next: "open the project in Paseo on this Mac" };
  return {
    group: "agent",
    reason: unheld(task) ? "in progress with no run; nothing the plan records holds it" : "ready; nothing the plan records holds it",
    next: "start_task or start_tasks when the user asks; reading this starts nothing",
  };
}

/** A shared branch with a task under way or another candidate: the overlap known before any agent works. */
function overlapOf(plan: Plan, task: Task, branches: Map<string, string[]>): string {
  const branch = plannedBranch(plan, task);
  const others = (branches.get(branch) ?? []).filter((id) => id !== task.id);
  return others.length ? `shares branch ${branch} with ${others.join(", ")}` : "";
}

export async function startCandidates(ctx: ReadContext, input: RpcInput<typeof startCandidatesRpc>): Promise<Candidates> {
  const slots = { max: 0, active: 0, launching: 0, stopped: 0, review: 0, free: 0, hold: "" };
  const empty: Candidates = { slots, counts: {}, tasks: [], total: 0, note: "", error: "" };
  const dashboard = ctx.dashboard;
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const spaces = resolveSpaces(dashboard, input.space);
  if (!spaces.ok) return { ...empty, error: spaces.error };

  // This Mac's places: the autopilot's limit, and what each live run of this Mac does with one.
  const autopilot = dashboard.autopilot?.read();
  if (autopilot) {
    slots.max = autopilot.max_running;
    for (const run of autopilot.runs) {
      if (run.holds_place) slots.active += 1;
      if (run.activity === "launching") slots.launching += 1;
      else if (run.activity === "stopped" || run.activity === "failed") slots.stopped += 1;
      else if (!run.holds_place && run.status === "review") slots.review += 1;
    }
    slots.free = Math.max(0, slots.max - autopilot.running);
    slots.hold = autopilot.limit.until ? `a usage limit holds every start until ${autopilot.limit.until} (${autopilot.limit.source})` : "";
  }

  const profiles = await loadProfiles(ctx);
  const counts: Record<string, number> = Object.fromEntries(CANDIDATE_GROUPS.map((g) => [g, 0]));
  const rows: Row[] = [];
  let total = 0;
  for (const space of spaces.value) {
    const plan = space.sync.plan;
    const tasks = [...plan.entities.values()]
      .filter((l) => l.entity.type === "task")
      .map((l) => ({ plan, task: l.entity as Task, loaded: l }))
      .filter(({ task }) => (task.status === "todo" && !hasLiveRun(task)) || unheld(task));
    // Branches of work under way and of the candidates: a shared one is an overlap known now.
    const branches = new Map<string, string[]>();
    for (const loaded of plan.entities.values()) {
      const task = loaded.entity;
      if (task.type !== "task") continue;
      const live = hasLiveRun(task) && task.run_branch;
      const branch = live ? task.run_branch! : tasks.some((t) => t.task.id === task.id) ? plannedBranch(plan, task) : "";
      if (branch) branches.set(branch, [...(branches.get(branch) ?? []), task.id]);
    }
    let order = 0;
    for (const { task, loaded } of sortTasks(tasks)) {
      order += 1;
      const mapped = Boolean(task.project && space.record.mapping[task.project]);
      const { group, reason, next } = classify(ctx, plan, task, mapped, loaded.brief);
      counts[group] = (counts[group] ?? 0) + 1;
      if (input.group && group !== input.group) continue;
      total += 1;
      if (rows.length >= (input.limit ?? 20)) continue;
      rows.push({
        id: task.id,
        title: task.title,
        group,
        order,
        reason,
        next,
        start_with: group === "agent" || group === "check" ? nextStart(ctx, space, task, loaded, profiles) : "",
        checked: task.readiness_checked ? `${task.readiness_checked.slice(0, 10)}: ${task.readiness_note ?? "checked"}` : "",
        overlap: overlapOf(plan, task, branches),
      });
    }
  }
  const agents = counts.agent ?? 0;
  const note = cut(
    `${agents} for an agent now${slots.max ? `, ${slots.free} of ${slots.max} places free` : ""}${slots.hold ? `; ${slots.hold}` : ""}. Read only: nothing started or moved. Overlap of files is known only once agents work: an empty overlap is not a check.`,
    400,
  );
  return { slots, counts, tasks: rows, total, note, error: "" };
}
