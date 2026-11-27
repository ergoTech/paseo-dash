import { createHash } from "node:crypto";
import type { DelegatedAction, DelegationEntry, DelegationGrant } from "../../shared/delegation.ts";
import { refId, type Task } from "../../shared/model.ts";
import type { ToolAnswer } from "../agent-tools/bridge.ts";
import { cutBytes, type PlanCaller, UNTRUSTED } from "../agent-tools/plan.ts";
import { COORDINATE_LIMIT, coordinateDraftSchema, coordinateFindSchema, coordinatePlanSchema, coordinateTaskSchema } from "../agent-tools/schema.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { wikilink } from "../api/resolve.ts";
import { briefText, normalTitle, record, refusal, Unknown } from "../api/writes.ts";
import { tasksOf } from "../api/view.ts";
import type { Dashboard } from "../dashboard.ts";
import { demoteHeadings, taskBody } from "../plan/document.ts";
import { newId } from "../plan/ids.ts";
import type { LoadedEntity } from "../plan/load.ts";
import { search } from "../search/core.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { type DelegatedOperation, delegationOf } from "../sync/ops.ts";
import { actionsOf, cardRefusal, createRefusal, depKey, type DelegatedEdit, editRefusal, revisionOf, sameEdit, textRefusal } from "./rules.ts";
import type { DelegationStore } from "./store.ts";

/**
 * The coordinator tools (server/agent-tools/bridge-script.ts, COORDINATOR_TOOLS). Every call reads
 * the permission again, so a revocation counts at once, and reaches only the cards of the one
 * project it names. A change is one operation of the plan's journal (server/sync/ops.ts), recorded
 * with who asked and under which permission before it is written.
 *
 * The operation's id is made from the permission, the card, the revision and the change, so a call
 * repeated after a lost answer finds what the first one did instead of writing again.
 */

const TOOLS = ["coordinate_find", "coordinate_task", "coordinate_draft", "coordinate_plan"];
/** Under the bridge script's 15 s, so a busy plan answers "queued" before the agent hears "unreachable". */
const WRITE_WAIT_MS = 10_000;
/** Characters of a brief a read returns at most. */
const BRIEF_CHARS = 20_000;
/** Characters of a value the record keeps; the whole text is in the plan's history. */
const LOG_CHARS = 200;

export interface CoordinatorOptions {
  now?: () => Date;
  writeWaitMs?: number;
}

interface Session {
  dashboard: Dashboard;
  store: DelegationStore;
  grant: DelegationGrant;
  space: SpaceEntry;
}

const no = (text: string): ToolAnswer => ({ ok: false, text });
const yes = (text: string): ToolAnswer => ({ ok: true, text });

function open(dashboard: Dashboard, caller: PlanCaller): Session | ToolAnswer {
  if (!dashboard.owner) return no(dashboard.ownerReason || "Paseo Dash has not started.");
  const store = dashboard.delegation;
  const state = store?.state();
  if (!store || !state?.enabled) return no("Delegation is turned off in Paseo Dash Settings on this machine.");
  if (state.paused) return no(`Delegation is paused: ${state.paused}.`);
  const grant = store.grantOf(caller.agentId);
  if (!grant) return no("This agent has no delegated permission: none was given, or it was revoked.");
  const space = dashboard.spaces.get(grant.space);
  const project = space?.sync.plan.space?.projects[grant.project];
  if (!space || !project) return no(`Project ${grant.project} of ${grant.space} is not connected on this machine any more.`);
  if (normalizeRemote(project.remote) !== normalizeRemote(caller.remote)) {
    return no(`The permission is for project ${grant.project} of ${grant.space}, and this session's repository is not that project.`);
  }
  return { dashboard, store, grant, space };
}

/** A card of the permission's project by its id, and nothing about any other. */
function card({ grant, space }: Session, id: string): { loaded: LoadedEntity; task: Task } | ToolAnswer {
  const key = id.toUpperCase();
  const loaded = space.sync.plan.entities.get(key);
  const task = loaded?.entity;
  if (!loaded || task?.type !== "task" || task.project !== grant.project || space.sync.plan.duplicates.has(key)) {
    return no(`No card ${cutBytes(key, 40)} in project ${grant.project} of ${grant.space}.`);
  }
  return { loaded, task };
}

