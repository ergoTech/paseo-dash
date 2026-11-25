import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Task } from "../shared/model.ts";
import { refId } from "../shared/model.ts";
import type { autopilotReadRpc, autopilotSetRpc, autopilotStartOptionsRpc, tasksNextRpc, tasksStartReadyRpc } from "../shared/ui.ts";
import { DEFAULT_START } from "./autopilot.ts";
import { humanWork, sortTasks, taskSection } from "./api/view.ts";
import { agentHold, agentHoldOf } from "./api/start-verdict.ts";
import { planStart } from "./api/reads.ts";
import { startTask, type WriteContext } from "./api/writes.ts";

/** "Start next", "Start ready tasks" and the autopilot's settings (D24): starting more than one task at a time. */

/**
 * A start begins only this early in the call: one claim may take up to 22 s (fetch 6, push 10, deciding
 * fetch 6; server/sync/space-sync.ts) after a few seconds of git reads, and Paseo waits 30 s. In
 * practice the first start or two; another press starts the rest.
 */
export const START_READY_BUDGET_MS = 3_000;

function notOwner(ctx: WriteContext): string {
  return !ctx.dashboard.owner && ctx.dashboard.ownerReason ? ctx.dashboard.ownerReason : "";
}

/** Ready to start from this Mac: ready in the plan, and its project mapped here. */
function startable(ctx: WriteContext, space: string, task: Task): boolean {
  const entry = ctx.dashboard.spaces.get(space);
  return Boolean(entry && task.project && entry.record.mapping[task.project] && taskSection(entry.sync.plan, task) === "ready");
}

export function nextTask(ctx: WriteContext, input: RpcInput<typeof tasksNextRpc>): RpcOutput<typeof tasksNextRpc> {
  const empty = { task: "", title: "", space: "", passed_over: "", error: "" };
  const owner = notOwner(ctx);
  if (owner) return { ...empty, error: owner };
  const wanted = input.space?.trim().toUpperCase();
  const items = [...ctx.dashboard.spaces.values()]
    .filter(({ record }) => !wanted || record.key === wanted)
    .flatMap(({ record, sync }) =>
      [...sync.plan.entities.values()]
        .map((l) => l.entity)
        .filter((e): e is Task => e.type === "task" && startable(ctx, record.key, e))
        .map((task) => ({ plan: sync.plan, task, space: record.key })),
    );
  const sorted = sortTasks(items);
  if (!sorted.length) return { ...empty, error: "No task is ready to start from this Mac: none is todo with nothing to wait for and its project mapped here." };
  const at = sorted.findIndex(({ plan, task }) => !agentHold(ctx.dashboard, plan, task));
  if (at < 0) return { ...empty, error: `No task is ready for an agent from this Mac. Ready, but left to a person: ${agentHoldOf(ctx.dashboard, sorted)}. To give one to an agent, start it from its own screen.` };
  const first = sorted[at]!;
  return { task: first.task.id, title: first.task.title, space: first.space, passed_over: at ? `Passed over ${agentHoldOf(ctx.dashboard, sorted.slice(0, at))}.` : "", error: "" };
}

/**
 * Starts the ready tasks of a feature the confirmation named, one after another, in list order: each
 * as the autopilot does, only with instructions the person has seen as they are now (a brief someone
 * else changed waits until it is opened once).
 */
export async function startReady(ctx: WriteContext, input: RpcInput<typeof tasksStartReadyRpc>): Promise<RpcOutput<typeof tasksStartReadyRpc>> {
  const out: RpcOutput<typeof tasksStartReadyRpc> = { started: [], skipped: [], error: "" };
  const owner = notOwner(ctx);
  if (owner) return { ...out, error: owner };
  const id = input.feature.trim().toUpperCase();
  const entry = [...ctx.dashboard.spaces.values()].find(({ sync }) => sync.plan.entities.get(id)?.entity.type === "feature");
  if (!entry) return { ...out, error: `No feature ${input.feature}.` };
  const plan = entry.sync.plan;
  const own = [...plan.entities.values()].map((l) => l.entity).filter((e): e is Task => e.type === "task" && refId(e.feature) === id);
  // Each start answers once its claim is decided; past this budget the rest wait for another press,
  // so the answer stays inside Paseo's 30 s.
  const until = Date.now() + START_READY_BUDGET_MS;
  const named = new Set(input.tasks.map((t) => t.trim().toUpperCase()));
  // A named task no longer of this feature (moved or deleted since the confirmation) is said, not dropped.
  for (const id of named) if (!own.some((t) => t.id === id)) out.skipped.push({ id, title: plan.entities.get(id)?.entity.title ?? id, reason: "no longer a task of this feature" });
  for (const { task } of sortTasks(own.map((task) => ({ plan, task })))) {
    if (!named.has(task.id)) continue;
    if (taskSection(plan, task) !== "ready") {
      out.skipped.push({ id: task.id, title: task.title, reason: `it is ${taskSection(plan, task)} now` });
      continue;
    }
    const human = agentHold(ctx.dashboard, plan, task);
    if (human) {
      out.skipped.push({ id: task.id, title: task.title, reason: `${human}; start it from its own screen to give it to an agent` });
      continue;
    }
    if (Date.now() > until) {
      out.skipped.push({ id: task.id, title: task.title, reason: "not started yet: a few start per press, to answer in time; press Start ready tasks again" });
      continue;
    }
    if (!startable(ctx, entry.record.key, task)) {
      out.skipped.push({ id: task.id, title: task.title, reason: `project ${task.project ?? "(none)"} is not mapped on this Mac` });
      continue;
    }
    const checked = await planStart(ctx, { task: task.id });
    if (!("found" in checked)) {
      out.skipped.push({ id: task.id, title: task.title, reason: checked.error });
      continue;
    }
    const unseen = checked.instructions.filter((part) => part.state !== "unchanged");
    if (unseen.length) {
      out.skipped.push({ id: task.id, title: task.title, reason: `open it once: ${unseen.map((p) => p.name).join(", ")} not seen by you as it is now` });
      continue;
    }
    const started = await startTask(ctx, { task: task.id }, { seen: checked.instructions.map((part) => part.hash), automatic: true }).catch((error: unknown) => ({ ok: false, error: String((error as Error)?.message ?? error) }));
    if (started.ok) out.started.push({ id: task.id, title: task.title });
    else out.skipped.push({ id: task.id, title: task.title, reason: started.error });
  }
  return out;
}

