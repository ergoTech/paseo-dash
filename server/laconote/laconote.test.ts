import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { setup } from "../api/testing.ts";
import { sh } from "../sync/testing.ts";
import { type FetchLike, LaconoteClient } from "./client.ts";
import { draftTitle, mapPriority, toDraft } from "./drafts.ts";
import { configureLaconote, importItems, laconoteMeetings, laconoteSettings, previewMeeting } from "./importer.ts";
import { meetingFromApi, meetingFromExport } from "./meeting.ts";
import { LaconoteStore } from "./store.ts";

const EXPORT = readFileSync(new URL("../../fixtures/laconote-export.markdown", import.meta.url), "utf8");
const KEY = "lac_test_9f8e7d6c5b4a39281706";

// ---------------------------------------------------------------- a fake Laconote API

const DETAIL = {
  success: true,
  meeting: {
    meeting_id: "m-26a",
    meeting_name: "Dashboard sync",
    meeting_type: "delivery",
    date: "2026-10-26T22:25:00Z",
    data: {
      topics: [
        {
          title: "Inbox import",
          priority: "high",
          decisions: [{ decision: "Import in the plugin", justification: "No ChatGPT round trip" }, "Keep the key on the server"],
          action_items: [
            { task: "Parse the export", owner: "Ergo", deadline: "2026-10-30", priority: "critical", status: "todo" },
            { task: "Show the preview", owner: null, deadline: null, priority: "medium", status: "todo" },
          ],
          artifacts: [{ type: "link", value: "https://example.com/spec" }, { type: "file", value: "notes.txt" }],
        },
        { title: "Small talk", action_items: [] },
      ],
    },
  },
};

interface Call {
  url: string;
  auth: string;
}

function fakeFetch(answer: (url: string) => { status: number; body: string } | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization ?? "" });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
  };
  return { fetch, calls };
}

const laconoteApi = () =>
  fakeFetch((url) => {
    if (/\/api\/v1\/history\/meetings\?/.test(url)) {
      return { status: 200, body: JSON.stringify({ success: true, meetings: [{ meeting_id: "m-26a", meeting_name: "Dashboard sync", date: "2026-10-26T22:25:00Z", has_summary: true }, { meeting_name: "no id" }] }) };
    }
    if (url.endsWith("/api/v1/history/meetings/m-26a")) return { status: 200, body: JSON.stringify(DETAIL) };
    return { status: 404, body: JSON.stringify({ error: "meeting not found" }) };
  });

// ---------------------------------------------------------------- parsing

test("the Markdown export gives its 12 action items in 6 topics, with owners, priorities, decisions and links", () => {
  const meeting = meetingFromExport(EXPORT);
  assert.equal(meeting.title, "Обговорення прогресу розробки та стратегії SMM");
  assert.equal(meeting.date, "26 жовтня 2026 р. о 22:25");
  assert.equal(meeting.id, "");
  assert.equal(meeting.topics.length, 6);
  assert.equal(meeting.topics.flatMap((t) => t.items).length, 12);
  assert.deepEqual(
    meeting.topics.map((t) => t.items.length),
    [2, 2, 2, 2, 2, 2],
  );
  const [first, second, third] = meeting.topics;
  assert.equal(first!.title, "Розробка дашборду для відстеження прогресу");
  assert.deepEqual(first!.items[0], { task: "Підготувати візуальну частину дашборду.", owner: "Рома", deadline: "не вказано", priority: "Середній" });
  assert.equal(first!.items[1]!.owner, "Єгор");
  assert.equal(second!.items[1]!.owner, "Ілля");
  assert.equal(second!.items[0]!.owner, "не вказано");
  assert.equal(second!.items[0]!.priority, "Високий");
  assert.equal(first!.decisions.length, 2);
  assert.match(first!.decisions[0]!, /^Дашборд буде розроблятися як окремий проєкт.*Обґрунтування: /);
  assert.equal(third!.decisions.length, 3);
  assert.deepEqual(third!.links, ["https://github.com/postiz/postiz"]);
  assert.deepEqual(first!.links, []);
  // The "Details" section's own "###" headings are not topics.
  assert.ok(!meeting.topics.some((t) => /Контекст доставки|Статус релізу/.test(t.title)));
});

