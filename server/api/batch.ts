import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { TEXT_CHUNK, type taskTextRpc, type tasksProfilesRpc, type updateTasksCheckRpc, type updateTasksRpc } from "../../shared/api.ts";
import { hasLiveRun, type Task } from "../../shared/model.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";
import type { LoadedEntity } from "../plan/load.ts";
import { opaqueId } from "../plan/ids.ts";
import type { AgentProfile } from "../runner/profiles.ts";
import { pickForTask, taskSignals } from "../runner/model-policy.ts";
import type { Operation } from "../sync/ops.ts";
import type { ReadContext } from "./reads.ts";
import { type FoundEntity, resolveEntity, resolveTaskForRead, type SpaceEntry } from "./resolve.ts";
import { cut, localRun } from "./view.ts";
import { ownerError, record, refusal, Unknown, type WriteContext } from "./writes.ts";

/**
 * Batches and full text for God Mode (06-god-mode.md, Batches): the agent profiles of many tasks read
 * and set in one call, and a task's long sections read in parts. Setting a profile writes that one
 * field: the status, the order, the dependencies and the run stay, and an agent at work keeps its
 * model until its task's next start.
 *
 * An update_tasks call carries the revision its read-back showed and a key of its own. The key's
 * checkpoint (`batches.json` on this Mac) holds each item's value before and its result, written
 * before the plan is touched and after: a retry after a timeout reports what was delivered and
 * applies only the rest, against the values the read-back showed, so it never overwrites a change
 * someone made in between.
 */

/** Checkpoints kept, newest last; older keys are forgotten (a retry comes within minutes). */
const KEEP_BATCHES = 50;

const checkpointItem = z.object({
  id: z.string(),
  /** The profile asked for; null takes it off. */
  wanted: z.string().nullable(),
  /** The profile when the batch was first accepted; null when the task had none. */
  before: z.string().nullable(),
  result: z.enum(["pending", "applied", "already", "refused", "unknown"]),
  error: z.string().optional(),
});

const checkpoint = z.object({
  key: z.string(),
  /** The request's own hash: a key used again for another request is refused. */
  request: z.string(),
  revision: z.string(),
  at: z.string(),
  items: z.array(checkpointItem),
});
type Checkpoint = z.output<typeof checkpoint>;

const fileSchema = z.object({ version: z.literal(1), batches: z.array(checkpoint) });

/** The checkpoints of update_tasks on this Mac (`plugin-data/dashboard/batches.json`, 0600). */
export class BatchStore {
  private readonly path: string;
  private batches: Checkpoint[];

  constructor(dataDir: string) {
    this.path = join(dataDir, "batches.json");
    this.batches = readJsonFile(this.path, fileSchema, () => ({ version: 1 as const, batches: [] })).value.batches;
  }

  get(key: string): Checkpoint | undefined {
    return this.batches.find((b) => b.key === key);
  }

