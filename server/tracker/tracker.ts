import type { PaseoApi } from "../paseo.ts";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { onHook } from "../hooks.ts";
import type { Activity, RunRecord, RunStore, WaitingKind } from "../runner/runs.ts";

/**
 * What this machine's task agents are doing (05-architecture.md, Tracking progress: 1. Paseo
 * lifecycle). Hooks are best effort and never replayed, so a reconciliation from the agents' own
 * snapshots runs on start and on a timer. Only agents of runs this plugin started are tracked;
 * hooks update memory and enqueue work, they never wait on git or the network.
 */

export interface TrackerOptions {
  runs: () => RunStore | undefined;
  paseo: () => PaseoApi | undefined;
  attach: (paseo: PaseoApi) => void;
  /** Whether the plan still holds the run; a run it no longer holds is not reconciled any more. */
  isLive?: (run: RunRecord) => boolean | undefined;
  /** Called when a turn starts, outside the hook, with the agent's cwd: its timeline is followed (follow.ts). */
  onTurnStarted?: (run: RunRecord, cwd: string) => void;
  /** Called in a reconcile pass for a run whose agent is still there, with its cwd. */
  onAgentSeen?: (run: RunRecord, cwd: string) => void;
  /** Called after each reconcile pass. */
  onReconciled?: () => void;
  /** Called after a turn ended, outside the hook: the turn may have opened or merged a PR/MR. */
  onTurnEnded?: (run: RunRecord) => void;
  /** Called after a turn's reply was read into `lastMessage` (the finished event's summary). */
  onLastMessage?: (run: RunRecord) => void;
  /** Called after a run's workspace was archived, outside the hook: its PR/MR or "landed" is read again. */
  onWorkspaceArchived?: (run: RunRecord) => void;
  /** Called for each live tracked run on a trunk in a reconcile pass: its workspace may be archived meanwhile. */
  onReconcileTrunk?: (run: RunRecord) => void;
  /** A run of this machine whose task the plan no longer holds for it (released, finished, taken over). */
  onRunOver?: (run: RunRecord) => Promise<void> | void;
  now?: () => Date;
  log?: (message: string) => void;
  reconcileEveryMs?: number;
}

const LAST_MESSAGE_CHARS = 600;
const WAITING_FOR_CHARS = 200;

type PermissionRequest = {
  title?: string;
  name?: string;
  kind?: string;
  description?: string;
  detail?: { type?: string; command?: string } | null;
  input?: { description?: unknown; questions?: unknown } | null;
};

type Extra = Partial<Pick<RunRecord, "waitingFor" | "waitingKind" | "error" | "lastMessage">>;

/** Paseo's kind `question`: the agent asks the user (Claude's AskUserQuestion, Codex's request_user_input). */
export function waitingKindOf(request: PermissionRequest): WaitingKind {
  return request.kind === "question" ? "question" : "permission";
}

/**
 * The questions of a question request by name, as God Mode names them: one question by its header
 * and text ("Release: Ship today?"), several by their count and headers ("2 questions: Release,
 * Daemon"). Empty when the request carries no questions.
 */
function questionsText(request: PermissionRequest): string {
  const questions = request.kind === "question" && Array.isArray(request.input?.questions) ? (request.input.questions as unknown[]) : [];
  const said = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const header = (q: unknown) => said((q as { header?: unknown } | null)?.header);
  if (questions.length === 1) return [header(questions[0]), said((questions[0] as { question?: unknown } | null)?.question)].filter(Boolean).join(": ");
  if (questions.length > 1) {
    const headers = questions.map(header).filter(Boolean);
    return `${questions.length} questions${headers.length ? `: ${headers.join(", ")}` : ""}`;
  }
  return "";
}

/**
 * A request as the user hears it: the questions it asks, the command a shell request runs ("asks to
 * run: npm test"), else its title, else the tool and what it says it does.
 */
export function describeRequest(request: PermissionRequest): string {
  const said = typeof request.input?.description === "string" ? request.input.description : request.description;
  const text =
    questionsText(request) ||
    (request.detail?.command ? `asks to run: ${request.detail.command}` : "") ||
    request.title ||
    [request.name, said].filter(Boolean).join(": ") ||
    [request.kind, request.name].filter(Boolean).join(" ") ||
    "a permission";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= WAITING_FOR_CHARS ? flat : `${flat.slice(0, WAITING_FOR_CHARS - 1)}…`;
}

interface AgentSnapshot {
  status?: string | null;
  pendingPermissions?: PermissionRequest[] | null;
  archivedAt?: string | null;
  lastError?: string | { message?: string } | null;
}

/** The fields of Paseo's agent snapshot that say how the agent runs. */
interface AgentSettingsSnapshot {
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
}

