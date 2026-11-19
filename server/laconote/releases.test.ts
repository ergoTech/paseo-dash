import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createMilestone, createTask, updateMilestone, updateTask } from "../api/writes.ts";
import { setup } from "../api/testing.ts";
import type { FetchLike } from "./client.ts";
import { configureLaconote } from "./importer.ts";
import { laconoteProjects, readReleases, setRelease } from "./releases-rpc.ts";
import { dueDate, releaseBody, releaseName, releaseSets, RELEASE_SOURCE } from "./releases.ts";

const KEY = "lac_test_release_1234567890";
const LAC = "507f1f77bcf86cd799439011";
const SITE = "507f1f77bcf86cd799439012";

interface Call {
  method: string;
  url: string;
  auth: string;
  body: unknown;
}

/** A fake Laconote: answers each request with what `answer` gives, and records it. */
function fakeLaconote(answer: (call: Call) => { status: number; body: string } | Error = () => ({ status: 200, body: "{}" })) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { method: init.method, url, auth: init.headers.Authorization ?? "", body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
  };
  return { fetch, calls };
}

/** The TST space (api/testing.ts) with a Laconote key set, and the pusher talking to a fake. */
async function withLaconote(answer?: Parameters<typeof fakeLaconote>[0]) {
  const laconote = fakeLaconote(answer);
  let now = new Date("2026-10-27T10:00:00Z");
  const t = await setup(undefined, { releases: { fetch: laconote.fetch, now: () => now, everyMs: 3_600_000 } });
  t.dashboard.laconote!.setKey(KEY);
  const ctx = { ...t.ctx, fetch: laconote.fetch };
  const later = (ms: number) => (now = new Date(now.getTime() + ms));
  const puts = () => laconote.calls.filter((c) => c.method === "PUT");
  return { ...t, ctx, laconote, later, puts };
}

test("a due date is sent as YYYY-MM-DD, and only a real calendar date", () => {
  assert.equal(dueDate("2026-11-30"), "2026-11-30");
  assert.equal(dueDate("2026-11-30T00:00:00.000Z"), "2026-11-30");
  assert.equal(dueDate("2026-02-30"), undefined);
  assert.equal(dueDate("next sprint"), undefined);
  assert.equal(dueDate(undefined), undefined);
});

test("a release name is one line without control characters, cut to 200", () => {
  assert.equal(releaseName("  Release\n2.4\u0007 "), "Release 2.4");
  const long = releaseName("x".repeat(300));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(releaseName("Release\u200b 2.4\u202e"), "Release 2.4");
  // The cut counts code points: no half of a surrogate pair is left.
  const emoji = releaseName(`${"x".repeat(198)}🚀🚀🚀`);
  assert.equal([...emoji].length, 200);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
});

test("a project's set holds the open milestones its tasks or features work towards, earliest due first", async () => {
  const t = await setup();
  try {
    // TST-MS001 "Release 2.3" (due 2026-11-30, active) holds feature TST-FEAT1, whose task TST-FX001 is in core.
    const later = await createMilestone(t.ctx, { space: "TST", title: "Release 2.4", due: "2026-12-20" });
    const earlier = await createMilestone(t.ctx, { space: "TST", title: "Hotfix", due: "2026-11-05", status: "active" });
    const undated = await createMilestone(t.ctx, { space: "TST", title: "Someday", status: "planned" });
    const elsewhere = await createMilestone(t.ctx, { space: "TST", title: "Site only", due: "2026-11-10" });
    for (const [title, milestone, project, status] of [
      ["Later work", later.id, "core", "todo"],
      ["Hotfix work", earlier.id, "core", "todo"],
      ["Someday work", undated.id, "core", "todo"],
      ["Site work", elsewhere.id, "site", "todo"],
      ["A draft", later.id, "core", "inbox"],
    ] as const) {
      const made = await createTask(t.ctx, { space: "TST", title, milestone, project, status });
      assert.equal(made.ok, true, made.error);
    }
    const sets = releaseSets(t.sync().plan, { core: LAC, site: SITE, nowhere: "x" });
    assert.deepEqual([...sets.keys()].sort(), [LAC, SITE]);
    const core = sets.get(LAC)!;
    assert.deepEqual(core.projects, ["core"]);
    assert.deepEqual(
      core.releases.map((r) => [r.name, r.due]),
      [
        ["Hotfix", "2026-11-05"],
        ["Release 2.3", "2026-11-30"],
        ["Release 2.4", "2026-12-20"],
      ],
    );
    assert.deepEqual(core.undated, [{ id: undated.id, title: "Someday" }]);
    // The draft is not accepted work: Release 2.4's one counted task is todo.
    assert.equal(core.releases.find((r) => r.name === "Release 2.4")!.progress, 0);
    assert.deepEqual(sets.get(SITE)!.releases.map((r) => r.name), ["Site only"]);
  } finally {
    t.stop();
  }
});

