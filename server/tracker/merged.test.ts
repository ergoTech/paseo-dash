import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { readBoard } from "../api/reads.ts";
import { setup } from "../api/testing.ts";
import type { Plan } from "../plan/load.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { taskView } from "../views.ts";
import { type CommandRunner, ForgeCli } from "./forge.ts";
import { mergedAfter, mergedCandidates, MergedTracker } from "./merged.ts";

/**
 * Work merged outside the dashboard (03-model.md): JOBBY-ZRF91. ERG-96Q3T (site) and ERG-8XSZH
 * (docker-compose) stayed in todo for a day after site !975 and compose !206 merged; both were done by
 * sessions the dashboard did not start, on the branch feat/member-roles both repositories share.
 */

const CREATED = "2026-11-11T10:00:00Z";
const SITE = "https://git.example.com/frontend/site/-/merge_requests";
const COMPOSE = "https://git.example.com/build/docker-compose/-/merge_requests";

const projects = {
  site: { remote: "git@git-ssh.example.com:frontend/site.git", trunk: "master", web_host: "git.example.com" },
  compose: { remote: "git@git-ssh.example.com:build/docker-compose.git", trunk: "master", web_host: "git.example.com" },
  core: { remote: "git@github.com:acme/core.git", trunk: "main" },
};

function planOf(tasks: Partial<Task>[]): Plan {
  const entities = new Map(tasks.map((t) => [t.id!, { entity: { type: "task", status: "todo", depends_on: [], links: [], labels: [], created: CREATED, ...t } as Task }]));
  return { space: { projects }, entities, duplicates: new Set(), problems: [] } as unknown as Plan;
}

type Mr = { iid: number; state: "merged" | "opened" | "closed"; merged_at?: string; branch: string };

/** glab per checkout: each project's own MRs; gh for core. Every call is counted. */
function forge(mrs: Record<string, Mr[]>, prs: { number: number; state: string; mergedAt?: string }[] = [], calls: string[] = []): ForgeCli {
  const run: CommandRunner = async (command, args, cwd) => {
    calls.push(`${cwd.split("/").pop()} ${command} ${args.slice(0, 4).join(" ")}`);
    if (command === "gh" && args[1] === "view") {
      const pr = prs.find((p) => args[2]!.endsWith(`/pull/${p.number}`));
      return pr ? { code: 0, stdout: JSON.stringify({ ...pr, url: args[2], headRefName: "feat/x", isCrossRepository: false }) } : { code: 1, stdout: "" };
    }
    if (command === "gh") return { code: 0, stdout: "[]" };
    const own = mrs[cwd.split("/").pop()!];
    if (!own) return { code: 1, stdout: "" };
    const base = cwd.endsWith("prj_site") ? SITE : COMPOSE;
    const json = (mr: Mr) => ({ iid: mr.iid, web_url: `${base}/${mr.iid}`, state: mr.state, merged_at: mr.merged_at ?? null, source_branch: mr.branch, source_project_id: 1, target_project_id: 1 });
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(own.filter((mr) => mr.branch === args[3]).map(json)) };
    const mr = own.find((m) => String(m.iid) === args[2]);
    return mr ? { code: 0, stdout: JSON.stringify(json(mr)) } : { code: 1, stdout: "" };
  };
  return new ForgeCli(run);
}

function tracker(plan: Plan, cli: ForgeCli) {
  const sync = { plan } as unknown as SpaceSync;
  const space = { sync, mapping: { site: "prj_site", compose: "prj_compose", core: "prj_core" } as Record<string, string | null> };
  const t = new MergedTracker({ spaces: () => [space], projectRoot: (id) => `/roots/${id}`, forge: cli });
  return { t, space };
}