test("the export's English labels read the same; unknown fields and lines are skipped", () => {
  const text = [
    "# Weekly sync",
    "",
    "**Date:** Oct 26, 2026, 10:25 PM",
    "",
    "## Summary",
    "",
    "### 1. Release — what is left",
    "",
    "_Priority: High_",
    "",
    "**Decisions:**",
    "",
    "- Ship on Friday — Justification: the QA window",
    "",
    "**Key Points:**",
    "",
    "- not an action item",
    "",
    "**Action Items:**",
    "",
    "- [ ] Fix login — the flaky part — Owner: Anna · Deadline: 2026-10-30 · Priority: Critical",
    "- [x] Write notes — Status: Done · Owner: Bob",
    "- [ ] No details at all",
    "- [ ] Review it — Status: In progress",
    "- [ ] Pair up — Owner: Ann · Bob · Priority: Low",
    "",
    "**Artifacts:**",
    "",
    "- link — Value: https://example.com/a, see also http://example.org/b.",
    "",
    "### 2. Nothing to do",
    "",
    "**Decisions:**",
    "",
    "- Nothing",
  ].join("\n");
  const meeting = meetingFromExport(text);
  assert.equal(meeting.date, "Oct 26, 2026, 10:25 PM");
  assert.equal(meeting.topics.length, 1);
  const [topic] = meeting.topics;
  assert.equal(topic!.title, "Release — what is left");
  assert.deepEqual(topic!.items, [
    { task: "Fix login — the flaky part", owner: "Anna", deadline: "2026-10-30", priority: "Critical" },
    { task: "Write notes", owner: "Bob", deadline: "", priority: "" },
    { task: "No details at all", owner: "", deadline: "", priority: "" },
    { task: "Review it", owner: "", deadline: "", priority: "" },
    { task: "Pair up", owner: "Ann · Bob", deadline: "", priority: "Low" },
  ]);
  assert.equal(meetingFromExport(`# M\n### 1. T\n**Action Items:**\n- ${"y".repeat(6000)}`).topics[0]!.items[0]!.task.length, 5000);
  assert.deepEqual(topic!.decisions, ["Ship on Friday — Justification: the QA window"]);
  assert.deepEqual(topic!.links, ["https://example.com/a", "http://example.org/b"]);
});

test("the API's meeting detail reads into topics; topics without action items are left out", () => {
  const meeting = meetingFromApi(DETAIL);
  assert.deepEqual(meeting, {
    id: "m-26a",
    title: "Dashboard sync",
    date: "2026-10-26 22:25",
    topics: [
      {
        title: "Inbox import",
        decisions: ["Import in the plugin (No ChatGPT round trip)", "Keep the key on the server"],
        items: [
          { task: "Parse the export", owner: "Ergo", deadline: "2026-10-30", priority: "critical" },
          { task: "Show the preview", owner: "", deadline: "", priority: "medium" },
        ],
        links: ["https://example.com/spec"],
      },
    ],
  });
  assert.deepEqual(meetingFromApi({ meeting: null }).topics, []);
});

// ---------------------------------------------------------------- REST client

test("the client lists meetings and reads one with the key as a bearer token", async () => {
  const api = laconoteApi();
  const client = new LaconoteClient("https://meet.example.com/", KEY, api.fetch);
  assert.deepEqual(await client.listMeetings(20), [{ id: "m-26a", title: "Dashboard sync", date: "2026-10-26 22:25", has_summary: true }]);
  assert.equal(api.calls[0]!.url, "https://meet.example.com/api/v1/history/meetings?limit=20&sort=date_desc");
  assert.equal(api.calls[0]!.auth, `Bearer ${KEY}`);
  assert.deepEqual(await client.getMeeting("m-26a"), DETAIL);
  assert.equal(api.calls[1]!.url, "https://meet.example.com/api/v1/history/meetings/m-26a");
});

