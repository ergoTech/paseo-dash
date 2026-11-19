import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { uiStartCheck } from "../api/reads.ts";
import { projectCheckout, setup } from "../api/testing.ts";
import { startTask } from "../api/writes.ts";
import { type GitRunner, systemGit } from "../sync/git.ts";
import { ForgeCli } from "../tracker/forge.ts";
import { type BranchPlan, decideBranch, type ExistingBranch } from "./branch.ts";
import { settled } from "./testing.ts";

/**
 * A task that never ran meets a branch of its planned name (03-model.md, Branch names): merged, there
 * and not merged, or not there; on GitHub and on GitLab. JOBBY-ZRF91: ERG-96Q3T and ERG-8XSZH were
 * done by sessions outside the dashboard, and Start failed on their merged local branch.
 */

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };
const task = { id: "TST-FX001", title: "Fix", type: "task", status: "todo", project: "core", depends_on: [], links: [] } as unknown as Task;

type Pr = { n: number; state: "open" | "merged" | "closed"; mergedAt?: string };

/** A forge that knows these PR/MRs of feat/login, or cannot answer ("down"). */
const FORGES = {
  github: {
    remote: "git@github.com:acme/core.git",
    label: (n: number) => `#${n}`,
    forge: (prs: Pr[] | "down") =>
      new ForgeCli(async (command, args) => {
        if (prs === "down" || command !== "gh" || args[1] !== "list") return { code: 1, stdout: "" };
        const listed = args[3] === "feat/login" ? prs : [];
        return {
          code: 0,
          stdout: JSON.stringify(
            listed.map((p) => ({ number: p.n, url: `https://github.com/acme/core/pull/${p.n}`, state: p.state.toUpperCase(), mergedAt: p.mergedAt ?? null, headRefName: "feat/login", isCrossRepository: false })),
          ),
        };
      }),
  },
  gitlab: {
    remote: "git@git-ssh.example.com:acme/core.git",
    label: (n: number) => `!${n}`,
    forge: (prs: Pr[] | "down") =>
      new ForgeCli(async (command, args) => {
        if (prs === "down" || command !== "glab" || args[1] !== "list") return { code: 1, stdout: "" };
        const listed = args[3] === "feat/login" ? prs : [];
        return {
          code: 0,
          stdout: JSON.stringify(
            listed.map((p) => ({
              iid: p.n,
              web_url: `https://git.example.com/acme/core/-/merge_requests/${p.n}`,
              state: p.state === "open" ? "opened" : p.state,
              merged_at: p.mergedAt ?? null,
              source_branch: "feat/login",
              source_project_id: 7,
              target_project_id: 7,
            })),
          ),
        };
      }),
  },
} as const;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

/** A checkout whose feat/login has a commit of its own, here and on origin, not on main. */
function unmerged(where: "local" | "origin" | "both" = "both"): string {
  const root = projectCheckout();
  sh(root, "checkout", "-q", "-b", "feat/login");
  sh(root, "commit", "-q", "--allow-empty", "-m", "work");
  if (where !== "local") sh(root, "push", "-q", "origin", "feat/login");
  sh(root, "checkout", "-q", "main");
  if (where === "origin") sh(root, "branch", "-q", "-D", "feat/login");
  return root;
}

/** A checkout whose local feat/login was merged into main (and main pushed), then deleted on origin: ERG's case. */
function mergedIntoTrunk(): string {
  const root = projectCheckout();
  sh(root, "checkout", "-q", "-b", "feat/login");
  sh(root, "commit", "-q", "--allow-empty", "-m", "work");
  sh(root, "checkout", "-q", "main");
  sh(root, "merge", "-q", "--no-ff", "-m", "Merge feat/login", "feat/login");
  sh(root, "push", "-q", "origin", "main");
  return root;
}

