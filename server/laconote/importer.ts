import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  type laconoteConfigureRpc,
  type laconoteImportRpc,
  type laconoteMeetingsRpc,
  type laconotePreviewRpc,
  type laconoteSettingsRpc,
} from "../../shared/laconote.ts";
import type { Task } from "../../shared/model.ts";
import { resolveCreateSpace } from "../api/resolve.ts";
import { addDrafts, type Draft, ownerError, type WriteContext } from "../api/writes.ts";
import { type FetchLike, LaconoteClient } from "./client.ts";
import { itemKey, meetingTitle, sourceKey, toDraft } from "./drafts.ts";
import { type Meeting, meetingFromApi, meetingFromExport } from "./meeting.ts";
import type { LaconoteStore } from "./store.ts";

/**
 * The import's handlers (05-architecture.md, Laconote import). A meeting's words only ever become
 * inbox drafts here: nothing from a meeting starts an agent, and no answer or log line carries the key.
 */

export interface LaconoteContext extends WriteContext {
  /** The HTTP client; the global fetch by default, a fake in tests. */
  fetch?: FetchLike;
}

/** A write waits this long for the space's queue, so a fetch plus a write answer within Paseo's 30 s. */
const IMPORT_WRITE_WAIT_MS = 15_000;

/** Meeting ids the meeting link form accepts (writes.ts, MEETING_URL). */
const MEETING_ID = /^[A-Za-z0-9_-]{1,200}$/;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function store(ctx: LaconoteContext): Result<LaconoteStore> {
  const owner = ownerError(ctx);
  if (owner) return { ok: false, error: owner };
  const found = ctx.dashboard.laconote;
  return found ? { ok: true, value: found } : { ok: false, error: "Paseo Dash has not started" };
}

/** Any error text with the key cut out, whatever produced it. */
function safeMessage(error: unknown, key: string | undefined): string {
  const text = String((error as Error)?.message ?? error);
  return key ? text.split(key).join("[key]") : text;
}

/**
 * An http(s) base URL without credentials, query or fragment, and without a trailing slash; "" is the
 * default. With `secure`, plain http is accepted only for this machine (the key travels with it).
 */
