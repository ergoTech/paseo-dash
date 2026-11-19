import { hasLiveRun, refId, type Task } from "../../shared/model.ts";
import type { Dashboard } from "../dashboard.ts";
import type { Handoff } from "../plan/document.ts";
import { opaqueId } from "../plan/ids.ts";
import type { RunRecord } from "../runner/runs.ts";
import type { Operation, Outcome } from "../sync/ops.ts";
import type { ToolAnswer } from "./bridge.ts";
import { redactSecrets } from "./redact.ts";
import { reportSchema } from "./schema.ts";

/**
 * What the two agent tools do (05-architecture.md, The agent's own report). Every write is a
 * run-scoped operation (I3): it applies only while this run is the task's live run, so a late
 * report of an ended run changes nothing. `working` and `blocked` never move the status; `done`
 * moves the task from in_progress to review once. A handoff replaces the task's `## Handoff`, with
 * obvious secrets taken out first, and lands before that move in the same batch.
 */

/** Under the bridge script's 15 s, so a slow plan answers "queued" before the agent hears "unreachable". */
const WAIT_MS = 10_000;
const QUEUED = "Your report is queued; the plan is busy syncing. No need to send it again.";

type SpaceSync = NonNullable<ReturnType<Dashboard["spaces"]["get"]>>;

/** Records operations and adds every refusal to `notes`; "late" when the plan stayed busy. */
async function recordOps(space: SpaceSync, ops: Operation[], notes: string[], waitMs: number): Promise<"late" | "done"> {
  if (!ops.length) return "done";
  const { outcomes, forget } = space.sync.record(ops);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), waitMs)));
  const result = await Promise.race([outcomes, late]).finally(() => clearTimeout(timer));
  if (result === "late") {
    forget();
    return "late";
  }
  for (const op of ops) {
    const outcome = result.get(op.op_id) as Outcome | undefined;
    if (outcome && (outcome.status === "refused" || outcome.status === "dropped")) notes.push(`${op.kind} not recorded: ${outcome.reason}`);
  }
  return "done";
}