/** A checkout whose feat/login, with a commit of its own, was fast-forwarded into main (and main pushed). */
function fastForwarded(): string {
  const root = projectCheckout();
  sh(root, "checkout", "-q", "-b", "feat/login");
  sh(root, "commit", "-q", "--allow-empty", "-m", "work");
  sh(root, "checkout", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", "feat/login");
  sh(root, "push", "-q", "origin", "main");
  return root;
}

const decide = (forge: keyof typeof FORGES, root: string, prs: Pr[] | "down", existing?: "continue" | "fresh", git: GitRunner = systemGit) =>
  decideBranch({ task, planned: "feat/login", root, remote: FORGES[forge].remote, host: "ergo-mbp", git, forge: FORGES[forge].forge(prs), trunks: ["main"], ...(existing ? { existing } : {}) });

const refused = (plan: BranchPlan): { error: string; existing: ExistingBranch } => {
  assert.equal(plan.ok, false, "refused");
  const { error, existing } = plan as { error: string; existing?: ExistingBranch };
  assert.ok(existing, "says what the branch holds");
  return { error, existing };
};

for (const forge of ["github", "gitlab"] as const) {
  const label = FORGES[forge].label;

  test(`${forge}: a task that never ran starts on its planned branch when no such branch exists`, async () => {
    const plan = await decide(forge, projectCheckout([], ["feat/other"]), "down");
    assert.deepEqual(plan, { ok: true, branch: "feat/login", workspace: { kind: "new", action: "branch-off" }, note: "" }, "the forge is not even asked");
  });

  test(`${forge}: a merged branch is never continued: mark the task done, or a fresh run on the suffixed name`, async () => {
    const root = unmerged();
    const prs: Pr[] = [{ n: 3, state: "merged", mergedAt: "2026-11-11T22:12:00Z" }];
    const { error, existing } = refused(await decide(forge, root, prs));
    assert.match(error, new RegExp(`^A branch feat/login already exists in core \\(on this Mac; on origin\\) and its work is merged: ${label(3)} was merged\\. Mark «Fix» \\(TST-FX001\\) done if that was its work, or start it on feat/login-2`));
    assert.deepEqual([existing.merged, existing.pr?.label, existing.pr?.state, existing.pr?.mergedAt, existing.fresh], [true, label(3), "merged", "2026-11-11T22:12:00Z", "feat/login-2"]);
    assert.equal(existing.cannotContinue, "its work is merged already");

    const fresh = await decide(forge, root, prs, "fresh");
    assert.deepEqual(fresh, { ok: true, branch: "feat/login-2", workspace: { kind: "new", action: "branch-off" }, note: "a fresh branch: feat/login already exists" });
    assert.deepEqual(await decide(forge, root, "down", "fresh"), fresh, "a fresh run does not wait on the forge, nor say what it said");
    assert.match(refused(await decide(forge, root, prs, "continue")).error, /its work is merged/, "continuing a merged branch is refused");

    // Its last PR/MR merged, the branch deleted on origin, the local one left behind; feat/login-2 is taken.
    const behind = mergedIntoTrunk();
    sh(behind, "branch", "feat/login-2");
    const local = refused(await decide(forge, behind, "down"));
    assert.match(local.error, /and its work is merged: it was merged into origin\/main\./, "the trunk tells, though the forge cannot");
    assert.deepEqual([local.existing.merged, local.existing.inTrunk, local.existing.where, local.existing.fresh], [true, "main", ["on this Mac"], "feat/login-3"]);
  });

  test(`${forge}: a branch there and not merged: continue on it, or a fresh run on the suffixed name`, async () => {
    const root = unmerged();
    const { error, existing } = refused(await decide(forge, root, []));
    assert.equal(error, "A branch feat/login already exists in core (on this Mac; on origin) and belongs to no run of «Fix» (TST-FX001). Choose in Paseo Dash's start confirmation: continue on it, or start it on feat/login-2.");
    assert.deepEqual([existing.merged, existing.cannotContinue, existing.fresh], [false, "", "feat/login-2"]);

    const open: Pr[] = [{ n: 5, state: "open" }, { n: 4, state: "merged", mergedAt: "2026-11-01T10:00:00Z" }];
    const continued = await decide(forge, root, open, "continue");
    assert.ok(continued.ok);
    assert.deepEqual([continued.branch, continued.workspace, continued.continues, continued.continuesPr?.endsWith(`/${5}`)], ["feat/login", { kind: "new", action: "checkout" }, true, true]);
    assert.equal(continued.note, `continues the existing branch on this Mac and on origin, which no run of this task made; ${label(5)} stays open`, "an older merge does not count: its latest is open");
    const fresh = await decide(forge, root, [], "fresh");
    assert.deepEqual(fresh.ok && [fresh.branch, fresh.workspace, fresh.continues], ["feat/login-2", { kind: "new", action: "branch-off" }, undefined]);

    const onlyOrigin = refused(await decide(forge, unmerged("origin"), []));
    assert.deepEqual(onlyOrigin.existing.where, ["on origin"]);

    // Checked out in another worktree: git keeps it there, so only a fresh run can start.
    const held = unmerged("local");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "dashboard-held-")));
    sh(held, "worktree", "add", "-q", join(elsewhere, "wt"), "feat/login");
    const blocked = refused(await decide(forge, held, []));
    assert.deepEqual(blocked.existing.where, ["on this Mac", `checked out in ${join(elsewhere, "wt")}`]);
    assert.match(blocked.existing.cannotContinue, /it is checked out in .+wt, where git keeps it while it is; switch that checkout to another branch first/);
    assert.match(blocked.error, /Start it on feat\/login-2 from Paseo Dash's start confirmation, since it cannot be continued now: it is checked out in/);
    assert.match(refused(await decide(forge, held, [], "continue")).error, /It cannot be continued: it is checked out in/);
    assert.equal((await decide(forge, held, [], "fresh")).ok, true);

    // Made from the trunk with nothing committed yet: a trunk commit is not merged work, and continuing is safe.
    const empty = refused(await decide(forge, projectCheckout(["feat/login"]), []));
    assert.deepEqual([empty.existing.merged, empty.existing.inTrunk, empty.existing.cannotContinue], [false, undefined, ""]);
    assert.equal((await decide(forge, projectCheckout(["feat/login"]), [], "continue")).ok, true);

    // Fast-forwarded into the trunk: ancestry cannot tell it from an empty branch; the forge's merge can.
    const ff = fastForwarded();
    assert.equal(refused(await decide(forge, ff, [])).existing.merged, false);
    assert.equal(refused(await decide(forge, ff, [{ n: 6, state: "merged", mergedAt: "2026-11-11T22:12:00Z" }])).existing.merged, true);

    // git runs out of time comparing it with the trunk: that is not "not merged", so no continuing on it.
    const slow: GitRunner = { run: (cwd, args, ms) => (args[0] === "rev-list" ? Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true }) : systemGit.run(cwd, args, ms)) };
    const late = refused(await decide(forge, mergedIntoTrunk(), [], "continue", slow));
    assert.deepEqual([late.existing.merged, late.existing.cannotContinue], [undefined, "git did not answer in time, so whether it was merged into the trunk cannot be told"]);

    // git does not say which worktrees hold it: no continuing on it.
    const silent: GitRunner = { run: (cwd, args, ms) => (args[0] === "worktree" ? Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: true }) : systemGit.run(cwd, args, ms)) };
    const unheld = refused(await decide(forge, root, [], "continue", silent));
    assert.equal(unheld.existing.cannotContinue, "git did not say in time whether another worktree has it checked out");

    // The forge cannot tell whether it was merged: only a fresh run starts.
    const unsure = refused(await decide(forge, root, "down", "continue"));
    assert.deepEqual([unsure.existing.merged, unsure.existing.cannotContinue], [undefined, "gh or glab did not answer, so whether its PR/MR was merged cannot be told"]);
    assert.equal((await decide(forge, root, "down", "fresh")).ok, true);
  });
}

