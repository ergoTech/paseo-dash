import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpaceProject, Task } from "../../shared/model.ts";
import type { Plan } from "../plan/load.ts";
import type { SpaceSync } from "../sync/space-sync.ts";
import { reconcile, reconcileNext } from "../api/reconcile.ts";
import { planStart, startCheck } from "../api/reads.ts";
import { startPlan } from "../api/start-set.ts";
import { setup } from "../api/testing.ts";
import { closingReference, projectRepo } from "../issues/link.ts";
import { mergedSection } from "../runner/prompt.ts";
import { type CommandRunner, ForgeCli } from "./forge.ts";
import { idMatches, MergedTracker } from "./merged.ts";
import { seenHosts, webHostProblem, WebHosts } from "./web-host.ts";

/**
 * Work merged while its task stayed open (JOBBY-YV2QS, part 1). ERG-7MRG1 stayed todo after site
 * !412 merged: the MR names the task's id, but its branch chore/erg-7mrg1-start-signal-diagnostics
 * is not the planned one, so the branch lookup never found it. And GitLab issues on git.example.com
 * read as "on another forge" while the project's remote is git-ssh.example.com and no web_host is set.
 */

const CREATED = "2026-11-22T17:45:00Z";
const SITE = "https://git.example.com/frontend/site/-/merge_requests";
const COMPOSE = "https://git.example.com/build/docker-compose/-/merge_requests";

const projects = {
  site: { remote: "git@git-ssh.example.com:frontend/site.git", trunk: "master", web_host: "git.example.com" },
  compose: { remote: "git@git-ssh.example.com:build/docker-compose.git", trunk: "master", web_host: "git.example.com" },
};

function planOf(tasks: Partial<Task>[]): Plan {
  const entities = new Map(tasks.map((t) => [t.id!, { entity: { type: "task", status: "todo", depends_on: [], links: [], labels: [], requires: [], created: CREATED, ...t } as Task, acceptance: [] }]));
  return { space: { key: "ERG", projects }, entities, duplicates: new Set(), problems: [] } as unknown as Plan;
}

interface Mr {
  iid: number;
  state: "merged" | "opened";
  merged_at?: string;
  branch: string;
  title?: string;
  description?: string;
  sha?: string;
}

/** glab per checkout: `mr list --merged` lists each project's merges (all, or those a search names), `mr view` one. */
function forge(mrs: Record<string, Mr[]>, calls: string[] = []): ForgeCli {
  const run: CommandRunner = async (command, args, cwd) => {
    const where = cwd.split("/").pop()!;
    calls.push(`${where} ${command} ${args.join(" ")}`);
    const own = mrs[where];
    if (!own) return { code: 1, stdout: "" };
    const base = where === "prj_site" ? SITE : COMPOSE;
    const json = (mr: Mr) => ({
      iid: mr.iid,
      web_url: `${base}/${mr.iid}`,
      state: mr.state,
      merged_at: mr.merged_at ?? null,
      source_branch: mr.branch,
      source_project_id: 1,
      target_project_id: 1,
      title: mr.title ?? "",
      description: mr.description ?? "",
      merge_commit_sha: mr.sha ?? null,
    });
    if (args[1] === "list" && args.includes("--merged")) {
      const search = args.find((a) => a.startsWith("--search="))?.slice("--search=".length);
      const merged = own.filter((mr) => mr.state === "merged" && (!search || `${mr.title} ${mr.description}`.includes(search)));
      return { code: 0, stdout: JSON.stringify(merged.map(json)) };
    }
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(own.filter((mr) => mr.branch === args[3]).map(json)) };
    const mr = own.find((m) => String(m.iid) === args[2]);
    return mr ? { code: 0, stdout: JSON.stringify(json(mr)) } : { code: 1, stdout: "" };
  };
  return new ForgeCli(run);
}

function tracker(plan: Plan, cli: ForgeCli, closers: Record<string, string[]> = {}) {
  const sync = { plan } as unknown as SpaceSync;
  const space = { sync, mapping: { site: "prj_site", compose: "prj_compose" } as Record<string, string | null> };
  const t = new MergedTracker({ spaces: () => [space], projectRoot: (id) => `/roots/${id}`, forge: cli, issueClosers: (_plan, task) => closers[task.id] ?? [] });
  return { t, space };
}