test("progress counts the milestone's accepted tasks; done and canceled milestones are left out", async () => {
  const t = await setup();
  try {
    const m = await createMilestone(t.ctx, { space: "TST", title: "Release 3", due: "2026-12-01" });
    const ids: string[] = [];
    for (const title of ["one", "two", "three", "four"]) {
      const made = await createTask(t.ctx, { space: "TST", title, milestone: m.id, project: "core" });
      ids.push(made.id);
    }
    assert.equal((await updateTask(t.ctx, { task: ids[0]!, status: "done" })).ok, true);
    assert.equal((await updateTask(t.ctx, { task: ids[1]!, status: "canceled" })).ok, true);
    let sets = releaseSets(t.sync().plan, { core: LAC });
    assert.equal(sets.get(LAC)!.releases.find((r) => r.id === m.id)!.progress, 33);
    assert.equal((await updateMilestone(t.ctx, { milestone: m.id, status: "done" })).ok, true);
    sets = releaseSets(t.sync().plan, { core: LAC });
    assert.equal(sets.get(LAC)!.releases.some((r) => r.id === m.id), false);
  } finally {
    t.stop();
  }
});

test("the body follows Laconote's PUT contract: sender_id, source, releases with external_id and due_date", () => {
  const body = releaseBody("sender-1", {
    projects: ["core"],
    releases: [
      { id: "TST-AAAAA", name: "2.4", due: "2026-11-15", progress: 62 },
      { id: "TST-BBBBB", name: "2.5", due: "2026-12-20", progress: undefined },
    ],
    undated: [],
  });
  assert.deepEqual(body, {
    sender_id: "sender-1",
    source: RELEASE_SOURCE,
    releases: [
      { external_id: "TST-AAAAA", name: "2.4", due_date: "2026-11-15", progress: 62 },
      { external_id: "TST-BBBBB", name: "2.5", due_date: "2026-12-20" },
    ],
  });
});

test("a mapped project's set is PUT with the key once, again only when it changes or the heartbeat is due", async () => {
  const t = await withLaconote();
  try {
    assert.deepEqual(setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC }), { ok: true, error: "" });
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 1);
    const put = t.puts()[0]!;
    assert.equal(put.url, `https://meet.laconote.com/api/v1/projects/${LAC}/release-context`);
    assert.equal(put.auth, `Bearer ${KEY}`);
    const body = put.body as { sender_id: string; source: string; releases: { external_id: string; name: string; due_date: string }[] };
    assert.equal(body.source, "paseo-dashboard");
    assert.equal(body.sender_id, t.dashboard.releaseStore!.senderId);
    assert.deepEqual(body.releases.map((r) => [r.external_id, r.name, r.due_date]), [["TST-MS001", "Release 2.3", "2026-11-30"]]);

    // Unchanged: nothing until the heartbeat.
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 1);
    t.later(61 * 60_000);
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 2);

    // A milestone that reaches origin changes the set: sent at once.
    const added = await createMilestone(t.ctx, { space: "TST", title: "Release 2.4", due: "2026-12-20" });
    await createTask(t.ctx, { space: "TST", title: "Later work", milestone: added.id, project: "core" });
    await t.sync().sync();
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 3);
    assert.equal((t.puts()[2]!.body as { releases: unknown[] }).releases.length, 2);

    const read = readReleases(t.ctx, { space: "TST" });
    assert.equal(read.key_set, true);
    assert.deepEqual(read.mapping, [
      { project: "core", laconote: LAC },
      { project: "site", laconote: "" },
    ]);
    assert.equal(read.sets.length, 1);
    assert.equal(read.sets[0]!.waiting, false);
    assert.equal(read.sets[0]!.error, "");
    assert.ok(read.sets[0]!.sent_at);
    // The mapping file holds no key and is the owner's only.
    const file = readFileSync(join(t.dashboard.dataDir, "release-context.json"), "utf8");
    assert.ok(!file.includes(KEY));
    assert.equal(statSync(join(t.dashboard.dataDir, "release-context.json")).mode & 0o777, 0o600);
  } finally {
    t.stop();
  }
});