test("a shared branch name is looked up in each task's own project: site shows !975, compose !206", async () => {
  const plan = planOf([
    { id: "ERG-96Q3T", project: "site", branch: "feat/member-roles", links: [`${SITE}/975`, `${COMPOSE}/206`] },
    { id: "ERG-8XSZH", project: "compose", branch: "feat/member-roles" },
  ]);
  const calls: string[] = [];
  const cli = forge(
    {
      prj_site: [{ iid: 975, state: "merged", merged_at: "2026-11-11T22:12:00Z", branch: "feat/member-roles" }],
      prj_compose: [{ iid: 206, state: "merged", merged_at: "2026-11-11T21:56:00Z", branch: "feat/member-roles" }],
    },
    [],
    calls,
  );
  const { t } = tracker(plan, cli);
  await t.checkAll();
  assert.deepEqual(t.shown(plan, plan.entities.get("ERG-96Q3T")!.entity as Task), [{ label: "!975", url: `${SITE}/975`, merged_at: "2026-11-11T22:12:00Z" }], "found by link and by branch: once");
  assert.deepEqual(t.shown(plan, plan.entities.get("ERG-8XSZH")!.entity as Task), [{ label: "!206", url: `${COMPOSE}/206`, merged_at: "2026-11-11T21:56:00Z" }]);
  assert.ok(!calls.some((c) => c.startsWith("prj_site") && c.includes("206")), "the other project's MR in the site task's links is not read in site");
  assert.deepEqual(
    calls.filter((c) => c.includes("list")),
    ["prj_site glab mr list --source-branch feat/member-roles", "prj_compose glab mr list --source-branch feat/member-roles"],
  );
  assert.equal((plan.entities.get("ERG-96Q3T")!.entity as Task).status, "todo", "the status never changes by itself");
});

test("GitHub: a PR among the links merged after the task was created; an older one, or another repository's, is not", async () => {
  const plan = planOf([
    { id: "TST-GH001", project: "core", links: ["https://github.com/acme/core/pull/12"] },
    { id: "TST-GH002", project: "core", links: ["https://github.com/acme/core/pull/11"] },
    { id: "TST-GH003", project: "core", links: ["https://github.com/acme/other/pull/12"] },
    { id: "TST-GH004", project: "core", status: "inbox", links: ["https://github.com/acme/core/pull/12"] },
  ]);
  const cli = forge({}, [
    { number: 12, state: "MERGED", mergedAt: "2026-11-11T22:00:00Z" },
    { number: 11, state: "MERGED", mergedAt: "2026-11-10T09:00:00Z" },
  ]);
  const { t } = tracker(plan, cli);
  await t.checkAll();
  const shown = (id: string) => t.shown(plan, plan.entities.get(id)!.entity as Task).map((pr) => pr.label);
  assert.deepEqual([shown("TST-GH001"), shown("TST-GH002"), shown("TST-GH003"), shown("TST-GH004")], [["#12"], [], [], ["#12"]], "a draft in the inbox too");
  assert.equal(mergedCandidates(plan, plan.entities.get("TST-GH003")!.entity as Task), undefined, "another repository's PR is never asked for");
});

test("only tasks that never ran, in todo or inbox, are followed; a forge that cannot answer leaves the last reading", async () => {
  const merged: Mr[] = [{ iid: 975, state: "merged", merged_at: "2026-11-11T22:12:00Z", branch: "feat/member-roles" }];
  const base = { project: "site", branch: "feat/member-roles" };
  const plan = planOf([
    { id: "ERG-RUN01", ...base, run_id: "r-1", run_branch: "feat/member-roles" },
    { id: "ERG-DONE1", ...base, status: "done" },
    { id: "ERG-NOCRT", ...base, created: undefined },
    { id: "ERG-PLAIN", project: "site" },
    { id: "ERG-OK001", ...base },
  ]);
  for (const id of ["ERG-RUN01", "ERG-DONE1", "ERG-NOCRT", "ERG-PLAIN"]) assert.equal(mergedCandidates(plan, plan.entities.get(id)!.entity as Task), undefined, id);

  const mrs: Record<string, Mr[]> = { prj_site: merged };
  const { t } = tracker(plan, forge(mrs));
  await t.checkAll();
  assert.deepEqual([...t.seen.keys()], ["ERG-OK001"]);
  delete mrs.prj_site; // glab now fails in site
  await t.checkAll();
  assert.equal(t.shown(plan, plan.entities.get("ERG-OK001")!.entity as Task).length, 1, "kept");

  // Its latest MR is open again (more work on the branch): nothing is merged.
  mrs.prj_site = [{ iid: 980, state: "opened", branch: "feat/member-roles" }, ...merged];
  await t.checkAll();
  assert.deepEqual(t.shown(plan, plan.entities.get("ERG-OK001")!.entity as Task), []);

  // A reading for other links or another branch does not show for the task as it is now.
  mrs.prj_site = merged;
  await t.checkAll();
  const edited = { ...(plan.entities.get("ERG-OK001")!.entity as Task), branch: "feat/other" };
  assert.deepEqual(t.shown(plan, edited), []);
});