const MR_412: Mr = {
  iid: 412,
  state: "merged",
  merged_at: "2026-11-22T23:38:00Z",
  branch: "chore/erg-7mrg1-start-signal-diagnostics",
  title: "chore: log why the start signal stays silent (ERG-7MRG1)",
  description: "Diagnostics for QA. Task ERG-7MRG1.",
  sha: "5e1f0c4a9b2d7e3f8a6c1d0b4e9f2a7c3b8d6e10",
};

test("ERG-7MRG1: a merged MR naming the task's id is found although its branch is not the planned one", async () => {
  const plan = planOf([{ id: "ERG-7MRG1", project: "site" }]);
  const { t } = tracker(plan, forge({ prj_site: [MR_412] }), {});
  await t.checkAll();
  const task = plan.entities.get("ERG-7MRG1")!.entity as Task;
  assert.deepEqual(t.shown(plan, task), [
    {
      label: "!412",
      url: `${SITE}/412`,
      merged_at: "2026-11-22T23:38:00Z",
      sha: "5e1f0c4a9b2d7e3f8a6c1d0b4e9f2a7c3b8d6e10",
      branch: "chore/erg-7mrg1-start-signal-diagnostics",
      by: ["id_in_title", "id_in_description", "id_in_branch"],
    },
  ]);
  assert.equal(task.status, "todo", "nothing changes the task by itself");
});

test("a screen's or reconcile's read of one task searches the forge for its id beyond the latest merges", async () => {
  const plan = planOf([{ id: "ERG-7MRG1", project: "site" }]);
  const calls: string[] = [];
  const { t, space } = tracker(plan, forge({ prj_site: [MR_412] }, calls));
  await t.check(space, plan.entities.get("ERG-7MRG1")!.entity as Task);
  assert.ok(calls.some((c) => c.includes("--search=ERG-7MRG1")), calls.join("\n"));
  assert.equal(t.shown(plan, plan.entities.get("ERG-7MRG1")!.entity as Task)[0]?.label, "!412");
});

test("an id is a whole token: a longer id or a word around it is another task", () => {
  const pr = (title: string, head = "x") => ({ title, body: "", head });
  assert.deepEqual(idMatches(pr("fix ERG-7MRG1A"), "ERG-7MRG1"), []);
  assert.deepEqual(idMatches(pr("fix XERG-7MRG1"), "ERG-7MRG1"), []);
  assert.deepEqual(idMatches(pr("fix (ERG-7MRG1)"), "ERG-7MRG1"), ["id_in_title"]);
  assert.deepEqual(idMatches(pr("x", "chore/erg-7mrg1-diagnostics"), "ERG-7MRG1"), ["id_in_branch"]);
});

test("the same issue number in another repository ties nothing; the forge's closer of the task's own issue in its project does", async () => {
  const plan = planOf([
    // site's issue #44; compose has its own #44 and an MR closing it.
    { id: "ERG-SITE1", project: "site", issue: "https://git.example.com/frontend/site/-/issues/44" },
    { id: "ERG-COMP1", project: "compose", issue: "https://git.example.com/build/docker-compose/-/issues/44" },
  ]);
  const compose: Mr[] = [{ iid: 7, state: "merged", merged_at: "2026-11-23T10:00:00Z", branch: "fix/thing", title: "Fix the thing", description: "Closes #44" }];
  const closers = {
    // The forge says compose !7 closed compose#44, and nothing closed site#44 yet.
    "ERG-COMP1": [`${COMPOSE}/7`],
    // A closer URL of another repository never counts for a task of site.
    "ERG-SITE1": [`${COMPOSE}/7`],
  };
  const { t } = tracker(plan, forge({ prj_site: [], prj_compose: compose }), closers);
  await t.checkAll();
  const shown = (id: string) => t.shown(plan, plan.entities.get(id)!.entity as Task);
  assert.deepEqual(shown("ERG-SITE1"), [], "site's #44 is another issue; 'Closes #44' in compose and its closer tie nothing to it");
  assert.deepEqual(shown("ERG-COMP1").map((pr) => [pr.label, pr.by]), [["!7", ["closes_issue"]]], "the forge's own closer of compose#44, in compose");
});

