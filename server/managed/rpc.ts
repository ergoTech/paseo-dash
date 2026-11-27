import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { DEFAULT_QUEUE_STARTS, QUEUE_CARDS, QUEUE_WINDOW_HOURS, type QueueAction, type queuePreviewRpc, type queueReadRpc, type queueSetRpc } from "../../shared/managed-queue.ts";
import { loadProfiles, nextStart } from "../api/batch.ts";
import { planStart } from "../api/reads.ts";
import type { WriteContext } from "../api/writes.ts";
import type { Dashboard } from "../dashboard.ts";
import { type Planned, planQueue, startable } from "./plan.ts";

/**
 * The owner's side of the managed queue (shared/managed-queue.ts): Settings and Live. Registered,
 * never described to God Mode, and answered only by the copy that owns the data.
 */

type Preview = RpcOutput<typeof queuePreviewRpc>;

const notOwner = (dashboard: Dashboard): string => (dashboard.owner && dashboard.queue ? "" : dashboard.ownerReason || "Paseo Dash has not started");

export function readQueue(ctx: WriteContext): RpcOutput<typeof queueReadRpc> {
  const { dashboard } = ctx;
  const empty = { revision: 0, paused: "", policies: [], projects: [] };
  const error = notOwner(dashboard);
  if (error || !dashboard.queue) return { ...empty, error };
  const state = dashboard.queue.store.state();
  return {
    revision: state.revision,
    paused: state.paused,
    policies: state.projects.map((own) => ({ ...own, starts_used: dashboard.queue!.store.used(own.space, own.project).length })),
    projects: [...dashboard.spaces.values()].flatMap(({ record, sync }) => Object.keys(sync.plan.space?.projects ?? {}).map((project) => ({ space: record.key, name: record.name, project }))),
    error: "",
  };
}

export function setQueue(ctx: WriteContext, input: RpcInput<typeof queueSetRpc>): RpcOutput<typeof queueSetRpc> {
  const { dashboard } = ctx;
  const error = notOwner(dashboard);
  if (error || !dashboard.queue) return { ok: false, error };
  const space = dashboard.spaces.get(input.space.toUpperCase());
  if (!space) return { ok: false, error: `no space ${input.space}` };
  if (!Object.hasOwn(space.sync.plan.space?.projects ?? {}, input.project)) return { ok: false, error: `no project ${input.project} in ${space.record.key}` };
  try {
    const refused = dashboard.queue.store.set(space.record.key, input.project, { enabled: input.enabled, paused: input.paused, max_starts: input.max_starts, labels: input.labels }, input.revision);
    if (refused) return { ok: false, error: refused };
  } catch (failure) {
    return { ok: false, error: `not saved: ${String((failure as Error)?.message ?? failure)}${input.enabled === false || input.paused === true ? "; it counts until the plugin restarts" : ""}` };
  }
  // A change of the queue is worth a pass at once rather than at the next sync.
  void dashboard.autopilot?.pass(ctx, true).catch(() => undefined);
  return { ok: true, error: "" };
}

/** Why the queue starts nothing now, as the limits stand; "" when it may start its next card. */
function holdOf(dashboard: Dashboard, space: string, project: string, used: number, max: number, nextFree: string): string {
  const objection = dashboard.queue!.store.objection(space, project);
  if (objection) return objection;
  if (!dashboard.spaces.get(space)?.record.mapping[project]) return `project ${project} is not mapped on this Mac: no card of it can start from here (open it in Paseo first)`;
  const autopilot = dashboard.autopilot?.read();
  if (!autopilot) return "Paseo Dash has not started its autopilot on this Mac";
  if (autopilot.limit.until) return `a usage limit holds every start until ${autopilot.limit.until} (${autopilot.limit.source})`;
  if (autopilot.running >= autopilot.max_running) return `all ${autopilot.max_running} places of this Mac are at work (Settings → Autopilot); the next start waits for one`;
  if (used >= max) return `the limit of ${max} starts in ${QUEUE_WINDOW_HOURS} hours is reached; the next is free ${nextFree}`;
  return "";
}

const GROUP: Record<QueueAction, number> = { next: 0, queued: 0, read_first: 0, after_dependency: 1, needs_owner: 2, duplicate: 2 };