test("mergedAfter: merged strictly after the task was created, with a merge time; each PR/MR once", () => {
  const pr = (n: number, state: "merged" | "open", mergedAt?: string) => ({ url: `u${n}`, label: `#${n}`, state, mergedAt });
  assert.deepEqual(
    mergedAfter([pr(1, "merged", "2026-11-11T10:00:01Z"), pr(1, "merged", "2026-11-11T10:00:01Z"), pr(2, "merged", CREATED), pr(3, "merged"), pr(4, "open")], CREATED).map((p) => p.label),
    ["#1"],
  );
});

test("the board and the task screen show work merged outside the dashboard; the task stays todo", async () => {
  const s = await setup(undefined, {
    forge: new ForgeCli(async (command, args) =>
      command === "gh" && args[1] === "view"
        ? { code: 0, stdout: JSON.stringify({ number: 975, url: args[2], state: "MERGED", mergedAt: "2026-11-11T22:12:00Z", headRefName: "feat/member-roles", isCrossRepository: false }) }
        : { code: 0, stdout: "[]" },
    ),
  });
  try {
    s.f.external("ergo", (root) =>
      writeFileSync(
        join(root, "tasks", "TST-MRG01-member-roles.md"),
        `---\nid: TST-MRG01\ntype: task\ntitle: Member roles\nstatus: todo\nproject: core\nbranch: feat/member-roles\nlinks: ["https://github.com/acme/core/pull/975"]\ncreated: ${CREATED}\n---\n\n## Brief\n\nDo it.\n`,
      ),
    );
    await s.sync().sync();
    await s.dashboard.merged.checkAll();
    const board = await readBoard(s.ctx, {});
    const card = board.columns.flatMap((c) => c.tasks).find((t) => t.id === "TST-MRG01")!;
    assert.deepEqual(card.merged, [{ label: "#975", url: "https://github.com/acme/core/pull/975", merged_at: "2026-11-11T22:12:00Z" }]);
    assert.equal(board.columns.flatMap((c) => c.tasks).find((t) => t.id === "TST-FX001")!.merged, undefined, "left out when there is none");
    const view = taskView(s.dashboard, { task: "TST-MRG01" });
    assert.deepEqual([view.status, view.merged.map((m) => m.label), view.actions.close], ["todo", ["#975"], true], "Mark done is the person's");
    assert.equal(s.task("TST-MRG01")!.status, "todo");
  } finally {
    s.stop();
  }
});

test("JOBBY-7QK3T: a task in progress that no run holds is followed like a todo one; a live run's is not", async () => {
  const merged: Mr[] = [{ iid: 975, state: "merged", merged_at: "2026-11-11T22:12:00Z", branch: "feat/member-roles" }];
  const base = { project: "site", branch: "feat/member-roles", status: "in_progress" as const };
  const plan = planOf([
    { id: "ERG-M09A8", ...base },
    { id: "ERG-ENDED", ...base, run_id: "r-1", run_branch: "feat/member-roles", run_ended: "2026-11-12T10:00:00Z" },
    { id: "ERG-LIVE1", ...base, run_id: "r-2", run_branch: "feat/member-roles" },
    { id: "ERG-REVW1", ...base, status: "review" },
  ]);
  const candidate = (id: string) => mergedCandidates(plan, plan.entities.get(id)!.entity as Task);
  assert.notEqual(candidate("ERG-M09A8"), undefined);
  assert.notEqual(candidate("ERG-ENDED"), undefined, "its run ended: nothing follows its PR/MR any more");
  assert.equal(candidate("ERG-LIVE1"), undefined, "its live run's PR/MR is followed");
  assert.equal(candidate("ERG-REVW1"), undefined, "review with no run stays the owner's to accept");
  const { t } = tracker(plan, forge({ prj_site: merged }));
  await t.checkAll();
  assert.deepEqual(t.shown(plan, plan.entities.get("ERG-M09A8")!.entity as Task).map((pr) => pr.label), ["!975"]);
});