  put(batch: Checkpoint): void {
    this.batches = [...this.batches.filter((b) => b.key !== batch.key), batch].slice(-KEEP_BATCHES);
    writeJsonFile(this.path, { version: 1, batches: this.batches });
  }
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The revision of tasks' profiles as read: changes when any of their profiles does. */
export function profilesRevision(tasks: Pick<Task, "id" | "agent_profile">[]): string {
  // Each task once: a task named twice is one task.
  return hash(
    [...new Map(tasks.map((t) => [t.id, t])).values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => `${t.id}=${t.agent_profile ?? ""}`)
      .join("\n"),
  );
}

function notOwner(ctx: ReadContext): string {
  return !ctx.dashboard.owner && ctx.dashboard.ownerReason ? ctx.dashboard.ownerReason : "";
}

/** The profile as a start would use it: "Sonnet 5.5 High: claude/claude-sonnet-5-5, effort high". */
function profileText(profile: AgentProfile): string {
  const model = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
  return `${profile.name}: ${model}${profile.thinkingOptionId ? `, effort ${profile.thinkingOptionId}` : ""}`;
}

/** What the task's next start uses: its profile, the space's, the model policy, or this Mac's defaults. */
export function nextStart(ctx: ReadContext, space: SpaceEntry, task: Task, loaded: LoadedEntity, profiles: AgentProfile[] | undefined): string {
  const named = task.agent_profile ?? space.sync.plan.space?.defaults.agent_profile;
  const whose = task.agent_profile ? "its profile" : "the space's profile";
  if (named) {
    if (!profiles) return `${whose} ${named} (this Mac's profiles could not be read)`;
    const found = profiles.find((p) => p.name.toLowerCase() === named.toLowerCase());
    return found ? `${whose} ${profileText(found)}` : `${whose} ${named}, which this Mac has no profile of: a start refuses it`;
  }
  if (ctx.dashboard.autopilot?.startDefaults().auto_model === false) return "this Mac's start defaults (the per-task pick is off)";
  const pick = pickForTask(taskSignals(task, loaded));
  return `the per-task pick: ${pick.model}, effort ${pick.effort} (${pick.reason})`;
}

/** The agent at work on the task now, as it was started; "" without one on this Mac. */
function runningText(ctx: ReadContext, task: Task): string {
  if (!hasLiveRun(task)) return "";
  const run = localRun(ctx.dashboard.runs, task);
  if (!run) return task.run_host ? `an agent on ${task.run_host}` : "";
  const model = run.asked?.modelId ?? "its provider's default model";
  const effort = run.reported?.effortId ?? run.asked?.effortId ?? run.asked?.effort ?? "";
  return `${model}${effort ? `, effort ${effort}` : ""} (${run.activity})`;
}

export async function loadProfiles(ctx: ReadContext): Promise<AgentProfile[] | undefined> {
  const paseo = ctx.dashboard.paseo;
  if (!paseo) return undefined;
  return (await ctx.dashboard.profiles.load(paseo).catch(() => undefined))?.profiles;
}

type Profiles = RpcOutput<typeof tasksProfilesRpc>;

export async function readProfiles(ctx: ReadContext, input: RpcInput<typeof tasksProfilesRpc>): Promise<Profiles> {
  const owner = notOwner(ctx);
  if (owner) return { tasks: [], revision: "", error: owner };
  const spaces = [...ctx.dashboard.spaces.values()];
  const profiles = await loadProfiles(ctx);
  const read: Task[] = [];
  const tasks = input.tasks.map((asked): Profiles["tasks"][number] => {
    const found = resolveTaskForRead(spaces, asked).found;
    if (!found.ok) return { task: asked, id: "", title: "", status: "", agent_profile: "", next_start: "", running: "", error: found.error };
    const { entity: task, loaded, space } = found.value;
    read.push(task);
    return {
      task: asked,
      id: task.id,
      title: task.title,
      status: task.status,
      agent_profile: task.agent_profile ?? "",
      next_start: nextStart(ctx, space, task, loaded, profiles),
      running: runningText(ctx, task),
      error: "",
    };
  });
  return { tasks, revision: profilesRevision(read), error: "" };
}

/**
 * An item of a batch resolved: its task, and the profile asked for as this Mac names it (null: none);
 * or why it is refused, with the task when one was found (it still counts in the revision, as
 * tasks_profiles counts every task it found).
 */
type Planned = { asked: string; found: FoundEntity<Task>; wanted: string | null } | { asked: string; error: string; task?: Task };

/** The tasks a batch names that were found, refused or not: what its revision is of. */
const namedTasks = (planned: Planned[]): Task[] => planned.flatMap((p) => ("found" in p ? [p.found.entity] : p.task ? [p.task] : []));

async function planItems(ctx: ReadContext, items: { task: string; agent_profile: string }[]): Promise<{ planned: Planned[]; error: string }> {
  const spaces = [...ctx.dashboard.spaces.values()];
  const needsProfiles = items.some((item) => item.agent_profile.trim());
  const profiles = needsProfiles ? await loadProfiles(ctx) : [];
  if (!profiles) return { planned: [], error: "This Mac's agent profiles could not be read (is Paseo connected?). Nothing was changed." };
  const seen = new Set<string>();
  const planned = items.map((item): Planned => {
    // A batch names tasks by id or exact title: a search's guess is never written to.
    const found = resolveEntity(spaces, "task", item.task);
    if (!found.ok) return { asked: item.task, error: found.error };
    const task = found.value.entity as Task;
    if (seen.has(task.id)) return { asked: item.task, error: `${task.id} is named twice in this batch` };
    seen.add(task.id);
    const name = item.agent_profile.trim();
    if (!name) return { asked: item.task, found: found.value as FoundEntity<Task>, wanted: null };
    const profile = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!profile) return { asked: item.task, task, error: `no agent profile «${name}» on this Mac${profiles.length ? `; profiles: ${profiles.map((p) => p.name).join(", ")}` : ""}` };
    return { asked: item.task, found: found.value as FoundEntity<Task>, wanted: profile.name };
  });
  return { planned, error: "" };
}

