import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Dashboard } from "./dashboard.ts";
import { OwnerLock } from "./lock.ts";
import { readOverview } from "./overview.ts";
import { mapProjects, normalizeRemote } from "./spaces/mapping.ts";

function emptyRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-remote-"));
  const remote = join(dir, "plan.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  return remote;
}

test("a second installation on the same data finds the lock and stays read-only", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dashboard-data-"));
  const first = new Dashboard({ dataDir });
  const second = new Dashboard({ dataDir });
  await first.start();
  await second.start();
  try {
    assert.equal(first.owner, true);
    assert.equal(second.owner, false);
    assert.match(second.ownerReason, /another copy of Paseo Dash/);
    assert.match(readOverview(second, {}).error, /another copy/);
    await assert.rejects(second.addSpace({ remote: emptyRemote(), key: "TST", name: "Test" }), /another copy/);
  } finally {
    first.stop();
    second.stop();
  }
});

test("a lock whose owner is gone, or that cannot be read, is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-lock-"));
  const path = join(dir, "owner.lock");
  const dead = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000 });
  assert.deepEqual(dead.acquire(), { owner: true });
  dead.release();
  writeFileSync(path, JSON.stringify({ pid: 4242, token: "someone-else", heartbeat: Date.now() }));
  const taker = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000, alive: () => false });
  assert.deepEqual(taker.acquire(), { owner: true });
  taker.release();
  writeFileSync(path, "{ torn");
  const again = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000 });
  assert.deepEqual(again.acquire(), { owner: true });
  again.release();
  const old = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000 });
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: "same-pid-other-token", heartbeat: Date.now() - 300_000 }));
  assert.deepEqual(old.acquire(), { owner: true }, "an old heartbeat is stale even when the pid is alive (pid reuse)");
  old.release();
});

test("a heartbeat that cannot be written is reported, never thrown, and the lock stays its owner's", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-lock-"));
  const path = join(dir, "owner.lock");
  const logged: string[] = [];
  const lock = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000, log: (message) => logged.push(message) });
  assert.deepEqual(lock.acquire(), { owner: true });
  // The heartbeat's temp file cannot be created, as on a full disk.
  chmodSync(dir, 0o500);
  try {
    assert.equal(lock.beat(), true);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(lock.isOwner, true);
  assert.match(logged.join("\n"), /heartbeat was not written/);
  assert.equal(lock.beat(), true, "the next beat writes again");
  assert.equal(logged.length, 1);
  lock.release();
});

test("an empty repository becomes a space with a key and a name, and survives a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dashboard-data-"));
  const remote = emptyRemote();
  const dashboard = new Dashboard({ dataDir });
  await assert.rejects(dashboard.addSpace({ remote }), /repository is empty: give a key/);
  assert.deepEqual(await dashboard.addSpace({ remote, key: "tst", name: "Test space" }), { key: "TST" });
  await assert.rejects(dashboard.addSpace({ remote }), /already connected/);
  const pushed = execFileSync("git", ["show", "main:space.yaml"], { cwd: remote, encoding: "utf8" });
  assert.match(pushed, /key: TST/);
  const board = execFileSync("git", ["show", "main:views/tasks.base"], { cwd: remote, encoding: "utf8" });
  assert.match(board, /type: kanban/, "the Obsidian Bases views come with a new space");
  execFileSync("git", ["show", "main:views/roadmap.base"], { cwd: remote, encoding: "utf8" });
  dashboard.stop();

  const restarted = new Dashboard({ dataDir });
  await restarted.start();
  try {
    const overview = readOverview(restarted, { space: "test space" });
    assert.equal(overview.error, "");
    assert.equal(overview.spaces[0]!.key, "TST");
  } finally {
    restarted.stop();
  }
});

/** A bare remote whose default branch `branch` has one commit with the given files, as a forge makes it. */
function seededRemote(branch: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-remote-"));
  const remote = join(dir, "plan.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", branch, remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], { cwd: seed });
  execFileSync("git", ["push", "--quiet", "origin", `HEAD:${branch}`], { cwd: seed });
  return remote;
}