test("nothing is sent without a key or a mapping", async () => {
  const t = await withLaconote();
  try {
    await t.dashboard.releases.pass();
    assert.equal(t.laconote.calls.length, 0);
    t.dashboard.laconote!.clearKey();
    setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC });
    await t.dashboard.releases.pass();
    assert.equal(t.laconote.calls.length, 0);
    assert.equal(readReleases(t.ctx, { space: "TST" }).key_set, false);
  } finally {
    t.stop();
  }
});

test("a 409 from Laconote is shown and waits, never answered with a DELETE; success clears it", async () => {
  let status = 409;
  const t = await withLaconote(() => (status === 200 ? { status: 200, body: "{}" } : { status, body: JSON.stringify({ error: "RELEASE_CONTEXT_OWNED_BY_OTHER" }) }));
  try {
    setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC });
    await t.dashboard.releases.pass();
    let read = readReleases(t.ctx, { space: "TST" });
    assert.match(read.sets[0]!.error, /Another installation sends this project's releases/);
    assert.equal(read.sets[0]!.waiting, true);
    // Waits a minute before trying again.
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 1);
    status = 200;
    t.later(61_000);
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 2);
    assert.equal(t.laconote.calls.some((c) => c.method === "DELETE"), false);
    read = readReleases(t.ctx, { space: "TST" });
    assert.equal(read.sets[0]!.error, "");
    assert.equal(read.sets[0]!.waiting, false);
  } finally {
    t.stop();
  }
});

test("a key without release:write is named in the error, and no error text carries the key", async () => {
  const t = await withLaconote(() => ({ status: 403, body: JSON.stringify({ error: "insufficient_scope", message: `key ${KEY} lacks it` }) }));
  try {
    setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC });
    await t.dashboard.releases.pass();
    const error = readReleases(t.ctx, { space: "TST" }).sets[0]!.error;
    assert.match(error, /release:write/);
    assert.ok(!error.includes(KEY));
  } finally {
    t.stop();
  }
});

test("a Laconote project takes one space; ids are checked; unmapping stops the pushes", async () => {
  const t = await withLaconote();
  try {
    assert.equal(setRelease(t.ctx, { space: "TST", project: "nope", laconote: LAC }).ok, false);
    assert.equal(setRelease(t.ctx, { space: "TST", project: "core", laconote: "../../users" }).ok, false);
    assert.equal(setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC }).ok, true);
    // Two projects of one space may feed one Laconote project: one set for both.
    assert.equal(setRelease(t.ctx, { space: "TST", project: "site", laconote: LAC }).ok, true);
    assert.equal(t.dashboard.releaseStore!.spaceOf(LAC), "TST");
    assert.deepEqual(readReleases(t.ctx, { space: "TST" }).sets.map((s) => s.projects), [["core", "site"]]);
    // Another space may not.
    t.dashboard.releaseStore!.setMapping("OTHER", "x", SITE);
    const refused = setRelease(t.ctx, { space: "TST", project: "core", laconote: SITE });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /OTHER/);
    setRelease(t.ctx, { space: "TST", project: "core", laconote: "" });
    setRelease(t.ctx, { space: "TST", project: "site", laconote: "" });
    await t.dashboard.releases.pass();
    const before = t.puts().length;
    t.later(2 * 60 * 60_000);
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, before);
    assert.equal(t.dashboard.releaseStore!.push(LAC), undefined);
  } finally {
    t.stop();
  }
});