function find(session: Session, query: string | undefined, limit: number): ToolAnswer {
  const { space, grant } = session;
  const own = [...space.sync.plan.entities.values()].filter((loaded) => loaded.entity.type === "task" && loaded.entity.project === grant.project);
  let shown: Task[];
  let total: number;
  if (query) {
    const found = search(
      own.map((loaded) => ({ loaded, plan: space.sync.plan })),
      query,
      { partial: true },
    );
    if (!found) return no("Give some words to search for.");
    total = found.hits.length;
    shown = found.hits.slice(0, limit).map((hit) => hit.item.loaded.entity as Task);
  } else {
    const open = own.map((loaded) => loaded.entity as Task).filter((task) => task.status !== "done" && task.status !== "canceled");
    total = open.length;
    shown = open.slice(0, limit);
  }
  if (!shown.length) return yes(`No card of project ${grant.project} ${query ? "matches" : "is open"}.`);
  const rows = shown.map((task) => cutBytes(`${task.id} ${task.status} ${task.priority ?? "-"} ${task.title.replace(/\s+/g, " ")}`, 120));
  return yes([`${shown.length} of ${total} in project ${grant.project} of ${grant.space}. ${UNTRUSTED}`, ...rows].join("\n"));
}

/** What the permission lets the coordinator change on this card now, in words. */
function allowed(session: Session, loaded: LoadedEntity, task: Task): string {
  const { grant, space, store } = session;
  const locked = cardRefusal(space.sync.plan, task, grant.project);
  if (locked) return `You may change nothing: ${locked}.`;
  const may: string[] = [];
  if (grant.actions.includes("drafts") && !textRefusal(task) && store.owns(grant.space, task.id, grant.agent)) may.push("brief and acceptance (your draft)");
  if (grant.actions.includes("priority")) may.push("priority");
  if (grant.actions.includes("dependencies")) may.push(task.status === "inbox" ? "dependencies" : "adding dependencies");
  return may.length ? `You may change: ${may.join(", ")}.` : "You may change nothing on this card.";
}

function read(session: Session, id: string): ToolAnswer {
  const found = card(session, id);
  if (!("task" in found)) return found;
  const { loaded, task } = found;
  const brief = loaded.brief.length > BRIEF_CHARS ? `${loaded.brief.slice(0, BRIEF_CHARS)}… (cut)` : loaded.brief;
  return yes(
    [
      UNTRUSTED,
      `${task.id} · ${task.title}`,
      `Status: ${task.status} · project ${task.project} · priority ${task.priority ?? "(none)"} · revision ${revisionOf(loaded)}`,
      `Depends on: ${task.depends_on.map(depKey).join(", ") || "(none)"}`,
      `Labels: ${task.labels.join(", ") || "(none)"}`,
      allowed(session, loaded, task),
      "",
      "Brief:",
      brief || "(none)",
      "",
      "Acceptance:",
      loaded.acceptance.length ? loaded.acceptance.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n") : "(none)",
    ].join("\n"),
  );
}

/** The permission an operation is asked under, as the rules stand now. */
function viaOf({ grant, store }: Session): DelegatedOperation["via"] {
  return { grant: grant.id, agent: grant.agent, project: grant.project, revision: store.state().revision };
}

function operationId(parts: unknown[]): string {
  return `op-dg-${createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 20)}`;
}

const cut = (text: string): string => (text.length > LOG_CHARS ? `${text.slice(0, LOG_CHARS)}…` : text);

function changesOf(loaded: LoadedEntity | undefined, edit: DelegatedEdit & { title?: string }): DelegationEntry["changes"] {
  const task = loaded?.entity as Task | undefined;
  const changes: DelegationEntry["changes"] = [];
  const add = (field: string, from: string, to: string | undefined) => {
    if (to !== undefined && from !== to) changes.push({ field, from: cut(from), to: cut(to) });
  };
  add("title", "", edit.title);
  add("brief", loaded?.brief ?? "", edit.brief === undefined ? undefined : demoteHeadings(edit.brief));
  add("acceptance", loaded?.acceptance.map((a) => a.text).join("; ") ?? "", edit.acceptance?.join("; "));
  add("priority", task?.priority ?? "", edit.priority);
  add("depends_on", task?.depends_on.map(depKey).join(", ") ?? "", edit.depends_on?.map(depKey).join(", "));
  return changes;
}

type Asked = Pick<DelegationEntry, "op_id" | "task" | "task_title" | "actions" | "changes">;

function entryOf({ grant }: Session, asked: Asked, status: DelegationEntry["status"], reason: string, now: Date): DelegationEntry {
  return {
    ...asked,
    at: now.toISOString(),
    agent: grant.agent,
    title: grant.title,
    grant: grant.id,
    granted_at: grant.granted_at,
    space: grant.space,
    project: grant.project,
    status,
    reason,
  };
}