test("merged code with open acceptance is not done: the next step names what is left and forbids a second implementation", () => {
  const merged = [{ label: "!412", url: `${SITE}/412`, merged_at: "2026-11-22T23:38:00Z", sha: "5e1f0c4a9b2d", branch: "chore/erg-7mrg1", by: ["id_in_title" as const] }];
  const next = reconcileNext(merged, [{ done: true }, { done: false }, { done: false }]);
  assert.match(next, /2 of 3 acceptance lines are open/);
  assert.match(next, /never to redo the merged work/);
  assert.doesNotMatch(next, /mark it done after a look/);
  assert.match(reconcileNext(merged, [{ done: true }]), /every acceptance line is ticked: mark it done after a look/);
  const section = mergedSection(merged);
  assert.match(section, /## Already merged/);
  assert.match(section, /Do not implement it again/);
  assert.match(section, /5e1f0c4a9b2d/);
});

test("a start of a task with merged work says it, start_plan waits for the owner, and the autopilot's start is refused", async () => {
  const s = await setup(undefined, {
    forge: new ForgeCli(async (command, args) => {
      if (command === "gh" && args[1] === "list" && args.includes("merged")) {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              number: 41,
              url: "https://github.com/acme/core/pull/41",
              state: "MERGED",
              mergedAt: "2026-11-23T10:00:00Z",
              headRefName: "fix/some-other-name",
              isCrossRepository: false,
              title: "Fix the login (TST-MRG02)",
              body: "",
              mergeCommit: { oid: "abc1234def5678" },
            },
          ]),
        };
      }
      return { code: 0, stdout: "[]" };
    }),
  });
  try {
    s.f.external("ergo", (root) =>
      writeFileSync(
        join(root, "tasks", "TST-MRG02-login.md"),
        `---\nid: TST-MRG02\ntype: task\ntitle: Login\nstatus: todo\nproject: core\ncreated: 2026-11-20T10:00:00Z\n---\n\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [x] Code\n- [ ] QA on stage\n`,
      ),
    );
    await s.sync().sync();
    await s.dashboard.merged.checkAll();
    const check = await startCheck(s.ctx, { task: "TST-MRG02" });
    assert.equal(check.decision, "needs_owner");
    assert.match(check.human, /merged already: #41 \(abc1234\) on fix\/some-other-name/);
    assert.match(check.next, /1 of 2 acceptance lines are open/);
    const plan = await startPlan(s.ctx, { tasks: ["TST-MRG02"] });
    assert.equal(plan.tasks[0]?.needs, "merged");
    const automatic = await planStart(s.ctx, { task: "TST-MRG02" }, { automatic: true });
    assert.ok(!("found" in automatic) && /merged already/.test(automatic.error), "nothing starts it on its own");
    const read = await reconcile(s.ctx, {});
    assert.deepEqual(read.tasks.map((r) => [r.id, r.merged[0]?.sha, r.left]), [["TST-MRG02", "abc1234def5678", ["QA on stage"]]]);
    assert.equal(s.task("TST-MRG02")!.status, "todo");
  } finally {
    s.stop();
  }
});