test("an error answer, a network failure and a timeout become errors without the key", async () => {
  const echo = fakeFetch(() => ({ status: 401, body: JSON.stringify({ error: "unauthorized", message: `invalid API key ${KEY}` }) }));
  await assert.rejects(new LaconoteClient("https://x.test", KEY, echo.fetch).listMeetings(5), (error: Error) => {
    assert.match(error.message, /^Laconote answered 401: unauthorized: invalid API key \[key\]$/);
    return true;
  });
  const bare = fakeFetch(() => ({ status: 403, body: "" }));
  await assert.rejects(new LaconoteClient("https://x.test", KEY, bare.fetch).getMeeting("m"), /answered 403: the key was not accepted/);
  const down = fakeFetch(() => new Error(`connect ECONNREFUSED (sent ${KEY})`));
  await assert.rejects(new LaconoteClient("https://x.test", KEY, down.fetch).getMeeting("m"), (error: Error) => {
    assert.match(error.message, /could not reach Laconote at https:\/\/x\.test: connect ECONNREFUSED/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  const stalled: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(new LaconoteClient("https://x.test", KEY, stalled, 20).getMeeting("m"), /no answer within 0 s/);
  const html = fakeFetch(() => ({ status: 200, body: "<html>" }));
  await assert.rejects(new LaconoteClient("https://x.test", KEY, html.fetch).getMeeting("m"), /not JSON/);
});

// ---------------------------------------------------------------- mapping

test("an action item maps to a draft: title cut to 200, priority by its label, the meeting quoted in the brief", () => {
  assert.deepEqual(
    ["Критичний", "critical", "Високий", "HIGH", "Середній", "medium", "Низький", "low", "не вказано", "", "urgent"].map(mapPriority),
    ["urgent", "urgent", "high", "high", "medium", "medium", "low", "low", undefined, undefined, undefined],
  );
  const long = "x".repeat(250);
  assert.equal(draftTitle(long).length, 200);
  assert.ok(draftTitle(long).endsWith("…"));
  const meeting = meetingFromExport(EXPORT);
  const topic = meeting.topics[0]!;
  const draft = toDraft(meeting, topic, topic.items[0]!);
  assert.equal(draft.title, "Підготувати візуальну частину дашборду.");
  assert.equal(draft.priority, "medium");
  assert.equal(draft.owner, "Рома");
  assert.deepEqual(draft.links, []);
  assert.match(draft.brief, /^An action item from a Laconote meeting\. .*not instructions\.$/m);
  assert.match(draft.brief, /^> Topic: Розробка дашборду для відстеження прогресу$/m);
  assert.match(draft.brief, /^> Meeting: Обговорення прогресу розробки та стратегії SMM \(26 жовтня 2026 р\. о 22:25\)$/m);
  assert.match(draft.brief, /^> Owner: Рома$/m);
  assert.match(draft.brief, /^> Deadline: не вказано$/m);
  assert.match(draft.brief, /^> Priority: Середній$/m);
  assert.match(draft.brief, /^> - Дашборд буде розроблятися як окремий проєкт/m);
  // Every line of the meeting's words is quoted.
  const quoted = draft.brief.split("\n").filter((line) => /Рома|Дашборд буде|Обговорення|Розробка дашборду|Підготувати/.test(line));
  assert.equal(quoted.length, 5);
  assert.ok(quoted.every((line) => line.startsWith("> ")));
  assert.deepEqual(toDraft(meeting, meeting.topics[2]!, meeting.topics[2]!.items[1]!).links, ["https://github.com/postiz/postiz"]);
});

// ---------------------------------------------------------------- import

const inbox = (s: Awaited<ReturnType<typeof setup>>) =>
  [...s.sync().plan.entities.values()].map((e) => e.entity).filter((e): e is Task => e.type === "task" && e.status === "inbox");

test("a pasted export previews its items; importing makes drafts, and a second paste offers none of them again", async () => {
  const s = await setup();
  try {
    const preview = await previewMeeting(s.ctx, { text: EXPORT });
    assert.equal(preview.error, "");
    assert.deepEqual([preview.source, preview.url, preview.topics.length], ["paste", "", 6]);
    const items = preview.topics.flatMap((t) => t.items);
    assert.equal(items.length, 12);
    assert.ok(items.every((i) => !i.imported));
    assert.deepEqual(preview.topics[0]!.items[0], { text: "Підготувати візуальну частину дашборду.", owner: "Рома", deadline: "не вказано", priority: "Середній", imported: false });

    const chosen = items.slice(0, 3).map((i) => i.text);
    const first = await importItems(s.ctx, { text: EXPORT, items: chosen });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.created.map((c) => c.title), chosen);
    const drafts = inbox(s);
    assert.equal(drafts.length, 3);
    const draft = drafts.find((d) => d.title === chosen[2])!;
    assert.deepEqual(
      [draft.priority, draft.project, draft.assignee, draft.meeting, draft.meeting_title],
      ["high", undefined, undefined, undefined, "Обговорення прогресу розробки та стратегії SMM (26 жовтня 2026 р. о 22:25)"],
    );
    const file = await s.remoteFile(new RegExp(`${draft.id}-`));
    assert.match(file ?? "", /## Brief\n\nAn action item from a Laconote meeting/);
    assert.match(file ?? "", /^> Priority: Високий$/m);

    const again = await previewMeeting(s.ctx, { text: EXPORT });
    assert.deepEqual(again.topics.flatMap((t) => t.items).map((i) => i.imported), [true, true, true, ...Array(9).fill(false)]);
    const repeat = await importItems(s.ctx, { text: EXPORT, items: chosen });
    assert.deepEqual([repeat.ok, repeat.created, repeat.skipped], [true, [], chosen]);
    const rest = await importItems(s.ctx, { text: EXPORT, items: items.map((i) => i.text) });
    assert.deepEqual([rest.created.length, rest.skipped.length], [9, 3]);
    assert.equal(inbox(s).length, 12);
    assert.ok((await previewMeeting(s.ctx, { text: EXPORT })).topics.flatMap((t) => t.items).every((i) => i.imported));

    assert.match((await importItems(s.ctx, { text: EXPORT, items: ["Something else"] })).error, /none of the chosen action items/);
    assert.match((await previewMeeting(s.ctx, { text: "just some text" })).error, /does not look like a Laconote Markdown export/);
    assert.match((await previewMeeting(s.ctx, {})).error, /choose a meeting or paste an export/);
  } finally {
    s.stop();
  }
});

test("two items whose cut titles are the same are both recorded as imported", async () => {
  const s = await setup();
  try {
    const stem = "z".repeat(210);
    const text = `# Long\n\n**Date:** today\n\n### 1. T\n\n**Action Items:**\n\n- [ ] ${stem} one\n- [ ] ${stem} two\n`;
    const result = await importItems(s.ctx, { text, items: [`${stem} one`, `${stem} two`] });
    assert.deepEqual([result.ok, result.created.length, result.skipped.length], [true, 1, 1]);
    assert.deepEqual((await previewMeeting(s.ctx, { text })).topics[0]!.items.map((i) => i.imported), [true, true]);
  } finally {
    s.stop();
  }
});

test("with a key, meetings list and import with the meeting's web link; a refused key writes nothing", async () => {
  const s = await setup();
  try {
    const api = laconoteApi();
    const ctx = { ...s.ctx, fetch: api.fetch };
    assert.match((await laconoteMeetings(ctx, { limit: 20 })).error, /no Laconote API key is set/);
    const set = configureLaconote(ctx, { api_url: "https://meet.example.com/", web_url: "https://app.example.com", key: KEY, clear_key: false });
    assert.deepEqual(set, { ok: true, api_url: "https://meet.example.com", web_url: "https://app.example.com", key_set: true, error: "" });

    const list = await laconoteMeetings(ctx, { limit: 20 });
    assert.deepEqual(list, { meetings: [{ id: "m-26a", title: "Dashboard sync", date: "2026-10-26 22:25", has_summary: true }], error: "" });
    const preview = await previewMeeting(ctx, { meeting: "m-26a" });
    assert.deepEqual([preview.source, preview.url, preview.title], ["api", "https://app.example.com/meeting/m-26a", "Dashboard sync"]);
    assert.deepEqual(preview.topics[0]!.items.map((i) => [i.text, i.priority]), [["Parse the export", "critical"], ["Show the preview", "medium"]]);

    const done = await importItems(ctx, { meeting: "m-26a", items: ["Parse the export"] });
    assert.equal(done.ok, true, done.error);
    const draft = inbox(s).find((d) => d.title === "Parse the export")!;
    assert.deepEqual(
      [draft.meeting, draft.meeting_title, draft.priority, draft.links],
      ["https://app.example.com/meeting/m-26a", "Dashboard sync", "urgent", ["https://example.com/spec"]],
    );
    assert.deepEqual((await previewMeeting(ctx, { meeting: "m-26a" })).topics[0]!.items.map((i) => i.imported), [true, false]);

    // A refused key, an unreachable API: the error shows, nothing is written.
    const before = inbox(s).length;
    const importsFile = join(s.dashboard.dataDir, "imports.json");
    const importsBefore = readFileSync(importsFile, "utf8");
    const refused = fakeFetch(() => ({ status: 401, body: JSON.stringify({ error: "invalid API key" }) }));
    const bad = { ...s.ctx, fetch: refused.fetch };
    assert.equal((await previewMeeting(bad, { meeting: "m-26a" })).error, "Laconote answered 401: invalid API key");
    assert.equal((await laconoteMeetings(bad, { limit: 5 })).error, "Laconote answered 401: invalid API key");
    const failed = await importItems(bad, { meeting: "m-26a", items: ["Show the preview"] });
    assert.deepEqual([failed.ok, failed.created, failed.error], [false, [], "Laconote answered 401: invalid API key"]);
    const down = { ...s.ctx, fetch: fakeFetch(() => new Error("getaddrinfo ENOTFOUND meet.example.com")).fetch };
    assert.match((await importItems(down, { meeting: "m-26a", items: ["Show the preview"] })).error, /could not reach Laconote at https:\/\/meet\.example\.com: getaddrinfo ENOTFOUND/);
    assert.equal(inbox(s).length, before);
    assert.equal(readFileSync(importsFile, "utf8"), importsBefore);
    assert.match((await previewMeeting(ctx, { meeting: "../etc" })).error, /not a Laconote meeting id/);
  } finally {
    s.stop();
  }
});

test("settings: URLs are checked, the key is set and cleared but never answered", async () => {
  const s = await setup();
  try {
    assert.deepEqual(laconoteSettings(s.ctx), { api_url: "https://meet.laconote.com", web_url: "https://laconote.com", key_set: false, error: "" });
    assert.match(configureLaconote(s.ctx, { api_url: "ftp://x", clear_key: false }).error, /API URL: only http and https/);
    assert.match(configureLaconote(s.ctx, { web_url: "https://u:p@x.test", clear_key: false }).error, /Web URL: no user name/);
    assert.match(configureLaconote(s.ctx, { api_url: "http://meet.example.com", clear_key: false }).error, /API URL: https only/);
    assert.equal(configureLaconote(s.ctx, { api_url: "http://localhost:8080/", clear_key: false }).api_url, "http://localhost:8080");
    assert.equal(configureLaconote(s.ctx, { web_url: "http://intranet.example", clear_key: false }).web_url, "http://intranet.example");
    assert.equal(configureLaconote(s.ctx, { web_url: "", clear_key: false }).web_url, "https://laconote.com");
    const short = configureLaconote(s.ctx, { key: "lac short key", clear_key: false });
    assert.match(short.error, /8 or more printable characters/);
    assert.ok(!short.error.includes("short"));
    assert.match(configureLaconote(s.ctx, { key: KEY, clear_key: true }).error, /not both/);
    assert.equal(configureLaconote(s.ctx, { key: `  ${KEY}\n`, clear_key: false }).key_set, true);
    const secrets = join(s.dashboard.dataDir, "secrets.json");
    assert.equal(statSync(secrets).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(secrets, "utf8")).laconote_key, KEY);
    // Another server without a new key drops the key; with one, keeps the new key.
    const moved = configureLaconote(s.ctx, { api_url: "", clear_key: false });
    assert.deepEqual([moved.api_url, moved.key_set], ["https://meet.laconote.com", false]);
    assert.equal(configureLaconote(s.ctx, { api_url: "https://meet.example.com", key: KEY, clear_key: false }).key_set, true);
    assert.equal(configureLaconote(s.ctx, { api_url: "https://meet.example.com/v2", clear_key: false }).key_set, true);
    assert.equal(configureLaconote(s.ctx, { api_url: "", key: KEY, clear_key: false }).key_set, true);
    writeFileSync(`${secrets}.broken-1`, KEY);
    assert.deepEqual(configureLaconote(s.ctx, { clear_key: true }), { ok: true, api_url: "https://meet.laconote.com", web_url: "https://laconote.com", key_set: false, error: "" });
    assert.equal(existsSync(secrets), false);
    assert.equal(existsSync(`${secrets}.broken-1`), false);
  } finally {
    s.stop();
  }
});

test("a failed URL write leaves no key stored next to a server it was not given for", async () => {
  const s = await setup();
  try {
    assert.equal(configureLaconote(s.ctx, { key: KEY, clear_key: false }).key_set, true);
    // A directory where laconote.json goes makes its rename fail.
    const settingsFile = join(s.dashboard.dataDir, "laconote.json");
    mkdirSync(join(settingsFile, "blocker"), { recursive: true });
    const failed = configureLaconote(s.ctx, { api_url: "https://other.example", clear_key: false });
    assert.match(failed.error, /could not save/);
    assert.deepEqual([failed.api_url, failed.key_set], ["https://meet.laconote.com", false]);
    rmSync(settingsFile, { recursive: true });
    // The retry still sees a move to another server; the key given with it is stored with that server.
    const retried = configureLaconote(s.ctx, { api_url: "https://other.example", key: `${KEY}-other`, clear_key: false });
    assert.deepEqual([retried.ok, retried.api_url, retried.key_set], [true, "https://other.example", true]);
    const fresh = new LaconoteStore(s.dashboard.dataDir);
    assert.deepEqual([fresh.apiUrl, fresh.key()], ["https://other.example", `${KEY}-other`]);
    // A key file this process does not know of is cleared by a move all the same.
    configureLaconote(s.ctx, { clear_key: true });
    assert.equal(laconoteSettings(s.ctx).key_set, false);
    writeFileSync(join(s.dashboard.dataDir, "secrets.json"), JSON.stringify({ version: 1, laconote_key: KEY }));
    configureLaconote(s.ctx, { api_url: "https://third.example", clear_key: false });
    assert.equal(new LaconoteStore(s.dashboard.dataDir).key(), undefined);
    // Unreadable URLs fall back to the defaults, and the key given for the server they named goes.
    writeFileSync(join(s.dashboard.dataDir, "secrets.json"), JSON.stringify({ version: 1, laconote_key: KEY }));
    writeFileSync(settingsFile, "{broken");
    const reloaded = new LaconoteStore(s.dashboard.dataDir);
    assert.deepEqual([reloaded.apiUrl, reloaded.hasKey, reloaded.movedAside.length], ["https://meet.laconote.com", false, 1]);
    assert.equal(existsSync(join(s.dashboard.dataDir, "secrets.json")), false);
    // The failed write left no temp file behind.
    assert.deepEqual(readdirSync(s.dashboard.dataDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    s.stop();
  }
});

/** Every file under a directory, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, text: readFileSync(path, "latin1") + readFileSync(path, "utf8") };
    });
}

test("the key is in no RPC answer, no log line, no plan file; only in secrets.json", async () => {
  const lines: string[] = [];
  const original = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const name of ["error", "log", "warn", "info"] as const) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  const s = await setup();
  try {
    const answers: unknown[] = [];
    // A server that echoes the key in its error text.
    const echo = fakeFetch((url) => {
      if (url.includes("/broken")) return { status: 401, body: JSON.stringify({ error: `bad key ${KEY}` }) };
      return { status: 200, body: url.includes("?") ? JSON.stringify({ meetings: [{ meeting_id: "m-26a", meeting_name: "Dashboard sync" }] }) : JSON.stringify(DETAIL) };
    });
    const ctx = { ...s.ctx, fetch: echo.fetch };
    answers.push(configureLaconote(ctx, { key: KEY, clear_key: false }));
    answers.push(laconoteSettings(ctx));
    answers.push(await laconoteMeetings(ctx, { limit: 5 }));
    answers.push(await previewMeeting(ctx, { meeting: "m-26a" }));
    answers.push(await previewMeeting(ctx, { meeting: "broken" }));
    answers.push(await importItems(ctx, { meeting: "m-26a", items: ["Parse the export", "Show the preview"] }));
    answers.push(await importItems(ctx, { text: EXPORT, items: ["Підготувати візуальну частину дашборду."] }));
    answers.push(configureLaconote(ctx, { key: `${KEY} with a space`, clear_key: false }));
    await s.sync().sync();
    for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(KEY), JSON.stringify(answer));
    assert.ok(JSON.stringify(answers).includes("[key]"), "the echoed key was cut out");
    for (const line of lines) assert.ok(!line.includes(KEY), line);
    const holding = filesUnder(s.dashboard.dataDir).filter((f) => f.text.includes(KEY)).map((f) => f.path);
    assert.deepEqual(holding, [join(s.dashboard.dataDir, "secrets.json")]);
    assert.ok(!sh(s.f.remote, "log", "-p", "--all").includes(KEY));
    assert.equal(inbox(s).length, 3);
  } finally {
    s.stop();
    Object.assign(console, original);
  }
});

test("an action item's owner becomes the draft's assignee when a person of the space has that name", async () => {
  const s = await setup();
  try {
    s.f.external("ergo", (root) => {
      const path = join(root, "space.yaml");
      writeFileSync(path, `${readFileSync(path, "utf8")}people:\n  roma: { name: рома, emails: [roma@example.com] }\n`);
    });
    await s.sync().sync();
    const items = (await previewMeeting(s.ctx, { text: EXPORT })).topics.flatMap((t) => t.items);
    const roma = items.find((i) => i.owner === "Рома")!;
    const other = items.find((i) => i.owner && i.owner !== "Рома")!;
    const result = await importItems(s.ctx, { text: EXPORT, items: [roma.text, other.text] });
    assert.equal(result.ok, true, result.error);
    const byTitle = new Map(inbox(s).map((d) => [d.title, d.assignee]));
    assert.equal(byTitle.get(roma.text), "roma", "matched by name, ignoring case");
    assert.equal(byTitle.get(other.text), undefined, "an owner no person has stays only in the brief");
  } finally {
    s.stop();
  }
});
