import type { NEW_START_STATES } from "../shared/api.ts";
import type { Task } from "../shared/model.ts";
import type { LoadedEntity } from "./plan/load.ts";
import type { SpaceEntry } from "./api/resolve.ts";
import { instructionsParts } from "./api/reads.ts";
import { humanWork, taskSection } from "./api/view.ts";
import type { WriteContext } from "./api/writes.ts";
import { startWithoutAsking } from "./godmode-settings.ts";
import { pickForTask, taskSignals } from "./runner/model-policy.ts";
import { hashText, taskInstructions, taskPartKey } from "./runner/seen.ts";

/**
 * A new task created ready asks for its start (JOBBY-H3ZEX): on this Mac, unless a person turned
 * "Start new ready tasks" off in Settings → Autopilot or asked for To Do only, the task gets an
 * autopilot flag. The autopilot then starts it once, as it starts any flagged task: under its limit
 * of runs at work (a full limit keeps the flag waiting, with its state in Live and the next pass after
 * each sync trying again), only what an ordinary start would start, never a person's work, with the
 * mode and effort of every start (server/runner/profiles.ts: this Mac's defaults below the profile's).
 *
 * Nothing here widens who may start: a task ChatGPT creates through God Mode is flagged only while this
 * Mac lets ChatGPT start without asking (06-god-mode.md, Starting without asking); otherwise its answer
 * names the one step left, start_task of that task, whose read-back the user answers.
 */

export type NewStartState = (typeof NEW_START_STATES)[number];

export interface NewStart {
  /**
   * "": not a todo task, nothing to start. queued: flagged; the autopilot starts it once a slot is free.
   * todo_only: kept in To Do (asked so, or this Mac's setting is off). waits: not started, `note` says
   * why (blocked, open questions, a person's work, not mapped here). asks_first: ChatGPT may start it
   * only through start_task's read-back.
   */
  start: NewStartState;
  note: string;
}

/** Who created the task: a person in Paseo Dash, or any other caller of tasks.create (God Mode). */
export type CreatedBy = "dashboard" | "chatgpt";

