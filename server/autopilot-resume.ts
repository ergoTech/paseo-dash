import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { hasLiveRun, type Task } from "../shared/model.ts";
import type { resumeCheckRpc, resumeTaskRpc } from "../shared/api.ts";
import { resolveEntity } from "./api/resolve.ts";
import { blockingTasks, taskSection } from "./api/view.ts";
import type { WriteContext } from "./api/writes.ts";
import { type RunActivity, runActivity } from "./needs.ts";

/**
 * Resuming one paused task flag of this Mac's autopilot through ChatGPT (06-god-mode.md, Resuming a
 * paused task; JOBBY-TGHP0). The same as Resume in Live → Autopilot (`autopilot.set` with `resume`):
 * the pause of that one flag is cleared, and nothing else changes, neither the limit, nor the start
 * defaults, nor any other flag, nor the instructions the flag counts as seen. The autopilot then
 * starts the task as it starts any flagged one, under all its rules.
 *
 * Only a task flag: a project's flag starts one task after another, which is the kind of switch the
 * user turns on in Paseo Dash, not through ChatGPT. A resume may start an agent later with nobody
 * watching, so God Mode always reads it back first, also while this Mac starts without asking: that
 * switch covers a start the user asks for in their own words, not a flag that starts on its own.
 */

type Check = RpcOutput<typeof resumeCheckRpc>;
type Resumed = RpcOutput<typeof resumeTaskRpc>;
type State = Check["state"];

/**
 * How long a resume waits for the autopilot's pass to show what became of the task. A claim alone may
 * take longer than Paseo waits for an RPC (START_READY_BUDGET_MS in server/queue.ts); past this the
 * answer says what it sees then, and the pass goes on.
 */
export const RESUME_WAIT_MS = 5_000;

interface Found {
  space: string;
  task: Task;
  paused: string;
}

type Refusal = Pick<Check, "task" | "title" | "space" | "state" | "error" | "next">;

const READ_TASK = (id: string) => `read task ${id} for what its agent does`;

function notOwner(ctx: WriteContext): string {
  return !ctx.dashboard.owner && ctx.dashboard.ownerReason ? ctx.dashboard.ownerReason : "";
}

/** A task with a run, or past the point where the autopilot could start it: what it is now. */
function startedState(ctx: WriteContext, task: Task): { state: State; agent: RunActivity | "" } | undefined {
  if (hasLiveRun(task)) {
    const agent = runActivity(ctx.dashboard, task);
    return { state: agent === "launching" || agent === "working" ? agent : "started", agent };
  }
  if (task.status === "done" || task.status === "canceled") return { state: "finished", agent: "" };
  if (task.status === "in_progress" || task.status === "review") return { state: "started", agent: "" };
  return undefined;
}

/** The paused task flag the user named, or why there is nothing to resume, with what to do instead. */
function find(ctx: WriteContext, asked: string): { ok: true; value: Found } | { ok: false; refusal: Refusal } {
  // God Mode turns a refused target read into "its target could not be read: <error>", cut at 300
  // characters, and drops `next`: the next step goes into the error too, before the long details.
  const refuse = (state: State, fact: string, next: string, task?: Task, space = "", details = ""): { ok: false; refusal: Refusal } => ({
    ok: false,
    refusal: { task: task?.id ?? "", title: task?.title ?? "", space, state, error: [fact, `Next: ${next}.`, details].filter(Boolean).join(" "), next },
  });
  const owner = notOwner(ctx);
  const autopilot = ctx.dashboard.autopilot;
  if (owner || !autopilot) return refuse("not_queued", owner || "Paseo Dash has not started its autopilot on this Mac.", "nothing to resume here");
  const resolved = resolveEntity([...ctx.dashboard.spaces.values()], "task", asked);
  if (!resolved.ok) return refuse("not_found", resolved.error, "find it with tasks; the autopilot read lists the paused flags");
  const { entity: task, space: entry } = resolved.value;
  const space = entry.record.key;
  const started = startedState(ctx, task);
  if (started) {
    const what = started.state === "finished" ? `is ${task.status}` : started.agent ? `already started: its agent is ${started.agent}` : `is already ${task.status}`;
    return refuse(started.state, `${task.id} ${what}; nothing to resume, nothing started again.`, READ_TASK(task.id), task, space);
  }
  const paused = autopilot.pausedFlag(space, task.id);
  if (paused === undefined) {
    const flags = autopilot.read().flags;
    const own = flags.find((f) => f.space === space && f.task === task.id);
    if (own) {
      return refuse("queued", `${task.id} is not paused: it is queued on this Mac's autopilot.`, "nothing to resume; the autopilot read says what it waits for", task, space, own.state ? `Now: ${own.state}` : "");
    }
    const line = flags.find((f) => f.space === space && f.project && f.project === task.project && f.paused);
    if (line) {
      return refuse(
        "not_queued",
        `${task.id} has no autopilot flag of its own on this Mac; its project ${line.project}'s flag is paused.`,
        "only the user resumes a project's flag, in Paseo Dash: Live, Autopilot",
        task,
        space,
        `Why: ${line.state}`,
      );
    }
    return refuse("not_queued", `${task.id} is not on this Mac's autopilot; nothing to resume.`, "to start it now, start_task", task, space);
  }
  const section = taskSection(entry.sync.plan, task);
  if (section !== "ready") {
    const by = blockingTasks(entry.sync.plan, task).map((b) => b.id);
    const why = by.length ? `blocked by ${by.join(", ")}` : section;
    return refuse("blocked", `${task.id} is ${why}: resumed now it would only wait; its flag stays paused.`, "resume it once it is ready", task, space, `Paused: ${paused}`);
  }
  return { ok: true, value: { space, task, paused } };
}

