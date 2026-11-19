/**
 * The Laconote REST calls the dashboard makes, with the key as a bearer token: the import's
 * GET /api/v1/history/meetings and GET /api/v1/history/meetings/{id} (the shapes of laconote-mcp-plugin
 * src/core/client.ts), and the release context's GET /api/v1/projects and
 * PUT /api/v1/projects/{id}/release-context (05-architecture.md, Release context).
 * No error text it produces carries the key, even when the server echoes it back.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Each call gives up after this long, so an RPC answers within Paseo's 30 s. */
export const LACONOTE_TIMEOUT_MS = 10_000;

export class LaconoteError extends Error {
  /** The HTTP status Laconote answered with; 0 when it did not answer. */
  readonly status: number;
  /** The `error` code of the answer's body, when it had one. */
  readonly code: string;

  constructor(message: string, status = 0, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface MeetingListItem {
  id: string;
  title: string;
  date: string;
  has_summary: boolean;
}

export interface LaconoteProject {
  id: string;
  name: string;
  /** The key owner's role in it: owner, maintainer, editor, commenter or viewer. */
  role: string;
}

/** The body of PUT /api/v1/projects/{id}/release-context (core docs/plans/delivery-release-context.md). */
export interface ReleaseContextBody {
  sender_id: string;
  source: string;
  releases: { external_id: string; name: string; due_date: string; progress?: number }[];
}

export class LaconoteClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, key: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike, timeoutMs = LACONOTE_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async listMeetings(limit: number): Promise<MeetingListItem[]> {
    const body = (await this.get(`/history/meetings?limit=${limit}&sort=date_desc`)) as { meetings?: unknown };
    if (!Array.isArray(body?.meetings)) throw new LaconoteError("Laconote answered without a meeting list");
    return body.meetings.flatMap((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const id = typeof m.meeting_id === "string" ? m.meeting_id : "";
      if (!id) return [];
      const title = typeof m.meeting_name === "string" && m.meeting_name.trim() ? m.meeting_name.trim() : id;
      const date = typeof m.date === "string" ? m.date.slice(0, 16).replace("T", " ") : "";
      return [{ id, title, date, has_summary: m.has_summary === true }];
    });
  }

  getMeeting(id: string): Promise<unknown> {
    return this.get(`/history/meetings/${encodeURIComponent(id)}`);
  }

  /** The projects the key's owner belongs to. */
  async listProjects(): Promise<LaconoteProject[]> {
    const body = (await this.get("/projects")) as { projects?: unknown };
    if (!Array.isArray(body?.projects)) throw new LaconoteError("Laconote answered without a project list");
    return body.projects.flatMap((raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      if (!id) return [];
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : id;
      return [{ id, name, role: typeof p.role === "string" ? p.role : "" }];
    });
  }

  /** Replaces the project's release set; Laconote merges it and answers the stored resource. */
  async putReleaseContext(project: string, body: ReleaseContextBody): Promise<void> {
    // The answer is the stored set, which the dashboard does not read: a 2xx is enough.
    await this.request("PUT", `/projects/${encodeURIComponent(project)}/release-context`, JSON.stringify(body), false);
  }

  private redact(text: string): string {
    return this.key ? text.split(this.key).join("[key]") : text;
  }

  private get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  private async request(method: string, path: string, body?: string, parse = true): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status = 0;
    let ok = false;
    let text = "";
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal });
      status = res.status;
      ok = res.ok;
      // Read the body inside the timeout window: a stalled body must abort too.
      text = await res.text();
    } catch (error) {
      const reason = controller.signal.aborted ? `no answer within ${Math.round(this.timeoutMs / 1000)} s` : String((error as Error)?.message ?? error);
      throw new LaconoteError(this.redact(`could not reach Laconote at ${this.baseUrl}: ${reason}`));
    } finally {
      clearTimeout(timer);
    }
    if (!ok) throw new LaconoteError(this.redact(`Laconote answered ${status}: ${errorText(text, status)}`), status, errorCode(text));
    if (!parse || !text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new LaconoteError(`Laconote answered ${status} with something that is not JSON`);
    }
  }
}

/** The `error` field of an error answer, when it is a short code such as RELEASE_CONTEXT_OWNED_BY_OTHER. */
function errorCode(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" && /^[A-Za-z_]{1,80}$/.test(body.error) ? body.error : "";
  } catch {
    return "";
  }
}

function errorText(text: string, status: number): string {
  const fallback = status === 401 || status === 403 ? "the key was not accepted" : `HTTP ${status}`;
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const parts = [body.error, body.message].filter((v): v is string => typeof v === "string" && v.trim() !== "");
    return parts.length ? [...new Set(parts)].join(": ").slice(0, 300) : fallback;
  } catch {
    return `${fallback}: ${text.replace(/\s+/g, " ").slice(0, 200)}`;
  }
}