export function baseUrl(text: string, fallback: string, secure = false): Result<string> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: fallback };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "only http and https URLs" };
  if (secure && url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return { ok: false, error: "https only, the key travels with every request (http only for localhost)" };
  }
  if (url.username || url.password) return { ok: false, error: "no user name or password in the URL" };
  if (url.search || url.hash) return { ok: false, error: "no query or fragment in the URL" };
  return { ok: true, value: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

type Settings = RpcOutput<typeof laconoteSettingsRpc>;

export function laconoteSettings(ctx: LaconoteContext): Settings {
  const found = store(ctx);
  if (!found.ok) return { api_url: DEFAULT_API_URL, web_url: DEFAULT_WEB_URL, key_set: false, error: found.error };
  return { api_url: found.value.apiUrl, web_url: found.value.webUrl, key_set: found.value.hasKey, error: "" };
}

type Configure = RpcOutput<typeof laconoteConfigureRpc>;

export function configureLaconote(ctx: LaconoteContext, input: RpcInput<typeof laconoteConfigureRpc>): Configure {
  const found = store(ctx);
  const fail = (error: string): Configure => ({ ok: false, ...laconoteSettings(ctx), error });
  if (!found.ok) return fail(found.error);
  const laconote = found.value;
  const api = input.api_url === undefined ? { ok: true as const, value: laconote.apiUrl } : baseUrl(input.api_url, DEFAULT_API_URL, true);
  if (!api.ok) return fail(`API URL: ${api.error}`);
  const web = input.web_url === undefined ? { ok: true as const, value: laconote.webUrl } : baseUrl(input.web_url, DEFAULT_WEB_URL);
  if (!web.ok) return fail(`Web URL: ${web.error}`);
  const key = input.key?.trim();
  if (key !== undefined && input.clear_key) return fail("set a key or clear it, not both");
  // The refusal never repeats the key: it may be a real one with a typo.
  if (key !== undefined && !/^[\x21-\x7e]{8,1000}$/.test(key)) return fail("the key is 8 or more printable characters, without spaces");
  // A key is for one Laconote server: moving to another without a new key drops it, so it is never sent elsewhere.
  const otherServer = new URL(api.value).origin !== new URL(laconote.apiUrl).origin;
  try {
    // Clear, then the URLs, then the new key: whichever write fails, no key is left next to a server
    // it was not given for (at worst no key is left at all). The clear goes by the file, not by what
    // memory believes, so a disagreement between the two cannot skip it.
    if (input.clear_key || otherServer) laconote.clearKey();
    if (api.value !== laconote.apiUrl || web.value !== laconote.webUrl) laconote.setUrls(api.value, web.value);
    if (key) laconote.setKey(key);
  } catch (error) {
    return fail(`could not save: ${safeMessage(error, key)}`);
  }
  // A new key or server may take what the old one was refused: the release context tries again now.
  if (key || input.clear_key || otherServer) {
    try {
      ctx.dashboard.releaseStore?.retryNow();
    } catch {
      // The next failure or success writes the record again.
    }
    void ctx.dashboard.releases.pass().catch(() => undefined);
  }
  return { ok: true, ...laconoteSettings(ctx) };
}

type Meetings = RpcOutput<typeof laconoteMeetingsRpc>;

export async function laconoteMeetings(ctx: LaconoteContext, input: RpcInput<typeof laconoteMeetingsRpc>): Promise<Meetings> {
  const found = store(ctx);
  if (!found.ok) return { meetings: [], error: found.error };
  const key = found.value.key();
  if (!key) return { meetings: [], error: "no Laconote API key is set; add one in Settings → Paseo Dash, or paste an export" };
  try {
    const meetings = await new LaconoteClient(found.value.apiUrl, key, ctx.fetch).listMeetings(input.limit);
    return { meetings, error: "" };
  } catch (error) {
    return { meetings: [], error: safeMessage(error, key) };
  }
}

/** The meeting a preview or an import names: read from the API, or parsed from the paste. */
async function loadMeeting(ctx: LaconoteContext, laconote: LaconoteStore, input: { meeting?: string; text?: string }): Promise<Result<Meeting>> {
  if (Boolean(input.meeting) === Boolean(input.text?.trim())) return { ok: false, error: "choose a meeting or paste an export, one of them" };
  if (input.text !== undefined && input.text.trim()) {
    const meeting = meetingFromExport(input.text);
    if (!meeting.title) return { ok: false, error: "this does not look like a Laconote Markdown export: it has no \"# <meeting title>\" line" };
    return { ok: true, value: meeting };
  }
  const id = input.meeting!;
  if (!MEETING_ID.test(id)) return { ok: false, error: "not a Laconote meeting id" };
  const key = laconote.key();
  if (!key) return { ok: false, error: "no Laconote API key is set; add one in Settings → Paseo Dash, or paste an export" };
  try {
    const meeting = meetingFromApi(await new LaconoteClient(laconote.apiUrl, key, ctx.fetch).getMeeting(id));
    return { ok: true, value: { ...meeting, id, title: meeting.title || id } };
  } catch (error) {
    return { ok: false, error: safeMessage(error, key) };
  }
}

const meetingUrl = (laconote: LaconoteStore, meeting: Meeting) => (meeting.id ? `${laconote.webUrl}/meeting/${encodeURIComponent(meeting.id)}` : "");

type Preview = RpcOutput<typeof laconotePreviewRpc>;

export async function previewMeeting(ctx: LaconoteContext, input: RpcInput<typeof laconotePreviewRpc>): Promise<Preview> {
  const empty = (error: string): Preview => ({ source: "", title: "", date: "", url: "", topics: [], error });
  const found = store(ctx);
  if (!found.ok) return empty(found.error);
  const loaded = await loadMeeting(ctx, found.value, input);
  if (!loaded.ok) return empty(loaded.error);
  const meeting = loaded.value;
  const imported = found.value.imported(sourceKey(meeting));
  return {
    source: meeting.id ? "api" : "paste",
    title: meeting.title,
    date: meeting.date,
    url: meetingUrl(found.value, meeting),
    topics: meeting.topics.map((topic) => ({
      title: topic.title,
      decisions: topic.decisions,
      links: topic.links,
      items: topic.items.map((item) => ({ text: item.task, owner: item.owner, deadline: item.deadline, priority: item.priority, imported: imported.has(itemKey(item.task)) })),
    })),
    error: "",
  };
}

type Import = RpcOutput<typeof laconoteImportRpc>;

export async function importItems(ctx: LaconoteContext, input: RpcInput<typeof laconoteImportRpc>): Promise<Import> {
  const fail = (error: string): Import => ({ ok: false, created: [], skipped: [], error });
  const found = store(ctx);
  if (!found.ok) return fail(found.error);
  const laconote = found.value;
  const spaceFound = resolveCreateSpace(ctx.dashboard, input.space);
  if (!spaceFound.ok) return fail(spaceFound.error);
  const loaded = await loadMeeting(ctx, laconote, input);
  if (!loaded.ok) return fail(loaded.error);
  const meeting = loaded.value;

  const source = sourceKey(meeting);
  const before = laconote.imported(source);
  const chosen = new Set(input.items.map(itemKey));
  const drafts: Draft[] = [];
  // A draft's title may stand for several items (titles are cut), so each title keeps its items' keys in order.
  const keys = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const topic of meeting.topics) {
    for (const item of topic.items) {
      const key = itemKey(item.task);
      if (!chosen.delete(key)) continue;
      if (before.has(key)) {
        skipped.push(item.task);
        continue;
      }
      const draft = toDraft(meeting, topic, item);
      drafts.push(draft);
      keys.set(draft.title, [...(keys.get(draft.title) ?? []), key]);
    }
  }
  if (drafts.length === 0) {
    return chosen.size > 0 && skipped.length === 0 ? fail("none of the chosen action items is in this meeting") : { ok: true, created: [], skipped, error: "" };
  }

  const url = meetingUrl(laconote, meeting);
  const title = meetingTitle(meeting);
  const same = (task: Pick<Task, "meeting" | "meeting_title">) => (url ? task.meeting === url : !task.meeting && task.meeting_title === title);
  let result: Import;
  try {
    result = await addDrafts({ ...ctx, writeWaitMs: ctx.writeWaitMs ?? IMPORT_WRITE_WAIT_MS }, spaceFound.value, drafts, { meeting: url || undefined, meeting_title: title, same });
  } catch (error) {
    return fail(String((error as Error)?.message ?? error));
  }
  // Drafts made now, and those an open draft of the same meeting already holds, count as imported.
  const done = [...result.created.map((c) => c.title), ...result.skipped].flatMap((t) => {
    const key = keys.get(t)?.shift();
    return key ? [key] : [];
  });
  if (done.length) {
    try {
      laconote.remember(source, title, done, (ctx.now ?? (() => new Date()))());
    } catch (error) {
      result = { ...result, error: [result.error, `the drafts exist, but this machine could not record the import: ${String((error as Error)?.message ?? error)}`].filter(Boolean).join("; ") };
    }
  }
  return { ...result, skipped: [...skipped, ...result.skipped] };
}