export async function handleTool(
  dashboard: Dashboard,
  run: RunRecord,
  tool: string,
  args: unknown,
  options: { now?: () => Date; waitMs?: number } = {},
): Promise<ToolAnswer> {
  const now = options.now ?? (() => new Date());
  const space = dashboard.spaces.get(run.space);
  const loaded = space?.sync.plan.entities.get(run.task);
  const task = loaded?.entity as Task | undefined;
  if (!space || !loaded || task?.type !== "task") return { ok: false, text: "Your task is not in the plan any more. Stop and ask the user." };
  if (task.run_id !== run.run_id || !hasLiveRun(task)) {
    return { ok: false, text: "This run no longer holds the task: it was released, finished or started again elsewhere. Stop and ask the user." };
  }

  if (tool === "task_brief") return { ok: true, text: brief(dashboard, run, task) };
  if (tool !== "task_report") return { ok: false, text: `Unknown tool ${tool}.` };

  const parsed = reportSchema.safeParse(args);
  if (!parsed.success) return { ok: false, text: `Not recorded: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.` };
  const report = parsed.data;
  const at = now().toISOString();
  const ops: Operation[] = [];
  const notes: string[] = [];

  const acceptance = loaded.acceptance;
  const ticked = new Set(acceptance.filter((a) => a.done).map((a) => a.text));
  for (const item of report.done ?? []) {
    const line =
      typeof item === "number"
        ? acceptance[item - 1]
        : (acceptance.find((a) => a.text === item) ?? acceptance.find((a) => a.text.toLowerCase() === item.toLowerCase()));
    if (!line) {
      notes.push(`no acceptance line ${typeof item === "number" ? `number ${item}` : `«${item}»`}`);
      continue;
    }
    if (ticked.has(line.text)) continue;
    ticked.add(line.text);
    ops.push({ op_id: opaqueId("op"), kind: "check", id: task.id, line: line.text, done: true, run_id: run.run_id });
  }

  if (report.pr_url) {
    // A claim, not a fact: the PR/MR tracker checks it against the run's repository and branch.
    run.reportedPr = report.pr_url;
    dashboard.runs?.save();
    setTimeout(() => dashboard.checkPrs(run), 0);
    notes.push("the merge request link is noted and will be checked against this task's branch");
  }

  if (report.handoff !== undefined) {
    const redacted = redactSecrets(report.handoff);
    ops.push({ op_id: opaqueId("op"), kind: "handoff", id: task.id, run_id: run.run_id, text: redacted.text, at });
    if (redacted.count) notes.push(`${redacted.count} secret-looking value(s) in the handoff were replaced with [redacted]`);
  }

  // One batch, applied in order: the progress operation counts the ticks the file has once the
  // ticks before it applied, so a refused tick is never counted and nothing is split off.
  const note = report.state === "blocked" ? `blocked: ${report.blocker ?? report.note ?? "no reason given"}` : report.note;
  if (note !== undefined || ops.length) {
    ops.push({ op_id: opaqueId("op"), kind: "progress", id: task.id, run_id: run.run_id, note: note ?? task.progress_note ?? "", at });
  }
  if (report.state === "done" && task.status === "in_progress") {
    ops.push({ op_id: opaqueId("op"), kind: "transition", id: task.id, to: "review", run_id: run.run_id, at });
  }
  if ((await recordOps(space, ops, notes, options.waitMs ?? WAIT_MS)) === "late") return { ok: true, text: QUEUED };

  const latest = space.sync.plan.entities.get(task.id);
  const after = latest?.entity as Task | undefined;
  const summary = [
    `Recorded for ${task.id}.`,
    acceptance.length ? `${(latest?.acceptance ?? acceptance).filter((a) => a.done).length} of ${acceptance.length} acceptance lines done.` : "",
    after && after.status !== task.status ? `The task is now ${after.status}.` : "",
    report.handoff !== undefined && latest?.handoff?.run_id === run.run_id ? "Your handoff is saved for the next run." : "",
    notes.length ? `Notes: ${notes.join("; ")}.` : "",
  ];
  return { ok: true, text: summary.filter(Boolean).join(" ") };
}

function brief(dashboard: Dashboard, run: RunRecord, task: Task): string {
  const plan = dashboard.spaces.get(run.space)!.sync.plan;
  const loaded = plan.entities.get(task.id)!;
  const deps = task.depends_on.map((ref) => {
    const other = plan.entities.get(refId(ref) ?? "")?.entity;
    return other ? `- ${other.id} «${other.title}»: ${other.status}` : `- ${ref}: not found`;
  });
  return [
    `${task.id} · ${task.title}`,
    `Status: ${task.status} · branch ${run.branch} · project ${task.project ?? ""}`,
    "",
    "Brief:",
    loaded.brief || "(no brief)",
    "",
    "Acceptance:",
    loaded.acceptance.length ? loaded.acceptance.map((a, i) => `${i + 1}. [${a.done ? "x" : " "}] ${a.text}`).join("\n") : "(none listed)",
    "",
    ...(loaded.clarifications ? ["Clarifications (the user's; follow them where they disagree with the brief or acceptance):", loaded.clarifications, ""] : []),
    "Dependencies:",
    deps.length ? deps.join("\n") : "(none)",
    ...(task.links.length ? ["", "Links:", ...task.links.map((l) => `- ${l}`)] : []),
    ...(loaded.handoff ? ["", `${handoffTitle(loaded.handoff, run.run_id)}:`, loaded.handoff.text] : []),
  ].join("\n");
}

/** Whose handoff it is, as the agent reads it. */
function handoffTitle(handoff: Handoff, runId: string): string {
  if (handoff.run_id === runId) return `Handoff (yours, ${handoff.at})`;
  return handoff.run_id ? `Handoff from the previous run (${handoff.run_id}, ${handoff.at})` : "Handoff";
}