/** The mode and effort a snapshot reports; undefined when it reports neither. */
export function reportedSettings(agent: AgentSettingsSnapshot): { modeId?: string; effortId?: string } | undefined {
  const modeId = agent.currentModeId || undefined;
  const effortId = agent.effectiveThinkingOptionId || agent.thinkingOptionId || undefined;
  if (!modeId && !effortId) return undefined;
  return { ...(modeId ? { modeId } : {}), ...(effortId ? { effortId } : {}) };
}

/** The activity an agent's snapshot shows. */
export function activityOf(agent: AgentSnapshot): { activity: Activity; waitingFor?: string; waitingKind?: WaitingKind; error?: string } {
  if (agent.archivedAt) return { activity: "stopped" };
  const pending = agent.pendingPermissions ?? [];
  if (pending.length) return { activity: "needs_input", waitingFor: describeRequest(pending[0]!), waitingKind: waitingKindOf(pending[0]!) };
  switch (agent.status) {
    case "running":
    case "initializing":
      return { activity: "working" };
    case "idle":
      return { activity: "waiting" };
    case "error": {
      const error = typeof agent.lastError === "string" ? agent.lastError : agent.lastError?.message;
      return { activity: "failed", error: error ?? "the agent stopped with an error" };
    }
    case "closed":
      return { activity: "stopped" };
    default:
      return { activity: "working" };
  }
}

export class Tracker {
  private readonly options: TrackerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  /** Hook events per run, so a reconcile pass never writes an older snapshot over a newer hook. */
  private readonly hookCount = new Map<string, number>();

  constructor(options: TrackerOptions) {
    this.options = options;
  }

  private stamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private run(agentId: string): RunRecord | undefined {
    return this.options.runs()?.byAgent(agentId);
  }

  private set(run: RunRecord, activity: Activity, extra: Extra = {}): void {
    this.options.runs()?.setActivity(run, activity, this.stamp(), extra);
  }

  /** A hook's change: counted, so a reconcile pass that read before it does not undo it. */
  private hooked(run: RunRecord, activity: Activity, extra: Extra = {}): void {
    this.hookCount.set(run.run_id, (this.hookCount.get(run.run_id) ?? 0) + 1);
    this.set(run, activity, extra);
  }

