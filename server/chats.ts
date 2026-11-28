import { createHash } from "node:crypto";
import { CHATS_LISTED, type OtherChat, type RunChat, SUB_AGENT_STATES, type SubAgent, type SubAgentState } from "../shared/chats.ts";
import type { PaseoApi } from "./paseo.ts";
import type { RunRecord, RunStore, WaitingKind } from "./runner/runs.ts";
import { activityOf } from "./tracker/tracker.ts";
import { PARENT_AGENT_LABEL } from "./wait.ts";

/**
 * What became of the chats behind this machine's runs (JOBBY-HCXY5). A run reads `stopped` when
 * Paseo closes its agent, which is not the same as the agent being gone: a closed chat that is not
 * archived goes on with a message, and so do the sub-agents it started. Two readings, both from one
 * listing of Paseo's agents, archived ones included:
 *
 * - per live run whose agent is stopped: its chat (closed, archived or gone) and its sub-agents that
 *   are not archived. An agent the listing does not name is asked for by id, so `gone` is said only when
 *   Paseo answers that it has none; a failed read says nothing.
 * - per task: sub-agents of other tasks' runs whose title or labels name it.
 *
 * The probe asks only `refresh()` and `list()`, which load and resume no agent (a timeline read would
 * load one).
 * Kept in memory; nothing is written to the plan.
 */

/** A screen's read starts a new pass when the last one is older than this. */
const FRESH_MS = 30_000;
/** A read waits for a pass that is missing a run's chat at most this often, and this long. */
const RETRY_MS = 5_000;
const WAIT_MS = 5_000;
const PAGE = 200;
const PAGES = 25;
/** How far up a sub-agent's parents are followed to the run that started them. */
const DEPTH = 5;