test("a repository with only a README, LICENSE and .gitignore becomes a space on its default branch", async () => {
  const remote = seededRemote("trunk", { "README.md": "# Plan\n", LICENSE: "MIT\n", ".gitignore": "node_modules" });
  const first = execFileSync("git", ["rev-parse", "trunk"], { cwd: remote, encoding: "utf8" }).trim();
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await assert.rejects(dashboard.addSpace({ remote }), /holds only a README, LICENSE or \.gitignore: give a key/);
    assert.deepEqual(await dashboard.addSpace({ remote, key: "TST", name: "Test" }), { key: "TST" });
    const show = (path: string) => execFileSync("git", ["show", `trunk:${path}`], { cwd: remote, encoding: "utf8" });
    assert.equal(show("README.md"), "# Plan\n", "the README stays");
    assert.equal(show("LICENSE"), "MIT\n");
    assert.equal(show(".gitignore"), "node_modules\n.obsidian/workspace*.json\n", "the plugin's line is appended");
    assert.match(show("space.yaml"), /key: TST/);
    assert.match(show("views/tasks.base"), /type: kanban/);
    const parent = execFileSync("git", ["rev-parse", "trunk^"], { cwd: remote, encoding: "utf8" }).trim();
    assert.equal(parent, first, "the space is one commit on top of the forge's commit");
    assert.equal(execFileSync("git", ["branch", "--list", "main"], { cwd: remote, encoding: "utf8" }), "", "no other branch is made");
  } finally {
    dashboard.stop();
  }
});

test("a repository with other content and no space.yaml is refused with what was found", async () => {
  for (const files of [
    { "README.md": "# App\n", "package.json": "{}", "src/index.ts": "" },
    { "docs/README.md": "nested\n" },
  ] as Record<string, string>[]) {
    const remote = seededRemote("main", files);
    const before = execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" });
    const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
    try {
      const listed = Object.keys(files).filter((path) => path !== "README.md")[0]!.split("/")[0]!;
      await assert.rejects(dashboard.addSpace({ remote, key: "TST", name: "Test" }), (error: Error) => {
        assert.match(error.message, /not a plan repository: it has no space\.yaml and holds/);
        assert.ok(error.message.includes(JSON.stringify(listed)), error.message);
        return true;
      });
      assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }), before, "nothing is pushed");
    } finally {
      dashboard.stop();
    }
  }
});

test("a .gitignore that ignores the plan's files still lets the space reach the remote", async () => {
  const remote = seededRemote("main", { "README.md": "# Plan\n", ".gitignore": "*.yaml\nviews/\n" });
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await dashboard.addSpace({ remote, key: "TST", name: "Test" });
    const show = (path: string) => execFileSync("git", ["show", `main:${path}`], { cwd: remote, encoding: "utf8" });
    assert.match(show("space.yaml"), /key: TST/);
    assert.match(show("views/tasks.base"), /type: kanban/);
  } finally {
    dashboard.stop();
  }
});

test("a README-only repository whose default branch looks like an option is refused before anything is pushed", async () => {
  const remote = seededRemote("main", { "README.md": "# Plan\n" });
  const head = execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/heads/-evil", head], { cwd: remote });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/-evil"], { cwd: remote });
  const refs = () => execFileSync("git", ["for-each-ref"], { cwd: remote, encoding: "utf8" });
  const before = refs();
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await assert.rejects(dashboard.addSpace({ remote, key: "TST", name: "Test" }), /not a usable branch name/);
    assert.equal(refs(), before, "nothing is pushed");
  } finally {
    dashboard.stop();
  }
});

test("a key already connected is refused before a README-only repository gets a space", async () => {
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await dashboard.addSpace({ remote: emptyRemote(), key: "TST", name: "Test" });
    const remote = seededRemote("main", { "README.md": "# Plan\n" });
    const before = execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" });
    await assert.rejects(dashboard.addSpace({ remote, key: "TST", name: "Other" }), /space TST is already connected/);
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }), before, "nothing is pushed");
  } finally {
    dashboard.stop();
  }
});