test("laconote.projects lists the key owner's projects with their role", async () => {
  const t = await withLaconote((call) =>
    call.url.endsWith("/api/v1/projects")
      ? { status: 200, body: JSON.stringify({ success: true, projects: [{ id: LAC, name: "Laconote", role: "owner" }, { name: "no id" }] }) }
      : { status: 404, body: "{}" },
  );
  try {
    assert.deepEqual(await laconoteProjects(t.ctx), { projects: [{ id: LAC, name: "Laconote", role: "owner" }], error: "" });
    t.dashboard.laconote!.clearKey();
    assert.match((await laconoteProjects(t.ctx)).error, /no Laconote API key/);
  } finally {
    t.stop();
  }
});

test("failures wait 1, 2, 4 … minutes; a new key tries at once; another API URL resends", async () => {
  let status = 500;
  const t = await withLaconote(() => (status === 200 ? { status: 200, body: "" } : { status, body: JSON.stringify({ error: "boom" }) }));
  try {
    setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC });
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, 1);
    for (const wait of [1, 2, 4]) {
      const before = t.puts().length;
      t.later(wait * 60_000 - 1_000);
      await t.dashboard.releases.pass();
      assert.equal(t.puts().length, before, `not before ${wait} minute(s)`);
      t.later(1_000);
      await t.dashboard.releases.pass();
      assert.equal(t.puts().length, before + 1, `after ${wait} minute(s)`);
    }
    assert.match(readReleases(t.ctx, { space: "TST" }).sets[0]!.error, /Laconote answered 500/);
    // Saving another key does not wait out the 8 minutes; an empty 2xx answer is accepted.
    status = 200;
    const before = t.puts().length;
    assert.equal(configureLaconote(t.ctx, { key: `${KEY}_new`, clear_key: false }).ok, true);
    await t.dashboard.releases.pass();
    assert.equal(t.puts().length, before + 1);
    assert.equal(readReleases(t.ctx, { space: "TST" }).sets[0]!.error, "");
    // Another server never got the set: sent there at once, with the key given for it.
    assert.equal(configureLaconote(t.ctx, { api_url: "https://laconote.example.org", clear_key: false }).ok, true);
    assert.equal(configureLaconote(t.ctx, { key: KEY, clear_key: false }).ok, true);
    await t.dashboard.releases.pass();
    assert.equal(t.puts().at(-1)!.url, `https://laconote.example.org/api/v1/projects/${LAC}/release-context`);
  } finally {
    t.stop();
  }
});

test("a disconnected space frees its Laconote projects, and prototype names are no project", async () => {
  const t = await withLaconote();
  try {
    assert.equal(setRelease(t.ctx, { space: "TST", project: "toString", laconote: LAC }).ok, false);
    assert.equal(setRelease(t.ctx, { space: "TST", project: "core", laconote: "__proto__" }).ok, false);
    assert.equal(setRelease(t.ctx, { space: "TST", project: "core", laconote: LAC }).ok, true);
    await t.dashboard.releases.pass();
    assert.ok(t.dashboard.releaseStore!.push(LAC));
    await t.sync().sync();
    await t.dashboard.removeSpace("TST", "ergo-mbp");
    assert.equal(t.dashboard.releaseStore!.spaceOf(LAC), undefined);
    assert.equal(t.dashboard.releaseStore!.push(LAC), undefined);
    assert.deepEqual(t.dashboard.releaseStore!.mapping("TST"), {});
  } finally {
    t.stop();
  }
});