function preparerOf(dashboard: Dashboard, space: string, project: string): string {
  const state = dashboard.delegation?.state();
  const grant = state?.enabled && !state.paused ? state.grants.find((own) => own.space === space && own.project === project) : undefined;
  return grant
    ? `${grant.title || grant.agent} may prepare cards: ${grant.actions.join(", ")} (Delegated planning)`
    : "no agent is appointed to prepare this project's cards (Settings → Delegated planning); the queue only orders and starts what is there";
}

/** What the queue would do with each open card of the project now. Read only; the queue may be off. */
export async function previewQueue(ctx: WriteContext, input: RpcInput<typeof queuePreviewRpc>): Promise<Preview> {
  const { dashboard } = ctx;
  const limits = { max_running: 0, running: 0, max_starts: DEFAULT_QUEUE_STARTS, starts_used: 0, window_hours: QUEUE_WINDOW_HOURS };
  const fail = (error: string): Preview => ({ state: "off", hold: "", limits, preparer: "", next: "", cards: [], total: 0, counts: {}, started: [], error });
  const error = notOwner(dashboard);
  if (error || !dashboard.queue) return fail(error);
  const space = dashboard.spaces.get(input.space.toUpperCase());
  if (!space) return fail(`no space ${input.space}`);
  if (!Object.hasOwn(space.sync.plan.space?.projects ?? {}, input.project)) return fail(`no project ${input.project} in ${space.record.key}`);
  const key = space.record.key;
  const { store } = dashboard.queue;
  const policy = store.policy(key, input.project);
  const used = store.used(key, input.project);
  const max = policy?.max_starts ?? DEFAULT_QUEUE_STARTS;
  const autopilot = dashboard.autopilot?.read();
  const planned = planQueue(ctx, space, { project: input.project, labels: policy?.labels ?? [] }, dashboard.queue.notesOf(key));

  // The first card's start is checked as God Mode's start_check checks it: a start that would be refused is no "next".
  const startWith = new Map<string, string>();
  const refused = new Map<string, string>();
  const profiles = await loadProfiles(ctx);
  let verified = false;
  for (const card of planned) {
    if (!startable(card) || card.busy) continue;
    const loaded = space.sync.plan.entities.get(card.id)!;
    if (!verified && card.action === "next") {
      verified = true;
      const plan = await planStart(ctx, { task: card.id }, { automatic: true, cached: true }).catch((failure: unknown) => ({ error: String((failure as Error)?.message ?? failure) }));
      if ("found" in plan) startWith.set(card.id, `${plan.facts.profile}; ${plan.facts.mode}`);
      else {
        refused.set(card.id, plan.error);
        continue;
      }
    }
    if (!startWith.has(card.id)) startWith.set(card.id, nextStart(ctx, space, loaded.entity as never, loaded, profiles));
  }
  // When the first is refused, the next card in line is the one that would go.
  let next = "";
  const cards = planned.map((card): Planned => {
    const why = refused.get(card.id);
    if (why) return { ...card, action: "needs_owner", needs: "refused", reason: why, step: "a start would be refused: settle that, or start it yourself from its own screen" };
    return card;
  });
  const first = cards.find((card) => startable(card) && !card.busy);
  if (first) {
    next = first.id;
    first.action = first.action === "read_first" ? "read_first" : "next";
  }
  const counts: Record<string, number> = {};
  for (const card of cards) counts[card.action] = (counts[card.action] ?? 0) + 1;
  const ordered = [...cards].sort((a, b) => GROUP[a.action] - GROUP[b.action]);
  const oldest = used.at(-1)?.at;
  const nextFree = oldest ? `at ${new Date(Date.parse(oldest) + QUEUE_WINDOW_HOURS * 3_600_000).toISOString()}` : "";
  const state = policy?.enabled ? (policy.paused || store.state().paused ? "paused" : "on") : "off";
  return {
    state,
    hold: policy?.enabled ? holdOf(dashboard, key, input.project, used.length, max, nextFree) : "",
    limits: { max_running: autopilot?.max_running ?? 0, running: autopilot?.running ?? 0, max_starts: max, starts_used: used.length, window_hours: QUEUE_WINDOW_HOURS },
    preparer: preparerOf(dashboard, key, input.project),
    next,
    cards: ordered.slice(0, QUEUE_CARDS).map(({ busy: _busy, ...card }) => ({ ...card, start_with: startWith.get(card.id) ?? "" })),
    total: cards.length,
    counts,
    started: used.map(({ task, title, at }) => ({ task, title, at })),
    error: "",
  };
}