  /** Registers the lifecycle hooks; each returns its unsubscribe, collected for cleanup. */
  register(server: PluginLifecycleRegistration): (() => void)[] {
    const hook =
      <E extends { agent: { id: string } }>(fn: (run: RunRecord, event: E) => void) =>
      (event: E, context: { paseo: PaseoApi }) => {
        this.options.attach(context.paseo);
        const run = this.run(event.agent.id);
        if (run) fn(run, event);
      };
    return [
      // A new turn's reply is not known yet; the previous one is not shown as if it were.
      onHook(
        server,
        "agent.turn_started",
        hook((run, event: { agent: { id: string; cwd?: string } }) => {
          this.hooked(run, "working", { lastMessage: undefined });
          const cwd = event.agent.cwd;
          // Outside the hook: following subscribes and refetches, and hooks must not wait on the daemon.
          if (cwd) setTimeout(() => this.options.onTurnStarted?.(run, cwd), 0);
        }),
      ),
      onHook(
        server,
        "agent.permission_requested",
        hook((run, event: { agent: { id: string }; request: PermissionRequest }) =>
          this.hooked(run, "needs_input", { waitingFor: describeRequest(event.request), waitingKind: waitingKindOf(event.request) }),
        ),
      ),
      onHook(server, "agent.permission_resolved", hook((run) => this.hooked(run, "working"))),
      onHook(
        server,
        "agent.turn_ended",
        hook((run, event: { agent: { id: string }; outcome: { kind: string; error?: { message: string } } }) => {
          if (event.outcome.kind === "failed") this.hooked(run, "failed", { error: event.outcome.error?.message ?? "the turn failed" });
          else this.hooked(run, "waiting");
          // Read outside the hook: hooks must not wait on the daemon.
          setTimeout(() => {
            void this.readLastMessage(run).catch((e: unknown) => this.log(`last message of ${run.run_id}: ${(e as Error).message}`));
            this.options.onTurnEnded?.(run);
          }, 0);
        }),
      ),
      onHook(server, "agent.closed", hook((run) => this.hooked(run, "stopped"))),
      onHook(server, "agent.archived", hook((run) => this.hooked(run, "stopped"))),
      onHook(server, "workspace.archived", (event, context) => {
        this.options.attach(context.paseo);
        for (const run of this.options.runs()?.runs.values() ?? []) {
          // A failed start archives its own stray workspace; its reason, not "stopped", is what stays.
          if (run.workspaceId !== event.workspace.id) continue;
          if (!run.workspaceArchivedAt) {
            run.workspaceArchivedAt = new Date().toISOString();
            this.options.runs()?.save();
          }
          // A tracked workspace may have no agent; it stops all the same.
          if ((run.agentId || run.adopted) && run.activity !== "stopped" && run.activity !== "failed") this.hooked(run, "stopped");
          if (run.agentId || run.adopted) setTimeout(() => this.options.onWorkspaceArchived?.(run), 0);
        }
      }),
    ];
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * The assistant's text of the latest turn, cut short. Entries carry a `turnId`; a message sent by
   * another agent or a tool does not always appear as a user message, so the turn, not the last user
   * message, bounds the reply. Without turn ids, the text after the latest user message counts.
   */
  async readLastMessage(run: RunRecord): Promise<void> {
    const paseo = this.options.paseo();
    if (!paseo || !run.agentId) return;
    const seen = this.hookCount.get(run.run_id) ?? 0;
    const page = (await paseo.agents.ref(run.agentId).timeline.refetch({ direction: "tail", limit: 20 })) as {
      entries?: { item?: { type?: string; text?: string }; turnId?: string }[];
    };
    const entries = (page.entries ?? []).filter((e) => e.item);
    let lastUser = -1;
    entries.forEach((entry, index) => {
      if (entry.item!.type === "user_message") lastUser = index;
    });
    const replies = entries.filter((e) => e.item!.type === "assistant_message" && typeof e.item!.text === "string");
    const turn = replies.at(-1)?.turnId;
    const text = (turn ? replies.filter((e) => e.turnId === turn) : replies.filter((e) => entries.indexOf(e) > lastUser))
      .map((e) => e.item!.text!.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    // A new turn started while this was read: its reply is not this one.
    if (!text || (this.hookCount.get(run.run_id) ?? 0) !== seen) return;
    run.lastMessage = text.length <= LAST_MESSAGE_CHARS ? text : `${text.slice(0, LAST_MESSAGE_CHARS - 1)}…`;
    this.options.runs()?.save();
    this.options.onLastMessage?.(run);
  }

  /**
   * Activity from each tracked agent's own snapshot: catches every hook missed while the plugin was
   * reloading or the daemon restarting. A run whose agent is gone is stopped.
   */
  async reconcile(): Promise<void> {
    const paseo = this.options.paseo();
    const store = this.options.runs();
    if (!paseo || !store || this.reconciling) {
      // Without the data (the ownership was lost) the followed runs are dropped all the same.
      if (!store) this.options.onReconciled?.();
      return;
    }
    this.reconciling = true;
    try {
      for (const run of store.runs.values()) {
        if (run.adopted?.trunk && this.options.isLive?.(run) !== false) this.options.onReconcileTrunk?.(run);
        if (!run.agentId || run.activity === "stopped" || run.activity === "launching") continue;
        // A released, finished or taken-over task's run is no longer this machine's to follow.
        if (this.options.isLive?.(run) === false) {
          // One at a time, inside the pass: never a burst of stops; one that throws ends nothing else.
          try {
            await this.options.onRunOver?.(run);
          } catch (error) {
            this.log(`run ${run.run_id}: stopping its agent failed: ${String(error)}`);
          }
          continue;
        }
        const seen = this.hookCount.get(run.run_id) ?? 0;
        try {
          const refreshed = await paseo.agents.ref(run.agentId).refresh();
          if ((this.hookCount.get(run.run_id) ?? 0) !== seen) continue;
          if (!refreshed) {
            this.set(run, "stopped");
            continue;
          }
          const next = activityOf(refreshed.agent as AgentSnapshot);
          // A failed turn leaves the agent idle; the failure stays shown until the next turn starts.
          if (run.activity === "failed" && next.activity === "waiting") continue;
          if (next.activity !== run.activity || next.waitingFor !== run.waitingFor || (next.waitingKind ?? "permission") !== (run.waitingKind ?? "permission")) {
            this.set(run, next.activity, { waitingFor: next.waitingFor, waitingKind: next.waitingKind, ...(next.error ? { error: next.error } : {}) });
          }
          // A reply a missed hook did not read, or one read wrongly, is read again while the agent waits.
          if (next.activity === "waiting") await this.readLastMessage(run);
          this.noteSettings(run, refreshed.agent as AgentSettingsSnapshot);
          const cwd = (refreshed.agent as { cwd?: string }).cwd;
          if (cwd && next.activity !== "stopped") this.options.onAgentSeen?.(run, cwd);
        } catch (error) {
          this.log(`reconcile ${run.run_id}: ${(error as Error).message}`);
        }
      }
      this.options.onReconciled?.();
    } finally {
      this.reconciling = false;
    }
  }

  /** Keeps the mode and effort Paseo reports for the run's agent, so a screen can say what it actually runs with. */
  private noteSettings(run: RunRecord, agent: AgentSettingsSnapshot): void {
    const reported = reportedSettings(agent);
    if (!reported || (reported.modeId === run.reported?.modeId && reported.effortId === run.reported?.effortId)) return;
    run.reported = reported;
    this.options.runs()?.save();
  }

  start(): void {
    if (this.timer) return;
    void this.reconcile().catch(() => undefined);
    this.timer = setInterval(() => void this.reconcile().catch(() => undefined), this.options.reconcileEveryMs ?? 180_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