/** A refusal is recorded too, so the owner sees what was asked beyond the permission. */
function refuse(session: Session, asked: Asked, reason: string, now: Date): ToolAnswer {
  // An earlier call of the same change that went through keeps its record.
  const prior = session.store.entry(asked.op_id);
  if (!prior || prior.status === "refused") session.store.record(entryOf(session, asked, "refused", reason, now));
  return no(`Not changed: ${reason}.`);
}

/** The answer to a change already asked for: made, or still on its way to the plan repository. */
function repeated(session: Session, opId: string): ToolAnswer | undefined {
  // Still in the journal: never journaled twice, whatever the record says.
  const waiting = session.space.sync.journalEntries.find((entry) => entry.op.op_id === opId);
  if (waiting) {
    const op = delegationOf(waiting.op);
    const dropped = op ? session.store.objection(session.grant.space, op) : undefined;
    if (dropped) return no(`Not changed yet: this change still waits for a sync, which will refuse it: ${dropped}. Ask again after that.`);
    return yes("This change is already waiting to be pushed to the plan repository, where it is checked again; no need to send it again.");
  }
  const prior = session.store.entry(opId);
  // Recorded as queued and never journaled (the plugin stopped in between): it is asked for as new.
  if (!prior || prior.status !== "applied") return undefined;
  return yes(`This change of ${prior.task} was made at ${prior.at}; nothing is written again. Read the card to see how it stands now.`);
}

/** Records the entry, then the operation; nothing is written when the record cannot be. */
async function write(session: Session, op: DelegatedOperation, asked: Asked, creates: boolean, options: CoordinatorOptions): Promise<ToolAnswer> {
  const { dashboard, store, space } = session;
  store.record(entryOf(session, asked, "queued", "", (options.now ?? (() => new Date()))()), creates);
  let outcome;
  try {
    outcome = (await record({ dashboard, writeWaitMs: options.writeWaitMs ?? WRITE_WAIT_MS }, space, [op])).get(op.op_id);
  } catch (error) {
    if (error instanceof Unknown) {
      return yes(`The change of ${asked.task} is queued; the plan is busy syncing. Read the card later: it is checked again before it is written.`);
    }
    throw error;
  }
  const reason = refusal(outcome);
  if (reason) return no(`Not changed: ${reason}.`);
  const after = space.sync.plan.entities.get(asked.task);
  const now = after ? ` Its revision is now ${revisionOf(after)}.` : "";
  return yes(`${creates ? `Added draft ${asked.task} to the Inbox of project ${session.grant.project}.` : `Changed ${asked.changes.map((c) => c.field).join(", ")} of ${asked.task}.`}${now}`);
}

async function edit(session: Session, id: string, revision: string, wanted: DelegatedEdit, options: CoordinatorOptions): Promise<ToolAnswer> {
  const found = card(session, id);
  const now = (options.now ?? (() => new Date()))();
  const { grant, space, store } = session;
  const actions = actionsOf(wanted);
  const opId = operationId([grant.id, grant.agent, id.toUpperCase(), revision, wanted]);
  if (!("task" in found)) {
    return refuse(session, { op_id: opId, task: cutBytes(id.toUpperCase(), 40), task_title: "", actions, changes: [] }, `${found.text.replace(/\.$/, "")}`, now);
  }
  const { loaded, task } = found;
  const again = repeated(session, opId);
  if (again) return again;

  // Dependencies are asked for by id and kept as the plan writes references; one already there stays as it is written.
  let next: DelegatedEdit = wanted;
  if (wanted.depends_on) {
    const references = wanted.depends_on.map((asked) => {
      const key = depKey(asked) === asked ? asked.toUpperCase() : depKey(asked);
      const kept = task.depends_on.find((reference) => depKey(reference) === key || reference === asked);
      const other = space.sync.plan.entities.get(refId(key) ?? "");
      return kept ?? (other ? wikilink({ loaded: other }) : key);
    });
    next = { ...wanted, depends_on: references };
  }
  const asked: Asked = { op_id: opId, task: task.id, task_title: task.title, actions, changes: changesOf(loaded, next) };
  const missing = actions.find((action) => !grant.actions.includes(action));
  if (missing) return refuse(session, asked, `your permission does not include ${missing}`, now);
  if (sameEdit(loaded, next)) return yes(`Nothing to change: ${task.id} already reads so. Its revision is ${revisionOf(loaded)}.`);
  const forbidden =
    editRefusal(space.sync.plan, loaded, next, grant.project) ??
    (actions.includes("drafts") && !store.owns(grant.space, task.id, grant.agent) ? `${task.id} is not a draft you created` : undefined) ??
    (revisionOf(loaded) !== revision ? `${task.id} changed since you read it; read it again with coordinate_task` : undefined);
  if (forbidden) return refuse(session, asked, forbidden, now);
  const op: DelegatedOperation = { op_id: opId, kind: "delegated", id: task.id, via: viaOf(session), expect_rev: revision, edit: next };
  return write(session, op, asked, false, options);
}