const shown = (profile: string | null | undefined) => profile || "(none)";

type Check = RpcOutput<typeof updateTasksCheckRpc>;

export async function updateTasksCheck(ctx: ReadContext, input: RpcInput<typeof updateTasksCheckRpc>): Promise<Check> {
  const empty = { changes: "", refused: "", revision: "", count: 0 };
  const owner = notOwner(ctx);
  if (owner) return { ...empty, error: owner };
  const { planned, error } = await planItems(ctx, input.items);
  if (error) return { ...empty, error };
  const ok = planned.filter((p): p is Extract<Planned, { found: unknown }> => "found" in p);
  const changes = ok.map((p) => {
    const before = p.found.entity.agent_profile ?? null;
    return `${p.found.entity.id} ${before === p.wanted ? `stays ${shown(before)}` : `${shown(before)} → ${shown(p.wanted)}`}`;
  });
  const refused = planned.filter((p): p is Extract<Planned, { error: string }> => "error" in p).map((p) => `${p.asked}: ${p.error}`);
  return {
    changes: cut(changes.join("; "), 600),
    refused: cut(refused.join("; "), 600),
    revision: profilesRevision(namedTasks(planned)),
    count: ok.length,
    error: "",
  };
}

type Update = RpcOutput<typeof updateTasksRpc>;
type UpdateItem = Update["items"][number];

export async function updateTasks(ctx: WriteContext, input: RpcInput<typeof updateTasksRpc>): Promise<Update> {
  const counts = { applied: 0, already: 0, refused: 0, unknown: 0 };
  const fail = (error: string): Update => ({ ok: false, key: input.key, counts, items: [], error });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const store = ctx.dashboard.batches;
  if (!store) return fail("Paseo Dash has not started on this Mac yet; try again in a moment. Nothing was changed.");
  const request = hash(JSON.stringify(input.items.map((i) => [i.task.trim(), i.agent_profile.trim()])));
  const earlier = store.get(input.key);
  if (earlier && earlier.request !== request) return fail(`The key ${input.key} was used for another batch; a new batch takes a new key. Nothing was changed.`);
  const { planned, error } = await planItems(ctx, input.items);
  if (error) return fail(error);
  const now = (ctx.now ?? (() => new Date()))();

  let batch: Checkpoint;
  if (earlier) {
    batch = earlier;
  } else {
    // First call with this key: the read-back's revision must still hold, else nothing is changed.
    const current = profilesRevision(namedTasks(planned));
    if (current !== input.revision) {
      return fail("The profiles changed since they were read (or the batch names other tasks): read tasks_profiles again and say the new changes. Nothing was changed.");
    }
    batch = {
      key: input.key,
      request,
      revision: input.revision,
      at: now.toISOString(),
      items: planned.map((p) =>
        "found" in p
          ? { id: p.found.entity.id, wanted: p.wanted, before: p.found.entity.agent_profile ?? null, result: "pending" as const }
          : { id: "", wanted: null, before: null, result: "refused" as const, error: p.error },
      ),
    };
    // Durable before the plan is touched: a timeout after this point is recovered by the key.
    store.put(batch);
  }

  // Per space, the items still to deliver: set ops that expect the value the read-back showed.
  const bySpace = new Map<SpaceEntry, { index: number; op: Operation }[]>();
  planned.forEach((p, index) => {
    const item = batch.items[index]!;
    if (!("found" in p) && item.id && (item.result === "pending" || item.result === "unknown")) {
      // Resolved on the first call, no longer on this retry (task renamed, profile gone): settle it, or the key never would.
      item.result = "refused";
      item.error = p.error;
      return;
    }
    if (!("found" in p) || item.result === "applied" || item.result === "already" || (item.result === "refused" && !item.id)) return;
    const task = p.found.space.sync.plan.entities.get(p.found.entity.id)?.entity as Task | undefined;
    const current = task?.agent_profile ?? null;
    if (current === item.wanted) {
      // Set by this key's earlier call (its queued op landed) or already so when first read.
      item.result = item.result === "pending" && current === item.before ? "already" : "applied";
      delete item.error;
      return;
    }
    const op: Operation = { op_id: opaqueId("op"), kind: "set", id: item.id, field: "agent_profile", value: item.wanted, expect: item.before };
    const list = bySpace.get(p.found.space) ?? [];
    list.push({ index, op });
    bySpace.set(p.found.space, list);
  });

  for (const [space, list] of bySpace) {
    try {
      const outcomes = await record(ctx, space, list.map((l) => l.op));
      for (const { index, op } of list) {
        const item = batch.items[index]!;
        const outcome = outcomes.get(op.op_id);
        const reason = refusal(outcome);
        if (outcome?.status === "already") item.result = "applied";
        else if (reason && outcome) {
          item.result = "refused";
          item.error = `${reason}; someone changed it since the check, so it was left as it is`;
        } else if (reason) item.result = "unknown";
        else item.result = "applied";
      }
    } catch (failure) {
      if (!(failure instanceof Unknown)) throw failure;
      for (const { index } of list) {
        batch.items[index]!.result = "unknown";
        batch.items[index]!.error = failure.message;
      }
    }
  }
  store.put(batch);

  const items = planned.map((p, index): UpdateItem => {
    const item = batch.items[index]!;
    const result = item.result === "pending" ? "unknown" : item.result;
    counts[result] += 1;
    const task = "found" in p ? p.found.entity : undefined;
    const running = task ? runningText(ctx, task) : "";
    return {
      task: p.asked,
      id: item.id,
      result,
      before: shown(item.before),
      after: result === "applied" || result === "already" ? shown(item.wanted) : shown(item.before),
      note: running && (result === "applied" || result === "already") ? `its agent at work keeps ${running} until the task's next start` : "",
      error: item.error ?? "",
    };
  });
  return {
    ok: counts.refused === 0 && counts.unknown === 0,
    key: input.key,
    counts,
    items,
    error: counts.unknown ? "Some changes are queued while the plan syncs: call update_tasks again with the same key and items; nothing is applied twice." : "",
  };
}

