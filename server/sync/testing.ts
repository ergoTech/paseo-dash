import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult, GitRunner } from "./git.ts";
import { systemGit } from "./git.ts";
import { SpaceSync, type SpaceSyncOptions } from "./space-sync.ts";

/** Test fixtures: a bare remote with a small plan, and clones acting as collaborators. */

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
}

const SPACE = `schema: paseo-dashboard/1
key: TST
name: Test space
# projects keep their order on the map
projects:
  core: { remote: git@github.com:acme/core.git, trunk: main }
`;

function task(id: string, title: string, extra = ""): string {
  return `---
id: ${id}
type: task
title: ${title}
status: todo
project: core
feature: "[[TST-FEAT0-totp]]"
${extra}---

## Brief

Do ${title}.

## Acceptance

- [ ] first
- [ ] second

## Notes
`;
}

export interface Fixture {
  dir: string;
  remote: string;
  clone(name: string): string;
  sync(name: string, options?: Partial<SpaceSyncOptions>): SpaceSync;
  /** A commit by a person in their own clone, outside the plugin. */
  external(name: string, edit: (root: string) => void): void;
}

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-sync-"));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  identify(seed, "seed");
  mkdirSync(join(seed, "tasks"));
  mkdirSync(join(seed, "features"));
  writeFileSync(join(seed, "space.yaml"), SPACE);
  writeFileSync(
    join(seed, "features", "TST-FEAT0-totp.md"),
    "---\nid: TST-FEAT0\ntype: feature\ntitle: TOTP\nstatus: active\nbranch: feat/totp\n---\n\nSpec.\n",
  );
  writeFileSync(join(seed, "tasks", "TST-TASK1-one.md"), task("TST-TASK1", "one"));
  writeFileSync(join(seed, "tasks", "TST-TASK2-two.md"), task("TST-TASK2", "two"));
  sh(seed, "add", "-A");
  sh(seed, "commit", "--quiet", "-m", "seed");
  sh(seed, "push", "--quiet", "origin", "HEAD:main");

  const clone = (name: string) => {
    const root = join(dir, name);
    execFileSync("git", ["clone", "--quiet", remote, root]);
    identify(root, name);
    return root;
  };
  return {
    dir,
    remote,
    clone,
    sync: (name, options = {}) =>
      new SpaceSync({ root: clone(name), branch: "main", journalPath: join(dir, `${name}.journal.json`), ...options }),
    external: (name, edit) => {
      const root = join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
      execFileSync("git", ["clone", "--quiet", remote, root]);
      identify(root, name);
      edit(root);
      sh(root, "add", "-A");
      sh(root, "commit", "--quiet", "-m", `${name} edits by hand`);
      sh(root, "push", "--quiet", "origin", "HEAD:main");
    },
  };
}

function identify(root: string, name: string): void {
  sh(root, "config", "user.name", name);
  sh(root, "config", "user.email", `${name}@example.com`);
}

/** A git runner whose push and fetch behaviour a test can change. */
export function scriptedGit(script: {
  push?: (run: () => Promise<GitResult>) => Promise<GitResult>;
  fetch?: (run: () => Promise<GitResult>) => Promise<GitResult>;
}): GitRunner {
  return {
    run(cwd, args, timeoutMs) {
      const real = () => systemGit.run(cwd, args, timeoutMs);
      if (args[0] === "push" && script.push) return script.push(real);
      if (args[0] === "fetch" && script.fetch) return script.fetch(real);
      return real();
    },
  };
}

export const UNREACHABLE: GitResult = {
  code: 128,
  stdout: "",
  stderr: "fatal: Could not read from remote repository.",
  timedOut: false,
};
export const CUT: GitResult = { code: 1, stdout: "", stderr: "", timedOut: true };

export function remoteLog(remote: string): string[] {
  return sh(remote, "log", "--format=%s", "main").trim().split("\n");
}