const NONE = /^[-*>\s]*(?:none|no|nothing|n\/a|немає|нема|нет|—|–|-)?[.!\s]*$/i;
/** "## Open questions", "Open questions:", "**Open questions:** …", also in Ukrainian or Russian; groups: heading mark, colon (either side of the bold), the rest. */
const QUESTIONS = /^\s*(#{1,6}\s+)?(?:\*\*)?(?:open questions|відкриті питання|открытые вопросы)\s*(:)?\s*(?:\*\*)?\s*(:)?\s*(.*)$/i;
const ANY_HEADING = /^\s*#{1,6}\s/;
/** A line that starts another labeled part: "Notes:", "**Notes:**"; one that ends in "?" is a question, not a label. */
const LABEL = /^\s*(?:\*\*[^*]+\*\*|[\p{L}' ]{1,40}:)(?:\s|$)/u;
/** A checklist item ticked as answered. */
const CLOSED = /^\s*[-*]\s*\[[xX]\]/;

/**
 * The first open question a brief lists under an "Open questions" heading or labeled line (also in
 * Ukrainian or Russian), "" when it lists none, only "none", or only ticked items. Prose that merely
 * mentions open questions is no heading. Under a heading the list ends at a blank line after it, at
 * the next heading or at another labeled line. A question left open is the person's to answer before
 * an agent runs on the brief.
 */
export function openQuestion(brief: string): string {
  const lines = brief.split("\n");
  const open = (line: string) => line.trim() !== "" && !NONE.test(line.trim()) && !CLOSED.test(line);
  const said = (line: string) => line.trim().replace(/^[-*>\s]+(?:\[ \]\s*)?/, "").replace(/\*\*/g, "").slice(0, 160);
  for (let i = 0; i < lines.length; i += 1) {
    const m = QUESTIONS.exec(lines[i]!);
    if (!m) continue;
    const rest = m[4] ?? "";
    // "Open questions are tracked elsewhere": a sentence, not a heading.
    if (!m[1] && !m[2] && !m[3] && rest) continue;
    if (rest) {
      if (open(rest)) return said(rest);
      continue;
    }
    let listed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (ANY_HEADING.test(line) || (LABEL.test(line) && !line.trim().endsWith("?")) || QUESTIONS.test(line)) break;
      if (!line.trim()) {
        if (listed) break;
        continue;
      }
      listed = true;
      if (open(line)) return said(line);
    }
  }
  return "";
}

/**
 * Asks for the start of a task just created, as the module comment says. `asked`: the caller's own
 * choice (true: start once ready; false: To Do only); absent follows this Mac's setting.
 */
export async function startNew(ctx: WriteContext, space: SpaceEntry, id: string, by: CreatedBy, asked: boolean | undefined): Promise<NewStart> {
  const loaded = space.sync.plan.entities.get(id);
  const task = loaded?.entity;
  if (task?.type !== "task" || task.status !== "todo") return { start: "", note: "" };
  const autopilot = ctx.dashboard.autopilot;
  if (asked === false) return { start: "todo_only", note: "kept in To Do as asked: nothing starts it; start it when you want" };
  if (!autopilot) return { start: "todo_only", note: "Paseo Dash has not started its autopilot on this Mac; start it when you want" };
  const defaults = autopilot.startDefaults();
  if (asked === undefined && !defaults.new_tasks) {
    return { start: "todo_only", note: "kept in To Do: this Mac does not start new tasks on its own (Settings → Autopilot → Start new ready tasks)" };
  }
  const why = waitReason(space, task, loaded!.brief);
  if (why) return { start: "waits", note: why };
  const key = space.record.key;
  if (by === "chatgpt" && !startWithoutAsking(ctx.dashboard.dataDir)) {
    return { start: "asks_first", note: `not started: on this Mac a start through ChatGPT is read back first. Call start_task with task ${id} now: its read-back is the one question` };
  }
  let accepted: string[] = [];
  if (by === "dashboard") {
    // The person wrote this brief here: its text counts as seen. The space's start template does not;
    // a version someone else wrote waits until it is opened once, as for every autopilot start.
    const text = taskInstructions(loaded!.brief, loaded!.acceptance.map((a) => a.text), loaded!.handoff?.text, loaded!.clarifications);
    ctx.dashboard.seen?.mark(key, { key: taskPartKey(id), text });
  } else {
    // As a start without asking: the user heard of the text through ChatGPT; nothing is marked seen.
    accepted = (await instructionsParts(space, loaded!)).map((part) => hashText(part.text));
  }
  autopilot.queue(key, [{ task: id, accepted }]);
  void autopilot.pass(ctx, true).catch(() => undefined);
  return { start: "queued", note: await queuedNote(ctx, space, task, loaded!) };
}

/** Why a new todo task is not given to the autopilot; "" when nothing holds it back. */
function waitReason(space: SpaceEntry, task: Task, brief: string): string {
  const plan = space.sync.plan;
  const human = humanWork(plan, task);
  if (human) return `not started: ${human}; start it from its own screen to give it to an agent`;
  const section = taskSection(plan, task);
  if (section === "blocked") return "not started: it waits for other tasks to be done; start it once they are";
  if (section !== "ready") return `not started: it is ${section}`;
  const question = openQuestion(brief);
  if (question) return `not started: its brief has an open question (${question}); answer it, then start the task`;
  if (!task.project || !space.record.mapping[task.project]) return `not started: project ${task.project ?? "(none)"} is not mapped on this Mac`;
  return "";
}

/** What the queued flag will start with and what it waits for now, as Live shows it. */
async function queuedNote(ctx: WriteContext, space: SpaceEntry, task: Task, loaded: LoadedEntity): Promise<string> {
  const read = ctx.dashboard.autopilot!.read();
  const slots = read.running >= read.max_running ? `; all ${read.max_running} slots are in use, so it waits in the queue and starts once one is free` : "";
  const paseo = ctx.dashboard.paseo;
  const macStart = ctx.dashboard.autopilot!.startDefaults();
  const choice = paseo
    ? await ctx.dashboard.profiles
        .choose(paseo, {
          task: task.agent_profile,
          space: space.sync.plan.space?.defaults.agent_profile,
          mode: { space: space.sync.plan.space?.defaults.mode, mac: { id: macStart.mode, provider: macStart.mode_provider } },
          macEffort: macStart.effort,
          // As every start picks (server/api/reads.ts planStart): the note says what the start will use.
          policy: macStart.auto_model ? pickForTask(taskSignals(task, loaded)) : undefined,
        })
        .catch(() => undefined)
    : undefined;
  const settings = choice?.ok ? ` on ${choice.settings.modelId} in ${choice.settings.mode}, effort ${choice.settings.effort}` : "";
  return `queued on this Mac's autopilot: it starts once${settings}${slots}`;
}