type Text = RpcOutput<typeof taskTextRpc>;

/** The section's full text: acceptance as numbered lines with their ticks. */
function sectionText(loaded: LoadedEntity, section: RpcInput<typeof taskTextRpc>["section"]): string {
  switch (section) {
    case "brief":
      return loaded.brief;
    case "acceptance":
      return loaded.acceptance.map((a, i) => `${i + 1}. [${a.done ? "x" : " "}] ${a.text}`).join("\n");
    case "handoff":
      return loaded.handoff?.text ?? "";
    case "clarifications":
      return loaded.clarifications ?? "";
    case "notes":
      return loaded.notes;
  }
}

/** The revision of what a task's sections say now. */
export function textRevision(loaded: LoadedEntity): string {
  return hash(JSON.stringify([loaded.brief, loaded.acceptance, loaded.handoff?.text ?? "", loaded.clarifications ?? "", loaded.notes]));
}

export function readTaskText(ctx: ReadContext, input: RpcInput<typeof taskTextRpc>): Text {
  const empty: Text = { id: "", section: input.section, text: "", cursor: 0, next_cursor: 0, truncated: false, total: 0, revision: "", error: "" };
  const owner = notOwner(ctx);
  if (owner) return { ...empty, error: owner };
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return { ...empty, error: found.error };
  const { loaded } = found.value;
  const revision = textRevision(loaded);
  const cursor = input.cursor ?? 0;
  if (cursor > 0 && input.revision && input.revision !== revision) {
    return { ...empty, id: loaded.entity.id, revision, error: "The task changed since the last part was read: read the section again from cursor 0." };
  }
  const text = sectionText(loaded, input.section);
  if (cursor > text.length) return { ...empty, id: loaded.entity.id, revision, total: text.length, error: `cursor ${cursor} is past the end (${text.length} characters).` };
  // A part never ends inside a surrogate pair: the cut moves back one character instead.
  let end = Math.min(text.length, cursor + TEXT_CHUNK);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  return {
    id: loaded.entity.id,
    section: input.section,
    text: text.slice(cursor, end),
    cursor,
    next_cursor: end < text.length ? end : 0,
    truncated: end < text.length,
    total: text.length,
    revision,
    error: "",
  };
}