/**
 * God Mode's read-back of resume_task. Its shown fields stay the same while the flag does: a pause
 * written again with another reason, or another limit, reads differently and is read back again.
 */
export function resumeCheck(ctx: WriteContext, input: RpcInput<typeof resumeCheckRpc>): Check {
  const found = find(ctx, input.task);
  if (!found.ok) return { ...found.refusal, paused: "", then: "" };
  const { space, task, paused } = found.value;
  const max = ctx.dashboard.autopilot!.read().max_running;
  return {
    task: task.id,
    title: task.title,
    space,
    paused,
    then: `Once resumed, this Mac's autopilot may start it on its own, with no further question: at a check of the plans, while fewer than ${max} of this Mac's runs are at work and no usage limit holds starts.`,
    state: "paused",
    next: "",
    error: "",
  };
}

/** Where the task stands after a resume: queued, launching, working, or paused again by a failed start. */
function afterResume(ctx: WriteContext, space: string, id: string, checked: boolean): Omit<Resumed, "ok" | "task" | "title" | "error"> {
  const task = ctx.dashboard.spaces.get(space)?.sync.plan.entities.get(id)?.entity as Task | undefined;
  const started = task && startedState(ctx, task);
  if (started) {
    const next =
      started.state === "launching"
        ? "its agent is being started, not working yet: read the task to hear when it works"
        : started.state === "working"
          ? "its agent is at work"
          : READ_TASK(id);
    return { state: started.state, agent: started.agent, wait: "", next };
  }
  const autopilot = ctx.dashboard.autopilot!;
  const paused = autopilot.pausedFlag(space, id);
  if (paused !== undefined) return { state: "paused", agent: "", wait: paused, next: "its start failed again: tell the user why; it stays paused until they resume it" };
  const flag = autopilot.read().flags.find((f) => f.space === space && f.task === id);
  if (flag) {
    return {
      state: "queued",
      agent: "",
      // Before the pass ends, the last finished pass's state is from before the resume.
      wait: checked ? flag.state || "the autopilot is starting it" : "the autopilot's check is under way",
      next: "it starts on its own once the autopilot lets it; then the task reads launching (being started), then working",
    };
  }
  return { state: "not_queued", agent: "", wait: "", next: "its flag was removed meanwhile: nothing will start it on its own" };
}

/**
 * Clears the pause of the named task's flag, as Live → Autopilot's Resume does, after the same
 * checks as the read-back: a call confirmed before the flag changed finds it as it is now. Then it
 * waits a little for the autopilot's pass, so the answer can tell queued from launching and working.
 */
export async function resumeTask(ctx: WriteContext, input: RpcInput<typeof resumeTaskRpc>): Promise<Resumed> {
  const found = find(ctx, input.task);
  if (!found.ok) {
    const { task, title, state, error, next } = found.refusal;
    return { ok: false, task, title, state, agent: "", wait: "", next, error };
  }
  const { space, task } = found.value;
  const autopilot = ctx.dashboard.autopilot!;
  autopilot.resume(space, { task: task.id });
  console.error(`dashboard: autopilot flag of ${task.id} resumed through ChatGPT`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checked = false;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RESUME_WAIT_MS);
  });
  try {
    checked = await Promise.race([
      autopilot.passNow(ctx).then(
        () => true,
        (error: unknown) => (console.error(`dashboard: autopilot pass failed: ${String(error)}`), false),
      ),
      wait.then(() => false),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, task: task.id, title: task.title, ...afterResume(ctx, space, task.id, checked), error: "" };
}