test("a .gitignore that is a symlink is other content, and nothing is written through it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-link-"));
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "keep\n");
  const remote = seededRemote("main", { "README.md": "# Plan\n" });
  const seed = join(dirname(remote), "seed");
  symlinkSync(outside, join(seed, ".gitignore"));
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "link"], { cwd: seed });
  execFileSync("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: seed });
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await assert.rejects(dashboard.addSpace({ remote, key: "TST", name: "Test" }), /holds "\.gitignore"/);
    assert.equal(readFileSync(outside, "utf8"), "keep\n");
  } finally {
    dashboard.stop();
  }
});

test("remote URLs match across ssh, https and .git forms; unmatched projects say so", () => {
  const forms = [
    "git@github.com:acme/android.git",
    "https://github.com/acme/android",
    "ssh://git@GitHub.com:22/acme/android.git",
    "https://user@github.com/acme/android.git/",
  ];
  for (const form of forms) assert.equal(normalizeRemote(form), "github.com/acme/android", form);
  assert.deepEqual(
    mapProjects(
      { android: { remote: forms[0]! }, core: { remote: "git@gitlab-ssh.example.com:backend/core.git" } },
      [{ projectId: "prj_1", name: "android", remote: forms[1] }],
    ),
    { android: "prj_1", core: null },
  );
});

test("a remote whose default branch looks like an option is refused before any fetch runs it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-inject-"));
  const remote = join(dir, "plan.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  writeFileSync(join(seed, "space.yaml"), "schema: paseo-dashboard/1\nkey: INJ\nname: Inject\n");
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed"], { cwd: seed });
  execFileSync("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: seed });
  const evil = join(dir, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\ntouch ${join(dir, "pwned")}\nexec git-upload-pack "$@"\n`);
  chmodSync(evil, 0o755);
  const branch = `--upload-pack=${evil}`;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", `refs/heads/${branch}`, head], { cwd: remote });
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: remote });
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-data-")) });
  try {
    await assert.rejects(dashboard.addSpace({ remote }), /not a usable branch name/);
    await dashboard.syncAll();
    assert.equal(existsSync(join(dir, "pwned")), false);
  } finally {
    dashboard.stop();
  }
});

test("connecting a space again keeps the journal of its earlier connection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dashboard-data-"));
  const remote = emptyRemote();
  const first = new Dashboard({ dataDir });
  await first.addSpace({ remote, key: "TST", name: "Test" });
  first.stop();
  const journal = join(dataDir, "spaces", "TST", "journal.json");
  writeFileSync(journal, JSON.stringify({ version: 1, entries: [{ op: { op_id: "op_kept", kind: "derived", id: "TST-FEAT0", to: "done" } }], abandonedClaims: [] }));
  writeFileSync(join(dataDir, "spaces.json"), "{ torn");
  const second = new Dashboard({ dataDir });
  await second.start();
  try {
    assert.match(second.warnings[0] ?? "", /moved to/);
    await second.addSpace({ remote });
    assert.match(readFileSync(journal, "utf8"), /op_kept/);
  } finally {
    second.stop();
  }
});

test("a stale lock is taken over by one taker at a time", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-lock-"));
  const path = join(dir, "owner.lock");
  writeFileSync(path, JSON.stringify({ pid: 4242, token: "gone", heartbeat: 0 }));
  writeFileSync(`${path}.takeover`, "");
  const blocked = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000, alive: () => false });
  assert.equal(blocked.acquire().owner, false, "another taker holds the guard");
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(`${path}.takeover`, old, old);
  const taker = new OwnerLock(path, { heartbeatMs: 60_000, staleMs: 120_000, alive: () => false });
  assert.equal(taker.acquire().owner, true, "a guard left by a crash is broken");
  assert.equal(existsSync(`${path}.takeover`), false);
  taker.release();
});
