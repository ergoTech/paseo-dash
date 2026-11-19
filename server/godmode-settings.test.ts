import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dashboard } from "./dashboard.ts";
import { GODMODE_FILE, readGodModeSettings, startWithoutAsking, writeGodModeSettings } from "./godmode-settings.ts";

test("starting without asking is off until turned on, and stays as set after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-godmode-"));
  const first = new Dashboard({ dataDir: dir });
  await first.start();
  try {
    assert.deepEqual(readGodModeSettings(first), { start_without_asking: false, error: "" });
    assert.deepEqual(writeGodModeSettings(first, { start_without_asking: true }), { start_without_asking: true, ok: true, error: "" });
  } finally {
    await first.stop();
  }
  // A new daemon process: nothing is kept in memory, the file decides.
  assert.equal(startWithoutAsking(dir), true);
  const second = new Dashboard({ dataDir: dir });
  await second.start();
  try {
    assert.deepEqual(readGodModeSettings(second), { start_without_asking: true, error: "" });
    assert.equal(writeGodModeSettings(second, { start_without_asking: false }).ok, true);
    assert.equal(startWithoutAsking(dir), false);
  } finally {
    await second.stop();
  }
});

test("an unreadable godmode.json reads as off and is moved aside by the owner; another installation cannot write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-godmode-"));
  writeFileSync(join(dir, GODMODE_FILE), "{ not json");
  assert.equal(startWithoutAsking(dir), false);
  writeFileSync(join(dir, GODMODE_FILE), JSON.stringify({ version: 1, start_without_asking: "yes" }));
  assert.equal(startWithoutAsking(dir), false, "only a valid file turns it on");
  const dashboard = new Dashboard({ dataDir: dir });
  await dashboard.start();
  try {
    assert.ok(dashboard.warnings.some((w) => /ChatGPT settings could not be read/.test(w)));
    assert.equal(existsSync(join(dir, GODMODE_FILE)), false, "moved aside");
    const stranger = { dataDir: dir, owner: false, ownerReason: "another installation owns the data" };
    assert.deepEqual(readGodModeSettings(stranger), { start_without_asking: false, error: "another installation owns the data" });
    const refused = writeGodModeSettings(stranger, { start_without_asking: true });
    assert.equal(refused.ok, false);
    assert.equal(startWithoutAsking(dir), false);
  } finally {
    await dashboard.stop();
  }
});