test("a GitLab project's web host is the forge's web_url host, never a host that looks alike", async () => {
  const project: SpaceProject = { remote: "git@git-ssh.example.com:frontend/site.git", trunk: "master", color: undefined, group: undefined, web_host: undefined };
  const plan = { space: { key: "ERG", projects: { site: project } }, entities: new Map(), duplicates: new Set(), problems: [] } as unknown as Plan;
  const asked: string[] = [];
  const cli = new ForgeCli(async (command, args) => {
    asked.push(args.join(" "));
    if (command === "glab" && args[0] === "api" && args[2] === "git-ssh.example.com") {
      return { code: 0, stdout: JSON.stringify({ web_url: "https://git.example.com/frontend/site", ssh_url_to_repo: "git@git-ssh.example.com:frontend/site.git" }) };
    }
    return { code: 1, stdout: "" };
  });
  const hosts = new WebHosts({ forge: cli, cwd: () => "/tmp" });
  assert.equal(hosts.peek(plan, "site", project)?.served, "", "unknown before the forge answered");
  await hosts.check(project);
  const verdict = hosts.peek(plan, "site", project)!;
  assert.deepEqual([verdict.used, verdict.served], ["git-ssh.example.com", "git.example.com"]);
  assert.match(webHostProblem("site", verdict), /Set its web host to git\.example\.com/);
  assert.ok(asked[0]!.includes("projects/frontend%2Fsite"));
  // Set as the forge says: nothing is wrong.
  assert.equal(webHostProblem("site", { ...verdict, used: "git.example.com" }), "");
});

test("without a forge's answer, the plan's links say which host to check, said as unchecked; another repository's links are not counted", () => {
  const project: SpaceProject = { remote: "git@git-ssh.example.com:frontend/site.git", trunk: undefined, color: undefined, group: undefined, web_host: undefined };
  const entities = new Map(
    [
      { id: "ERG-A0001", project: "site", issue: "https://git.example.com/frontend/site/-/issues/44", links: [] },
      { id: "ERG-A0002", project: "site", links: ["https://git.example.com/frontend/site/-/merge_requests/9"] },
      { id: "ERG-A0003", project: "site", issue: "https://git.other.example/build/other/-/issues/44", links: [] },
    ].map((t) => [t.id, { entity: { type: "task", status: "todo", labels: [], depends_on: [], ...t } }]),
  );
  const plan = { space: { projects: { site: project } }, entities } as unknown as Plan;
  assert.deepEqual(seenHosts(plan, "site", project), ["git.example.com"]);
  const problem = webHostProblem("site", { remoteHost: "git-ssh.example.com", used: "git-ssh.example.com", served: "", seen: ["git.example.com"], at: "" });
  assert.match(problem, /the forge did not confirm either/);
  assert.match(problem, /Check that https:\/\/git\.example\.com serves the same repository/);
});

test("a host only the plan's links name is never asked: glab would send the daemon's token there", async () => {
  const project: SpaceProject = { remote: "git@git-ssh.example.com:frontend/site.git", trunk: "master", color: undefined, group: undefined, web_host: undefined };
  const entities = new Map(
    [{ id: "ERG-A0001", project: "site", issue: "https://attacker.example/frontend/site/-/issues/1", links: [] }].map((t) => [
      t.id,
      { entity: { type: "task", status: "todo", labels: [], depends_on: [], ...t } },
    ]),
  );
  const plan = { space: { key: "ERG", projects: { site: project } }, entities, duplicates: new Set(), problems: [] } as unknown as Plan;
  const hostsAsked: string[] = [];
  const cli = new ForgeCli(async (command, args) => {
    if (command === "glab" && args[0] === "api") hostsAsked.push(args[2]!);
    return { code: 1, stdout: "" };
  });
  const hosts = new WebHosts({ forge: cli, cwd: () => "/tmp" });
  assert.deepEqual(hosts.peek(plan, "site", project)?.seen, ["attacker.example"], "the link's host is reported");
  await hosts.check(project);
  assert.deepEqual(hostsAsked, ["git-ssh.example.com"], "only the remote's host is asked");
});

test("start_check's issue fact names the web host to check when only the host differs", () => {
  const repo = projectRepo({ remote: "git@git-ssh.example.com:frontend/site.git" })!;
  const reason = closingReference({ forge: "gitlab", host: "git.example.com", repo: "frontend/site", number: 44, url: "https://git.example.com/frontend/site/-/issues/44" }, repo);
  assert.ok(!reason.ok && /set the project's web host to git\.example\.com in Projects/.test(reason.reason));
  const other = closingReference({ forge: "gitlab", host: "git.other.example", repo: "a/b", number: 1, url: "https://git.other.example/a/b/-/issues/1" }, repo);
  assert.ok(!other.ok && !/web host/.test(other.reason), "another repository: no such advice");
});
