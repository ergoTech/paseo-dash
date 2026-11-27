import type { PaseoApi } from "../paseo.ts";

/**
 * A stand-in for the part of PaseoApi the runner uses. Idempotency as the 0.13 daemon behaves: the
 * same key and request return the same object, the same key with another request fails with
 * `<kind>_request_key_conflict` (seen live for agents in spike A, 08-phase-3-spikes.md; the
 * daemon's creation code keys workspaces the same way).
 */

export interface FakeAgent {
  id: string;
  workspaceId: string;
  request: Record<string, unknown>;
  labels: Record<string, string>;
  /** Items appended by the plugin (cards). */
  timeline: unknown[];
  /** The conversation `timeline.refetch` returns, oldest first. */
  history: { type: string; text?: string; turnId?: string }[];
  status: string;
  pendingPermissions: { title?: string; name?: string; kind?: string; input?: Record<string, unknown> }[];
  lastError: string | null;
  archivedAt: string | null;
  /** As `agents.list` shows an agent: where it works, its provider and title. */
  cwd?: string;
  provider?: string;
  title?: string;
  currentModeId?: string;
  /** Gone from the daemon: `refresh()` answers null. */
  gone?: boolean;
}

export interface FakeWorkspace {
  id: string;
  request: Record<string, unknown>;
  branch: string;
  createdAt: string;
  /** For a workspace a person made outside the dashboard (`addOwn`). */
  projectId?: string;
  name?: string;
  /** Paseo's `workspaceKind`; a created one is a `worktree`. */
  kind?: string;
  directory?: string;
}

export interface FakePaseoOptions {
  /** Shaped like Paseo 0.13's AgentProfileSchema. */
  profiles?: { id: string; name: string; provider: string; model?: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }[];
  providers?: string[];
  /**
   * The providers snapshot's modes, by provider, shaped like Paseo 0.13's ProviderSnapshotEntry;
   * default: Claude declares `auto`, Codex `auto-review` (as on the Mac of 2026-10-27), others none.
   * "fail": `providers.snapshot()` throws.
   */
  modes?: Record<string, { status?: string; defaultModeId?: string | null; modes?: { id: string; label: string; colorTier?: string }[] }> | "fail";
  /**
   * The models `providers.listModels` lists, by provider, shaped like Paseo 0.13's AgentModelDefinition;
   * default: `<provider>-small` and the default `<provider>-default`, neither with efforts. "fail": it throws.
   */
  models?: Record<string, { id: string; isDefault?: boolean; thinkingOptions?: { id: string; label: string }[]; defaultThinkingOptionId?: string }[]> | "fail";
  /** The branch Paseo really checks out, by requested name (Paseo renames a taken branch). */
  actualBranch?: (requested: string) => string;
  /**
   * Reads of a created workspace (`refresh()`, `list()`) that come back without `gitRuntime`, as
   * Paseo 0.13.2 answers until its git watcher has looked at a new worktree; the creation answer
   * always has the branch. "never": no read ever has it.
   */
  gitUnknownReads?: number | "never";
  /** Awaited inside every agent `refresh()`, so a test can hold a reconcile pass mid-read. */
  beforeAgentRefresh?: () => Promise<void>;
  /**
   * Fails the next N workspace or agent creations after doing them ("outcome unknown"); a repeat
   * with the same key fails again, as the daemon does.
   */
  failAfterCreate?: { workspace?: number; agent?: number };
  /** Every agent creation fails with this error and makes nothing. */
  agentError?: string;
  /** Paseo projects on this machine, shaped like `projects.list` entries; `workspaces.open` adds one. */
  projects?: { projectId: string; projectDisplayName: string; projectKind: "git" | "non_git" | "directory"; projectRootPath: string }[];
}

const DEFAULT_MODES = {
  claude: {
    defaultModeId: "auto",
    // Colour tiers as Paseo 0.13 lists them for Claude: "Always Ask" is `safe`, "Plan Mode" `planning`.
    modes: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "auto", label: "Auto mode", colorTier: "moderate" },
    ],
  },
  codex: {
    defaultModeId: "auto-review",
    modes: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "auto-review", label: "Auto-review", colorTier: "moderate" },
    ],
  },
};

export class FakePaseo {
  readonly workspaces = new Map<string, FakeWorkspace>();
  readonly agents = new Map<string, FakeAgent>();
  readonly calls: { kind: string; key?: string }[] = [];
  readonly archived: string[] = [];
  readonly opened: string[] = [];
  /** Messages sent to agents (`agents.ref(id).send`), in order. */
  readonly sent: { agentId: string; text: string }[] = [];
  /** Live timeline subscribers by agent: a test sends stream events through them. */
  readonly subscribers = new Map<string, (message: unknown) => void>();
  private readonly keys = new Map<string, { fingerprint: string; id: string; failed?: string }>();
  private readonly gitReads = new Map<string, number>();
  private readonly options: FakePaseoOptions;
  private counter = 0;

