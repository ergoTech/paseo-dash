import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityReader, buildActivity, PAST_LIMIT } from "./activity.ts";
import type { PaseoApi } from "./paseo.ts";

const ws = (id: string, projectId: string, status: string, since: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId,
  name: `ws ${id}`,
  status,
  statusEnteredAt: since,
  gitRuntime: { currentBranch: `b-${id}` },
  ...extra,
});

const archived = (id: string, workspaceId: string, projectKey: string, at: string, labels: Record<string, string> = {}) => ({
  agent: { id, title: `agent ${id}`, workspaceId, archivedAt: at, labels },
  project: { projectKey, workspaceName: `past ${workspaceId}`, checkout: { currentBranch: `p-${workspaceId}` } },
});

test("open workspaces by project: waiting and failed first, then working, then idle; dashboard runs left out", () => {
  const snapshot = buildActivity(
    [
      ws("w1", "prj_site", "done", "2026-10-26T10:00:00Z"),
      ws("w2", "prj_site", "running", "2026-10-26T09:00:00Z"),
      ws("w3", "prj_site", "needs_input", "2026-10-26T08:00:00Z"),
      ws("w4", "prj_site", "done", "2026-10-26T11:00:00Z", { githubRuntime: { pullRequest: { url: "https://x/pr/1", state: "OPEN", isMerged: false } } }),
      ws("w5", "prj_site", "running", "2026-10-26T12:00:00Z"),
      ws("w6", "prj_core", "attention", "2026-10-26T07:00:00Z"),
      ws("w7", "prj_site", "running", "2026-10-26T13:00:00Z", { archivingAt: "2026-10-26T13:01:00Z" }),
    ],
    [{ agent: { id: "a5", title: "run", workspaceId: "w5", labels: { dashboard: "1" } }, project: { projectKey: "prj_site" } }],
    new Set(["w2"]),
    "2026-10-26T14:00:00Z",
  );
  const site = snapshot.byProject.get("prj_site")!;
  assert.deepEqual(site.active.map((w) => w.workspace_id), ["w3", "w4", "w1"], "w2 runs a task here, w5's agent is the dashboard's, w7 is being archived");
  assert.deepEqual([site.active[1]!.pr_url, site.active[1]!.pr_state, site.active[1]!.branch], ["https://x/pr/1", "open", "b-w4"]);
  assert.equal(snapshot.byProject.get("prj_core")!.active[0]!.status, "attention");
});

test("the past is archived workspaces, newest first, once per workspace, without dashboard runs or open ones", () => {
  const agents = [
    archived("a1", "w10", "prj_site", "2026-10-20T10:00:00Z"),
    archived("a2", "w10", "prj_site", "2026-10-21T10:00:00Z"),
    archived("a3", "w11", "prj_site", "2026-10-25T10:00:00Z"),
    archived("a4", "w12", "prj_site", "2026-10-24T10:00:00Z", { dashboard: "1" }),
    archived("a5", "w1", "prj_site", "2026-10-23T10:00:00Z"),
  ];
  const snapshot = buildActivity([ws("w1", "prj_site", "done", "2026-10-26T10:00:00Z")], agents, new Set(), "t");
  const past = snapshot.byProject.get("prj_site")!.past;
  assert.deepEqual(past.map((p) => [p.workspace_id, p.archived_at]), [
    ["w11", "2026-10-25T10:00:00Z"],
    ["w10", "2026-10-21T10:00:00Z"],
  ]);
  assert.deepEqual([past[0]!.title, past[0]!.branch], ["past w11", "p-w11"]);
  const many = Array.from({ length: PAST_LIMIT + 5 }, (_, i) => archived(`m${i}`, `wm${i}`, "prj_x", `2026-10-${String(1 + (i % 25)).padStart(2, "0")}T00:00:00Z`));
  assert.equal(buildActivity([], many, new Set(), "t").byProject.get("prj_x")!.past.length, PAST_LIMIT);
});

test("the reader asks Paseo at most every few seconds, pages through, and keeps the last answer on failure", async () => {
  let now = 1_000_000;
  let calls = 0;
  let fail = false;
  const paseo = {
    workspaces: {
      list: async ({ page }: { page: { cursor?: string } }) => {
        calls += 1;
        if (fail) throw new Error("socket closed");
        return page.cursor
          ? { entries: [ws("w2", "prj_site", "done", "2026-10-26T09:00:00Z")], pageInfo: { hasMore: false, nextCursor: null } }
          : { entries: [ws("w1", "prj_site", "running", "2026-10-26T10:00:00Z")], pageInfo: { hasMore: true, nextCursor: "c2" } };
      },
    },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const reader = new ActivityReader(() => paseo, () => new Set(), () => now);
  // Three readers at once share one read of two pages.
  const [first, second] = await Promise.all([reader.read(), reader.read(), Promise.resolve(reader.peek())]);
  assert.equal(calls, 2, "one read: two pages");
  assert.equal(second, first);
  assert.deepEqual(first.byProject.get("prj_site")!.active.map((w) => w.workspace_id), ["w1", "w2"], "both pages");
  await reader.read();
  reader.peek();
  assert.equal(calls, 2, "fresh: not asked again");
  now += 11_000;
  fail = true;
  await assert.rejects(reader.read(), /socket closed/);
  const afterFailure = calls;
  assert.equal(reader.peek(), first, "the last answer stays");
  await assert.rejects(reader.read(), /socket closed/, "within FRESH_MS the failure is answered without asking again");
  assert.equal(calls, afterFailure, "a failed read counts as a read: no retry loop");
  assert.equal(reader.last(), first);
  assert.match(reader.lastError, /socket closed/);
});

test("before any answer a failure is not retried on every call either", async () => {
  let calls = 0;
  const now = 5_000_000;
  const paseo = { workspaces: { list: async () => { calls += 1; throw new Error("down"); } }, agents: { list: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  const reader = new ActivityReader(() => paseo, () => new Set(), () => now);
  await assert.rejects(reader.read(), /down/);
  await assert.rejects(reader.read(), /down/);
  reader.peek();
  assert.equal(calls, 1);
  assert.equal(reader.last(), undefined);
});