async function add(session: Session, draft: { title: string; brief: string; acceptance: string[] }, options: CoordinatorOptions): Promise<ToolAnswer> {
  const { grant, space } = session;
  const now = (options.now ?? (() => new Date()))();
  const opId = operationId([grant.id, grant.agent, "create", draft]);
  const again = repeated(session, opId);
  if (again) return again;
  const actions: DelegatedAction[] = ["drafts"];
  const changes = changesOf(undefined, { title: draft.title, brief: draft.brief, acceptance: draft.acceptance });
  const asked: Asked = { op_id: opId, task: "", task_title: draft.title, actions, changes };
  if (!grant.actions.includes("drafts")) return refuse(session, asked, "your permission does not include drafts", now);
  const title = normalTitle(draft.title);
  // Open drafts and cards of the project under this title, written or still waiting: the same draft.
  const twin =
    tasksOf(space.sync.plan).some((task) => task.project === grant.project && task.status !== "done" && task.status !== "canceled" && normalTitle(task.title) === title) ||
    space.sync.pendingCreates().some((op) => op.type === "task" && op.fields.project === grant.project && normalTitle(String(op.fields.title ?? "")) === title);
  if (twin) return yes("Not added: an open card with this title is already in the project; coordinate_find shows it.");
  const fields = { title: draft.title, status: "inbox", project: grant.project };
  const forbidden = createRefusal(space.sync.plan, "task", fields, grant.project);
  if (forbidden) return refuse(session, asked, forbidden, now);
  const id = newId(space.record.key, space.sync.takenIds());
  const op: DelegatedOperation = {
    op_id: opId,
    kind: "create",
    type: "task",
    id,
    fields,
    body: `\n${taskBody(briefText(demoteHeadings(draft.brief)), draft.acceptance)}`,
    via: viaOf(session),
  };
  return write(session, op, { ...asked, task: id }, true, options);
}

export async function handleCoordinatorTool(dashboard: Dashboard, caller: PlanCaller, tool: string, args: unknown, options: CoordinatorOptions = {}): Promise<ToolAnswer> {
  if (!TOOLS.includes(tool)) return no(`Unknown tool ${tool}.`);
  const session = open(dashboard, caller);
  if (!("grant" in session)) return session;

  if (tool === "coordinate_find") {
    const parsed = coordinateFindSchema.safeParse(args);
    if (!parsed.success) return problems(parsed.error.issues);
    return find(session, parsed.data.query, parsed.data.limit ?? COORDINATE_LIMIT);
  }
  if (tool === "coordinate_task") {
    const parsed = coordinateTaskSchema.safeParse(args);
    if (!parsed.success) return problems(parsed.error.issues);
    return read(session, parsed.data.id);
  }
  if (tool === "coordinate_plan") {
    const parsed = coordinatePlanSchema.safeParse(args);
    if (!parsed.success) return problems(parsed.error.issues);
    const { id, revision, ...change } = parsed.data;
    if (change.priority === undefined && change.depends_on === undefined) return no("Not changed: give a priority, depends_on or both.");
    return edit(session, id, revision, change, options);
  }
  const parsed = coordinateDraftSchema.safeParse(args);
  if (!parsed.success) return problems(parsed.error.issues);
  const { id, revision, title, brief, acceptance } = parsed.data;
  if (id === undefined) {
    if (!title || revision !== undefined) return no("Not added: a new draft takes a title, and no revision.");
    return add(session, { title, brief: brief ?? "", acceptance: acceptance ?? [] }, options);
  }
  if (!revision || title !== undefined || (brief === undefined && acceptance === undefined)) {
    return no("Not changed: editing a draft takes its id, its revision and a brief, acceptance or both; a title is not changed.");
  }
  return edit(session, id, revision, { ...(brief === undefined ? {} : { brief }), ...(acceptance === undefined ? {} : { acceptance }) }, options);
}

function problems(issues: { path: PropertyKey[]; message: string }[]): ToolAnswer {
  return no(`Not done: ${issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.`);
}