export function readAutopilot(ctx: WriteContext): RpcOutput<typeof autopilotReadRpc> {
  const autopilot = ctx.dashboard.autopilot;
  const owner = notOwner(ctx);
  if (owner || !autopilot) return { flags: [], max_running: 0, running: 0, runs: [], started: [], limit: { until: "", source: "" }, start: { ...DEFAULT_START }, error: owner || "Paseo Dash has not started" };
  const read = autopilot.read();
  return {
    flags: read.flags.map((f) => ({ space: f.space, task: f.task ?? "", project: f.project ?? "", title: f.title, state: f.state, paused: f.paused })),
    max_running: read.max_running,
    running: read.running,
    runs: read.runs,
    started: read.started.map(({ space, task, title, project, at }) => ({ space, task, title, project, at })),
    limit: read.limit,
    start: autopilot.startDefaults(),
    error: "",
  };
}

export function setAutopilot(ctx: WriteContext, input: RpcInput<typeof autopilotSetRpc>): RpcOutput<typeof autopilotSetRpc> {
  const autopilot = ctx.dashboard.autopilot;
  const owner = notOwner(ctx);
  if (owner || !autopilot) return { ok: false, error: owner || "Paseo Dash has not started" };
  const space = input.space?.trim().toUpperCase() ?? "";
  // A flag is a space's; only the limit, this Mac's, needs none.
  if (!space && (input.task || input.project || input.on !== undefined || input.resume)) return { ok: false, error: "Name the space of the flag." };
  // Refused before anything changes: a mode id is one provider's.
  if (input.start_mode && !input.start_mode_provider) return { ok: false, error: "Name the provider of the mode." };
  // Turning on needs the task or project in the plan; turning off or resuming acts on the stored flag,
  // also when what it named has left the plan.
  if (input.on) {
    const entry = ctx.dashboard.spaces.get(space);
    if (!entry) return { ok: false, error: `No space ${input.space}.` };
    if (input.task) {
      const task = entry.sync.plan.entities.get(input.task.trim().toUpperCase())?.entity;
      if (task?.type !== "task") return { ok: false, error: `No task ${input.task} in ${space}.` };
      if (task.status !== "todo") return { ok: false, error: `${task.id} is ${task.status}; the autopilot starts only a todo task.` };
      const human = agentHold(ctx.dashboard, entry.sync.plan, task);
      if (human) return { ok: false, error: `${task.id}: ${human}; the autopilot does not start it. Start it from its own screen to give it to an agent.` };
    }
    if (input.project && !Object.hasOwn(entry.sync.plan.space?.projects ?? {}, input.project)) return { ok: false, error: `No project ${input.project} in ${space}.` };
  }
  const key = { task: input.task?.trim().toUpperCase(), project: input.project };
  // A flag changes only when `on` is given; the limit alone changes nothing else.
  if (input.on !== undefined || input.max_running) autopilot.set({ space, ...(input.on !== undefined ? key : {}), on: input.on ?? false, max_running: input.max_running });
  if (input.resume) autopilot.resume(space, key);
  if (input.start_new_tasks !== undefined || input.start_mode || input.start_effort || input.start_auto_model !== undefined) {
    autopilot.setStartDefaults({
      new_tasks: input.start_new_tasks,
      mode: input.start_mode,
      mode_provider: input.start_mode_provider,
      effort: input.start_effort,
      auto_model: input.start_auto_model,
    });
  }
  // A change of flags or of the limit is worth a pass at once rather than at the next sync, also when a
  // pass under way read them before the change.
  void autopilot.pass(ctx, true).catch(() => undefined);
  return { ok: true, error: "" };
}

/** The modes and efforts of this Mac's default provider and model, for picking the start defaults. */
export async function autopilotStartOptions(ctx: WriteContext): Promise<RpcOutput<typeof autopilotStartOptionsRpc>> {
  const empty = { provider: "", modes: [], efforts: [] };
  const owner = notOwner(ctx);
  if (owner) return { ...empty, error: owner };
  const paseo = ctx.dashboard.paseo;
  if (!paseo) return { ...empty, error: "Paseo has not connected to Paseo Dash yet" };
  const read = await ctx.dashboard.profiles.options(paseo).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
  return "error" in read ? { ...empty, error: read.error } : { ...read, error: "" };
}
