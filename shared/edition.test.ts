import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/edition.mjs");

test("Paseo's install from git writes the release edition last; npm install in a working copy writes dev", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")) as { name: string; build: string[][] };
  assert.equal(manifest.name, "Paseo Dash");
  assert.deepEqual(manifest.build.at(-1), ["node", "scripts/edition.mjs", "release"]);
  assert.ok(manifest.build[0]!.includes("--ignore-scripts"), "npm ci in the install does not run postinstall, so it cannot write dev");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] };
  assert.equal(pkg.scripts.postinstall, "node scripts/edition.mjs dev");
  assert.ok(pkg.files.includes("scripts/edition.mjs"), "a published package carries the script its build runs");
});

test("the edition script writes a module naming its edition, and refuses anything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-edition-"));
  for (const edition of ["release", "dev"]) {
    const file = join(dir, `${edition}.ts`);
    execFileSync(process.execPath, [SCRIPT, edition, file]);
    const loaded = (await import(pathToFileURL(file).href)) as { EDITION: string };
    assert.equal(loaded.EDITION, edition);
  }
  const refused = spawnSync(process.execPath, [SCRIPT, "beta", join(dir, "beta.ts")], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /usage/);
});