  constructor(options: FakePaseoOptions = {}) {
    this.options = options;
  }

  private keyed<T extends { id: string }>(kind: string, key: string | undefined, request: unknown, make: () => T, find: (id: string) => T): T {
    this.calls.push({ kind, key });
    if (!key) return make();
    const fingerprint = JSON.stringify(request);
    const known = this.keys.get(`${kind}:${key}`);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new Error(`${kind}_request_key_conflict`);
      // The daemon returns a recorded "outcome unknown" as it is, without a new attempt.
      if (known.failed) throw new Error(known.failed);
      return find(known.id);
    }
    const made = make();
    this.keys.set(`${kind}:${key}`, { fingerprint, id: made.id });
    return made;
  }

  /** A created workspace's `gitRuntime` on a read, or none while Paseo has not looked at it yet. */
  private gitRuntime(w: FakeWorkspace): { gitRuntime?: { currentBranch: string } } {
    const unknown = this.options.gitUnknownReads;
    const reads = (this.gitReads.get(w.id) ?? 0) + 1;
    this.gitReads.set(w.id, reads);
    if (!w.kind && (unknown === "never" || reads <= (unknown ?? 0))) return {};
    return { gitRuntime: { currentBranch: w.branch } };
  }

  /** A workspace a person made in Paseo outside the dashboard, with its agent if it has one. */
  addOwn(w: { id: string; projectId: string; branch: string; kind: string; directory: string; name: string; agent?: { id: string; status: string } }): void {
    this.workspaces.set(w.id, { id: w.id, request: {}, branch: w.branch, createdAt: new Date().toISOString(), projectId: w.projectId, name: w.name, kind: w.kind, directory: w.directory });
    if (w.agent) {
      this.agents.set(w.agent.id, {
        id: w.agent.id,
        workspaceId: w.id,
        request: {},
        labels: {},
        timeline: [],
        history: [],
        status: w.agent.status,
        pendingPermissions: [],
        lastError: null,
        archivedAt: null,
      });
    }
  }

  api(): PaseoApi {
    const fake = this;
    const failing = { ...this.options.failAfterCreate };
    const agentHandle = (id: string) => ({
      id,
      refresh: async () => {
        await fake.options.beforeAgentRefresh?.();
        const a = fake.agents.get(id);
        if (!a || a.gone) return null;
        return { agent: { id, cwd: "/", status: a.status, pendingPermissions: a.pendingPermissions, lastError: a.lastError, archivedAt: a.archivedAt }, project: null };
      },
      send: async (text: string) => {
        if (!fake.agents.has(id)) throw new Error(`agent ${id} not found`);
        fake.sent.push({ agentId: id, text });
      },
      timeline: {
        append: async (item: unknown) => {
          fake.agents.get(id)?.timeline.push(item);
          return { seq: 1, epoch: "e" };
        },
        subscribe: (handler: (message: unknown) => void) => {
          fake.subscribers.set(id, handler);
          const release = () => fake.subscribers.delete(id);
          return Object.assign(release, { ready: Promise.resolve(), subscriptionId: `sub-${id}`, release: async () => void release() });
        },
        refetch: async () => ({ entries: (fake.agents.get(id)?.history ?? []).slice(-20).map(({ turnId, ...item }) => ({ item, ...(turnId ? { turnId } : {}) })) }),
      },
    });
    const projects = (fake.options.projects ??= []);
    const api = {
      projects: {
        list: async () => ({ requestId: "r", projects: [...projects] }),
      },
      config: {
        get: async () => ({ requestId: "r", config: { agentProfiles: fake.options.profiles ?? [], providers: { secretish: { env: { KEY: "x" } } } } }),
      },
      providers: {
        listAvailable: async () => ({ providers: (fake.options.providers ?? ["claude"]).map((provider) => ({ provider, available: true, error: null })) }),
        listModels: async (provider: string) => {
          const models = fake.options.models;
          if (models === "fail") throw new Error("models unavailable");
          return { provider, models: models?.[provider] ?? [{ id: `${provider}-small` }, { id: `${provider}-default`, isDefault: true }] };
        },
        snapshot: async () => {
          fake.calls.push({ kind: "providers.snapshot" });
          const modes = fake.options.modes ?? DEFAULT_MODES;
          if (modes === "fail") throw new Error("providers snapshot unavailable");
          const entries = Object.entries(modes).map(([provider, entry]) => ({ provider, status: "ready", enabled: true, ...entry }));
          return { entries, generatedAt: "2026-10-27T10:00:00Z", requestId: "r" };
        },
      },
      workspaces: {
        open: async ({ cwd }: { cwd: string }) => {
          fake.opened.push(cwd);
          if (!projects.some((p) => p.projectRootPath === cwd)) {
            projects.push({ projectId: `prj_${++fake.counter}`, projectDisplayName: cwd.split("/").pop()!, projectKind: "git", projectRootPath: cwd });
          }
          return { id: `wks_open_${fake.counter}` };
        },
        create: async (options: Record<string, unknown>) => {
          const { idempotencyKey, ...request } = options;
          const made = fake.keyed(
            "workspace",
            idempotencyKey as string | undefined,
            request,
            () => {
              const id = `wks_${++fake.counter}`;
              // A branch-off names its new branch; a checkout names the existing one it checks out.
              const source = request.source as { branchName?: string; refName?: string };
              const asked = source.branchName ?? source.refName ?? "";
              const branch = fake.options.actualBranch?.(asked) ?? asked;
              const workspace = { id, request, branch, createdAt: new Date().toISOString() };
              fake.workspaces.set(id, workspace);
              return workspace;
            },
            (id) => fake.workspaces.get(id)!,
          );
          if (failing.workspace) {
            failing.workspace -= 1;
            const known = fake.keys.get(`workspace:${idempotencyKey}`);
            if (known) known.failed = "workspace creation outcome unknown";
            throw new Error("workspace creation outcome unknown");
          }
          // The handle Paseo's SDK returns keeps the creation answer, which names the branch.
          return { id: made.id, current: () => ({ id: made.id, gitRuntime: { currentBranch: made.branch } }) };
        },
        list: async () => ({
          requestId: "r",
          entries: [...fake.workspaces.values()].map((w) => ({
            id: w.id,
            projectId: w.projectId ?? (w.request.source as { projectId?: string } | undefined)?.projectId,
            title: w.request.title,
            createdAt: w.createdAt,
            archivingAt: fake.archived.includes(w.id) ? "2026-10-26T10:00:00Z" : null,
            ...fake.gitRuntime(w),
          })),
          pageInfo: {},
        }),
        archive: async (id: string) => {
          fake.archived.push(id);
          return { requestId: "r", workspaceId: id, archivedAt: "2026-10-26T10:00:00Z", error: null };
        },
        ref: (id: string) => ({
          id,
          refresh: async () => {
            const workspace = fake.workspaces.get(id);
            return workspace
              ? {
                  id,
                  projectId: workspace.projectId ?? (workspace.request.source as { projectId?: string } | undefined)?.projectId,
                  name: workspace.name ?? workspace.request.title,
                  workspaceKind: workspace.kind ?? "worktree",
                  ...(workspace.directory ? { workspaceDirectory: workspace.directory } : {}),
                  archivingAt: fake.archived.includes(id) ? "2026-10-26T10:00:00Z" : null,
                  ...fake.gitRuntime(workspace),
                }
              : null;
          },
          agents: {
            create: async (options: Record<string, unknown>) => {
              const { idempotencyKey, ...request } = options;
              if (fake.options.agentError) throw new Error(fake.options.agentError);
              const made = fake.keyed(
                "agent",
                idempotencyKey as string | undefined,
                request,
                () => {
                  const agentId = `agent-${++fake.counter}`;
                  const agent: FakeAgent = {
                    id: agentId,
                    workspaceId: id,
                    request,
                    labels: (request.labels as Record<string, string>) ?? {},
                    timeline: [],
                    history: [{ type: "user_message", text: String(request.prompt ?? "") }],
                    status: "running",
                    pendingPermissions: [],
                    lastError: null,
                    archivedAt: null,
                  };
                  fake.agents.set(agentId, agent);
                  return agent;
                },
                (agentId) => fake.agents.get(agentId)!,
              );
              if (failing.agent) {
                failing.agent -= 1;
                throw new Error("agent creation outcome unknown");
              }
              return agentHandle(made.id);
            },
          },
        }),
      },
      agents: {
        list: async (options: { filter?: { labels?: Record<string, string> } } = {}) => {
          const wanted = options.filter?.labels ?? {};
          const entries = [...fake.agents.values()]
            .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
            .map((a) => ({ agent: { id: a.id, workspaceId: a.workspaceId, labels: a.labels, archivedAt: a.archivedAt, status: a.status, pendingPermissions: a.pendingPermissions, cwd: a.cwd, provider: a.provider, title: a.title, currentModeId: a.currentModeId } }));
          return { requestId: "r", entries, pageInfo: {} };
        },
        ref: agentHandle,
      },
    };
    return api as unknown as PaseoApi;
  }
}

/** Resolves once the runner settled every run (no launching state left), or after the limit. */
export async function settled(isSettled: () => boolean, limitMs = 5_000): Promise<void> {
  const until = Date.now() + limitMs;
  while (!isSettled() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
}

type Handler = (event: unknown, context: { paseo: PaseoApi; signal: AbortSignal }) => unknown;

/** A plugin server stand-in that keeps the lifecycle hooks, so a test can fire them. */
export class FakeHooks {
  readonly handlers = new Map<string, Handler[]>();
  private readonly paseo: PaseoApi;

  constructor(paseo: PaseoApi) {
    this.paseo = paseo;
  }

  on(name: string, handler: Handler): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== handler));
  }

  async fire(name: string, event: unknown): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, { paseo: this.paseo, signal: new AbortController().signal });
  }
}
