import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { Dashboard, type DashboardOptions } from "../dashboard.ts";
import { FakePaseo, type FakePaseoOptions } from "../runner/testing.ts";
import { fixture, sh } from "../sync/testing.ts";
import type { WriteContext } from "./writes.ts";

/**
 * The plan API against a real plan repo: a bare remote seeded with the TST space (sync/testing.ts:
 * feature TST-FEAT0 with tasks TST-TASK1 and TST-TASK2 in core), plus, committed by hand, a release,
 * a second feature, a task with a live run, a blocked task and a task in an unmapped project.
 */

export const local = (h: number, m: number) => new Date(2026, 9, 26, h, m);
export const NOW = local(10, 0);

function seed(root: string): void {
  mkdirSync(join(root, "milestones"));
  writeFileSync(
    join(root, "milestones", "TST-MS001-release-2-3.md"),
    "---\nid: TST-MS001\ntype: milestone\ntitle: Release 2.3\nstatus: active\ndue: 2026-11-30\n---\n",
  );
  writeFileSync(
    join(root, "features", "TST-FEAT1-login.md"),
    '---\nid: TST-FEAT1\ntype: feature\ntitle: Login\nstatus: active\nmilestone: "[[TST-MS001-release-2-3]]"\nbranch: feat/login\n---\n',
  );
  const task = (file: string, front: string) =>
    writeFileSync(
      join(root, "tasks", file),
      `---\n${front}---\n\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [x] first\n- [ ] second\n`,
    );
  task("TST-FX001-fix-flaky-login-test.md", 'id: TST-FX001\ntype: task\ntitle: Fix flaky login test\nstatus: todo\nproject: core\nfeature: "[[TST-FEAT1-login]]"\n');
  task(
    "TST-RD002-login-page-redesign.md",
    `id: TST-RD002\ntype: task\ntitle: Login page redesign\nstatus: in_progress\nproject: core\nrun_id: r-anna\nrun_by: anna\nrun_host: anna-mbp\nrun_branch: feat/login-redesign\nrun_started: ${local(8, 5).toISOString()}\n`,
  );
  task("TST-DEP01-blocked-thing.md", 'id: TST-DEP01\ntype: task\ntitle: Blocked thing\nstatus: todo\nproject: core\ndepends_on: ["[[TST-TASK1-one]]"]\n');
  task("TST-ST001-site-thing.md", "id: TST-ST001\ntype: task\ntitle: Site thing\nstatus: todo\nproject: site\n");
  const space = readFileSync(join(root, "space.yaml"), "utf8");
  writeFileSync(join(root, "space.yaml"), `${space}  site: { remote: git@github.com:acme/site.git }\n`);
}

/** A checkout of the "core" project with a bare origin; branches made where asked. */
export function projectCheckout(local: string[] = [], remote: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-project-"));
  const origin = join(dir, "origin.git");
  const root = join(dir, "core");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, root], { stdio: "ignore" });
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "init");
  git(root, "push", "--quiet", "origin", "HEAD:main");
  for (const b of remote) git(root, "push", "--quiet", "origin", `HEAD:refs/heads/${b}`);
  for (const b of local) git(root, "branch", b);
  return root;
}

export async function setup(
  paseo: FakePaseoOptions = { profiles: [{ id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" }] },
  options: Partial<DashboardOptions> = {},
) {
  const f = fixture();
  f.external("ergo", seed);
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-api-")), fetchIntervalMs: 3_600_000, starts: { branchCheckDelayMs: 1 }, ...options });
  const fake = new FakePaseo(paseo);
  dashboard.attach(fake.api());
  await dashboard.addSpace({ remote: f.remote });
  dashboard.updateMapping([{ projectId: "prj_core", name: "core", remote: "https://github.com/acme/core", rootPath: projectCheckout() }]);
  const ctx: WriteContext = { dashboard, now: () => NOW, host: "ergo-mbp" };
  const sync = () => dashboard.spaces.get("TST")!.sync;
  const task = (id: string) => sync().plan.entities.get(id)?.entity as Task | undefined;
  /** Waits for the background push, then reads a file of the remote's default branch. */
  const remoteFile = async (pattern: RegExp) => {
    await sync().sync();
    const path = sh(f.remote, "ls-tree", "-r", "--name-only", "main")
      .split("\n")
      .find((p) => pattern.test(p));
    return path ? sh(f.remote, "show", `main:${path}`) : undefined;
  };
  /**
   * Waits until every sync step queued before it has finished (the sync's queue is first in, first
   * out). A sync run replaces the loaded plan (it is read again from the clone), so a test that edits
   * that plan in memory and then awaits settles first: else a push an earlier write started may finish
   * in between and drop the edit. A step queued after it (a timer, a hook) is not waited for.
   */
  const settle = () => sync().sync();
  return { f, dashboard, ctx, sync, task, remoteFile, settle, fake, stop: () => dashboard.stop() };
}