/** A task id inside a title or a label value, in either case: "qa-tst-fx001-2" names TST-FX001. */
const NAMED_ID = /(?<![A-Za-z0-9])[A-Za-z]{2,6}-[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{5}(?![A-Za-z0-9])/g;

interface ListedAgent {
  id: string;
  title?: string | null;
  cwd?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
  pendingPermissions?: unknown[] | null;
}

/** A stopped run's chat as read for one stop of it (`stoppedAt`: the run's `activityAt` then). */
interface Fact {
  stoppedAt: string;
  chat: RunChat;
  /** An open sub-agent's question or permission request, the first one found. */
  asking?: { kind: WaitingKind; text: string; agentId: string };
}

export interface ChatProbeOptions {
  paseo: () => PaseoApi | undefined;
  runs: () => RunStore | undefined;
  /** Whether the plan still holds the run; only such a run's chat is read. */
  isLive: (run: RunRecord) => boolean | undefined;
  /** A run recorded as stopped whose agent is open again (a missed hook, a reopened chat). */
  onOpen?: (run: RunRecord) => Promise<void> | void;
  now?: () => number;
  log?: (message: string) => void;
}

const stateOf = (agent: ListedAgent) => activityOf(agent as Parameters<typeof activityOf>[0]);

/** An unarchived agent's state as a sub-agent shows it. */
function subState(agent: ListedAgent): SubAgentState {
  const { activity } = stateOf(agent);
  if (activity === "stopped") return "closed";
  if (activity === "waiting") return "idle";
  return activity === "launching" ? "working" : activity;
}

/** The task ids an agent's title and labels name; Paseo's own labels name agents, not tasks. */
function namedTasks(agent: ListedAgent): Set<string> {
  const texts = [agent.title ?? "", ...Object.entries(agent.labels ?? {}).flatMap(([key, value]) => (key.startsWith("paseo.") ? [] : [key, value]))];
  return new Set(texts.flatMap((text) => text.match(NAMED_ID) ?? []).map((id) => id.toUpperCase()));
}

export class ChatProbe {
  /** Moves when a reading changes what a screen shows (server/changes.ts). */
  revision = "";
  private facts = new Map<string, Fact>();
  /** Stops a pass looked at and could say nothing of (the read failed, the agent is open): not waited for again. */
  private unread = new Map<string, string>();
  private named = new Map<string, OtherChat[]>();
  private readAt = Number.NEGATIVE_INFINITY;
  /** Whether any pass has finished: before that, no read knows which chats name its task. */
  private loaded = false;
  private inflight: Promise<void> | undefined;
  private again = false;
  private readonly options: ChatProbeOptions;

  constructor(options: ChatProbeOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private fact(run: RunRecord): Fact | undefined {
    const fact = this.facts.get(run.run_id);
    // A reading of an earlier stop says nothing about this one: the agent ran in between.
    return run.activity === "stopped" && fact?.stoppedAt === run.activityAt ? fact : undefined;
  }

  /** The chat of a stopped run; undefined while it is not read (or the run is not stopped). */
  of(run: RunRecord | undefined): RunChat | undefined {
    return run ? this.fact(run)?.chat : undefined;
  }

  asking(run: RunRecord): Fact["asking"] {
    return this.fact(run)?.asking;
  }

  /** The chats of other tasks' runs that name this task, open ones first, archived ones last. */
  naming(task: string): OtherChat[] {
    return this.named.get(task) ?? [];
  }

  private wanted(): RunRecord[] {
    return [...(this.options.runs()?.runs.values() ?? [])].filter((run) => run.agentId && run.activity === "stopped" && this.options.isLive(run) === true);
  }

  private missing(): boolean {
    return this.wanted().some((run) => !this.fact(run) && this.unread.get(run.run_id) !== run.activityAt);
  }

  /** Starts a pass in the background when the last one is old, or misses a run's chat. */
  peek(): void {
    const age = this.now() - this.readAt;
    if (age >= FRESH_MS || (age >= RETRY_MS && this.missing())) void this.read();
  }

  /** For a read about to answer: waits, bounded, only before the first pass and for a stopped run's chat not read yet. */
  async ready(limitMs = WAIT_MS): Promise<void> {
    const age = this.now() - this.readAt;
    const started = this.readAt !== Number.NEGATIVE_INFINITY;
    // A pass under way is waited for; a new one for a missing chat starts at most every RETRY_MS.
    const first = !this.loaded && (!started || this.inflight !== undefined);
    if (!first && !(this.missing() && (this.inflight !== undefined || age >= RETRY_MS))) return this.peek();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.read(), new Promise<void>((resolve) => (timer = setTimeout(resolve, limitMs)))]);
    clearTimeout(timer);
  }

  /** A run's agent just closed or was archived: read now, or once the pass under way is over. */
  changed(): Promise<void> {
    if (this.inflight) this.again = true;
    return this.read();
  }

  /** One pass at a time; a failed one keeps the last readings and is logged. */
  read(): Promise<void> {
    this.inflight ??= this.load()
      .catch((error: unknown) => this.options.log?.(`agents' chats: ${(error as Error)?.message ?? error}`))
      .finally(() => {
        this.inflight = undefined;
        if (!this.again) return;
        this.again = false;
        void this.read();
      });
    return this.inflight;
  }

  private async list(paseo: PaseoApi): Promise<ListedAgent[]> {
    const agents: ListedAgent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PAGES; page += 1) {
      // The latest first: past the limit, the oldest are the ones left out.
      const answer = (await paseo.agents.list({
        filter: { includeArchived: true, includeBackground: true },
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: PAGE, ...(cursor ? { cursor } : {}) },
      } as never)) as {
        entries?: { agent?: ListedAgent }[];
        pageInfo?: { nextCursor?: string | null };
      };
      for (const entry of answer.entries ?? []) if (entry.agent?.id) agents.push(entry.agent);
      cursor = answer.pageInfo?.nextCursor ?? undefined;
      if (!cursor) return agents;
    }
    this.options.log?.(`agents' chats: Paseo lists more than ${PAGES * PAGE} agents; the rest are not read`);
    return agents;
  }

  private async load(): Promise<void> {
    const paseo = this.options.paseo();
    const store = this.options.runs();
    if (!paseo || !store) return;
    // A failed pass counts too, so reads do not queue up behind a Paseo that does not answer.
    this.readAt = this.now();
    // The stop each reading is of, taken before asking Paseo.
    const wanted = this.wanted().map((run) => ({ run, stoppedAt: run.activityAt }));
    const agents = await this.list(paseo);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const children = new Map<string, ListedAgent[]>();
    for (const agent of agents) {
      const parent = agent.labels?.[PARENT_AGENT_LABEL];
      if (parent) children.set(parent, [...(children.get(parent) ?? []), agent]);
    }

    const facts = new Map<string, Fact>();
    const open: RunRecord[] = [];
    const unread = new Map<string, string>();
    for (const { run, stoppedAt } of wanted) {
      const id = run.agentId!;
      let agent: ListedAgent | null | undefined = byId.get(id);
      if (!agent) {
        try {
          // The SDK answers null only when Paseo has no such agent; it throws on any other failure.
          agent = ((await paseo.agents.ref(id).refresh()) as { agent?: ListedAgent } | null)?.agent ?? null;
        } catch (error) {
          this.options.log?.(`chat of run ${run.run_id}: ${(error as Error)?.message ?? error}`);
          const known = this.facts.get(run.run_id);
          if (known) facts.set(run.run_id, known);
          unread.set(run.run_id, stoppedAt);
          continue;
        }
      }
      const state = !agent ? "gone" : agent.archivedAt ? "archived" : agent.status === "closed" ? "closed" : undefined;
      if (!state) {
        open.push(run);
        unread.set(run.run_id, stoppedAt);
        continue;
      }
      const subs: SubAgent[] = [];
      let asking: Fact["asking"];
      for (const child of children.get(id) ?? []) {
        if (child.archivedAt) continue;
        const childState = subState(child);
        subs.push({ id: child.id, state: childState, directory: child.cwd ?? "" });
        if (childState === "needs_input" && !asking) {
          const said = stateOf(child);
          asking = { kind: said.waitingKind ?? "permission", text: said.waitingFor ?? "a sub-agent waits for an answer", agentId: child.id };
        }
      }
      subs.sort((a, b) => SUB_AGENT_STATES.indexOf(a.state) - SUB_AGENT_STATES.indexOf(b.state) || a.id.localeCompare(b.id));
      facts.set(run.run_id, { stoppedAt, chat: { id, state, sub_agents: subs.slice(0, CHATS_LISTED) }, ...(asking ? { asking } : {}) });
    }

    const named = new Map<string, OtherChat[]>();
    for (const agent of agents) {
      // A run's own agent is its task's chat, not another run's sub-agent.
      if (!agent.labels?.[PARENT_AGENT_LABEL] || store.byAgent(agent.id)) continue;
      let parent: string | undefined = agent.labels[PARENT_AGENT_LABEL];
      let run: RunRecord | undefined;
      for (let depth = 0; parent && !run && depth < DEPTH; depth += 1) {
        run = store.byAgent(parent);
        parent = byId.get(parent)?.labels?.[PARENT_AGENT_LABEL];
      }
      if (!run) continue;
      for (const task of namedTasks(agent)) {
        if (task === run.task) continue;
        named.set(task, [...(named.get(task) ?? []), { chat_id: agent.id, state: agent.archivedAt ? "archived" : subState(agent), directory: agent.cwd ?? "", via_task: run.task }]);
      }
    }
    const rank = (chat: OtherChat) => (chat.state === "archived" ? SUB_AGENT_STATES.length : SUB_AGENT_STATES.indexOf(chat.state));
    for (const [task, chats] of named) named.set(task, chats.sort((a, b) => rank(a) - rank(b) || a.chat_id.localeCompare(b.chat_id)).slice(0, CHATS_LISTED));

    this.loaded = true;
    this.facts = facts;
    this.unread = unread;
    this.named = named;
    this.revision = createHash("sha256")
      .update(JSON.stringify([[...facts].sort(([a], [b]) => a.localeCompare(b)), [...named].sort(([a], [b]) => a.localeCompare(b))]))
      .digest("base64url")
      .slice(0, 22);
    for (const run of open) {
      try {
        await this.options.onOpen?.(run);
      } catch (error) {
        this.options.log?.(`chat of run ${run.run_id}: ${(error as Error)?.message ?? error}`);
      }
    }
  }
}
