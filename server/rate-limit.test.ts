import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, isRateLimit, readUsage, resetFrom } from "./rate-limit.ts";
import type { PaseoApi } from "./paseo.ts";

const NOW = new Date("2026-11-15T10:20:00.000Z");

test("a usage or rate limit is told from other failures", () => {
  for (const text of ["Claude AI usage limit reached|1763215200", "5-hour limit reached ∙ resets 3pm", "You've hit your limit · resets 7pm (Europe/Kyiv)", "API Error: 429 Too Many Requests", "rate_limit_error", "rate limited"]) {
    assert.equal(isRateLimit(text), true, text);
  }
  for (const text of ["Context limit reached", "API Error: 529 Overloaded", "the agent stopped with an error", undefined]) {
    assert.equal(isRateLimit(text), false, String(text));
  }
});

test("the reset an error names: a Unix time, or a clock time in its zone, read as its next occurrence", () => {
  assert.equal(resetFrom("Claude AI usage limit reached|1763215200", new Date("2025-11-15T10:00:00Z"))?.toISOString(), "2025-11-15T14:00:00.000Z");
  // 10:20 UTC is 12:20 in Kyiv: 7pm there is 17:00 UTC the same day.
  assert.equal(resetFrom("You've hit your limit · resets 7pm (Europe/Kyiv)", NOW)?.toISOString(), "2026-11-15T17:00:00.000Z");
  // 11:30am Kyiv has passed: the next one is tomorrow.
  assert.equal(resetFrom("resets 11:30am (Europe/Kyiv)", NOW)?.toISOString(), "2026-11-16T09:30:00.000Z");
  assert.equal(resetFrom("resets 3pm (UTC)", NOW)?.toISOString(), "2026-11-15T15:00:00.000Z");
  assert.equal(resetFrom("resets 7pm (Mars/Olympus)", NOW), undefined, "a zone that is none");
  assert.equal(resetFrom("usage limit reached|1000000000", NOW), undefined, "a reset in the past");
  assert.equal(resetFrom("rate limited", NOW), undefined);
});

test("the backoff grows with each hold in a row, up to its last step", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000), [15, 30, 60, 120, 240, 240]);
});

test("Paseo's usage report: a window used up gives its reset; off, missing or slow says so", async () => {
  const paseo = (listUsage: (() => Promise<unknown>) | undefined) => ({ providers: { listUsage } }) as unknown as PaseoApi;
  const report = (providers: unknown[]) => paseo(async () => ({ providers }));
  assert.deepEqual(
    await readUsage(report([{ providerId: "claude", status: "available", windows: [{ label: "5-hour", usedPct: 100, resetsAt: "2026-11-15T12:00:00Z" }, { label: "weekly", usedPct: 40, resetsAt: "2026-11-20T00:00:00Z" }] }]), "claude", NOW),
    { resetsAt: new Date("2026-11-15T12:00:00Z"), window: "5-hour" },
  );
  assert.deepEqual(await readUsage(report([{ providerId: "claude", status: "available", windows: [{ label: "5-hour", usedPct: 12 }] }]), "claude", NOW), { clear: true });
  assert.deepEqual(await readUsage(report([{ providerId: "codex", status: "available", windows: [] }]), "claude", NOW), { unavailable: "the usage report has no claude" });
  assert.deepEqual(await readUsage(report([{ providerId: "claude", status: "unavailable", error: "token expired", windows: [] }]), "claude", NOW), { unavailable: "token expired" });
  assert.deepEqual(
    await readUsage(paseo(async () => Promise.reject(new Error("Usage is off on this host."))), "claude", NOW),
    { unavailable: "Usage is off on this host." },
  );
  assert.deepEqual(await readUsage(paseo(undefined), "claude", NOW), { unavailable: "this Paseo has no usage report" });
});