test("Start on an existing branch: refused without a choice and no claim taken; the choice starts on the branch it names", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: FORGES.github.forge([]) });
  try {
    s.dashboard.projectRoots.set("prj_core", unmerged());
    const shown = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: true });
    assert.match(shown.error, /A branch feat\/login already exists in core \(on this Mac; on origin\) and belongs to no run/);
    assert.deepEqual(shown.existing, { branch: "feat/login", where: ["on this Mac", "on origin"], merged: false, in_trunk: "", fresh: "feat/login-2", cannot_continue: "" });

    const refusedStart = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
    assert.match(refusedStart.error, /already exists in core/);
    assert.deepEqual([s.task("TST-FX001")!.status, s.task("TST-FX001")!.run_id], ["todo", undefined], "nothing claimed");

    const fresh = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: true, branch: "fresh" });
    assert.deepEqual([fresh.error, fresh.branch, fresh.existing], ["", "feat/login-2 (a fresh branch: feat/login already exists)", null]);

    const chosen = await uiStartCheck(s.ctx, { task: "TST-FX001", profile: "Review", anyway: true, branch: "continue" });
    assert.equal(chosen.error, "");
    assert.equal(chosen.branch, "feat/login (continues the existing branch on this Mac and on origin, which no run of this task made)");
    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" }, { branch: "continue", shown: { project: chosen.project, branch: chosen.branch, workspace: chosen.workspace, profile: chosen.profile, issue: chosen.issue } });
    assert.equal(started.ok, true, started.error);
    const run = s.dashboard.runs!.byTask("TST-FX001")!;
    await settled(() => run.activity !== "launching");
    assert.equal(run.activity, "working", run.error);
    const workspace = [...s.fake.workspaces.values()][0]!;
    assert.deepEqual(workspace.request.source, { kind: "worktree", projectId: "prj_core", action: "checkout", refName: "feat/login" });
    assert.match(String([...s.fake.agents.values()][0]!.request.prompt), /This branch already has work no run of this task made: read it first/);
  } finally {
    s.stop();
  }
});

test("Start on a merged branch offers no start on it; a fresh run starts on the suffixed name", async () => {
  const s = await setup({ profiles: [PROFILE] }, { forge: FORGES.gitlab.forge("down") });
  try {
    s.dashboard.projectRoots.set("prj_core", mergedIntoTrunk());
    const shown = await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: true });
    assert.match(shown.error, /its work is merged: it was merged into origin\/main\. Mark «Fix flaky login test» \(TST-FX001\) done if that was its work, or start it on feat\/login-2/);
    assert.deepEqual([shown.existing?.merged, shown.existing?.in_trunk, shown.existing?.cannot_continue], [true, "main", "its work is merged already"]);
    assert.match((await uiStartCheck(s.ctx, { task: "TST-FX001", anyway: true, branch: "continue" })).error, /its work is merged/);
    const started = await startTask(s.ctx, { task: "TST-FX001", profile: "Review" }, { branch: "fresh" });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.branch, "feat/login-2");
  } finally {
    s.stop();
  }
});
