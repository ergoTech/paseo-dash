import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectCheckout, setup } from "../api/testing.ts";
import type { FakePaseoOptions } from "../runner/testing.ts";
import { createGithubRepo, type Shell } from "./github.ts";
import { addProject, cloneProject, cloneTarget, listProjects, mapProject, moveProject, removeProject, updateProject } from "./projects.ts";
import { suggestKey } from "../../shared/projects.ts";
import { PLAN_TOPIC } from "../../shared/sharing.ts";
import { remoteLog } from "../sync/testing.ts";

/** A checkout whose origin is `url` and whose `origin/HEAD` names `trunk`, without any network. */
function checkout(url: string, trunk = "develop"): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-candidate-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "--quiet", "-b", trunk);
  git("remote", "add", "origin", url);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "init");
  git("update-ref", `refs/remotes/origin/${trunk}`, "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${trunk}`);
  return dir;
}

const project = (projectId: string, root: string): NonNullable<FakePaseoOptions["projects"]>[number] => ({
  projectId,
  projectDisplayName: root.split("/").pop()!,
  projectKind: "git",
  projectRootPath: root,
});

test("a Paseo project becomes a line: suggested key, its own trunk, the next free color, comments kept", async () => {
  const fresh = checkout("git@github.com:acme/New_Thing.git");
  const { ctx, sync, fake, remoteFile, stop } = await setup({ projects: [project("prj_new", fresh)] });
  try {
    const before = await listProjects(ctx, fake.api(), { space: "tst" });
    assert.equal(before.error, "");
    assert.deepEqual(
      before.candidates.map((c) => [c.project_id, c.key, c.trunk, c.remote]),
      [["prj_new", "new_thing", "develop", "git@github.com:acme/New_Thing.git"]],
    );
    assert.equal(before.clone_parent, dirname(fresh));
    const added = await addProject(ctx, { space: "TST", key: "new_thing", remote: "git@github.com:acme/New_Thing.git" });
    assert.deepEqual(added, { ok: true, key: "new_thing", error: "" });
    // core and site draw the first two palette colors by default, so those count as taken.
    assert.deepEqual(sync().plan.space!.projects.new_thing, { remote: "git@github.com:acme/New_Thing.git", trunk: "develop", color: "#30a46c" });
    const text = (await remoteFile(/^space\.yaml$/))!;
    assert.match(text, /# projects keep their order on the map/, "comments survive the edit");
    assert.match(text, /^ {2}new_thing: \{ remote: git@github\.com:acme\/New_Thing\.git, trunk: develop, color: "#30a46c" \}$/m);
    // The lines that drew default colors get them written, so the new line cannot shift them later.
    assert.match(text, /^ {2}core: \{ remote: git@github\.com:acme\/core\.git, trunk: main, color: "#3e8eed" \}$/m);
    assert.match(text, /^ {2}site: \{ remote: git@github\.com:acme\/site\.git, color: "#e5484d" \}$/m, "other entries keep their form");

    const after = await listProjects(ctx, fake.api(), { space: "TST" });
    assert.deepEqual(after.candidates, []);
    const line = after.projects.find((p) => p.key === "new_thing")!;
    assert.equal(line.local?.project_id, "prj_new");
    assert.equal(line.color_set, true);
  } finally {
    stop();
  }
});

test("adding refuses bad keys, taken keys, listed remotes and remotes git must never see", async () => {
  const { ctx, sync, stop } = await setup();
  try {
    const before = JSON.stringify(sync().plan.space);
    const cases: [string, string, RegExp][] = [
      ["New", "https://github.com/acme/new", /not a project key/],
      ["core", "https://github.com/acme/other", /already lists core/],
      ["again", "https://github.com/acme/core", /already listed as core/],
      ["evil", "ext::sh -c touch% /tmp/pwned", /not a clone URL/],
      ["opt", "-oProxyCommand=touch /tmp/pwned", /not a clone URL/],
      ["local", "/srv/repos/core", /not a clone URL/],
      ["dash", "-oProxyCommand@host:x", /not a clone URL/],
    ];
    for (const [key, remote, error] of cases) {
      const answer = await addProject(ctx, { space: "TST", key, remote, trunk: "main" });
      assert.equal(answer.ok, false, `${key} ${remote}`);
      assert.match(answer.error, error);
    }
    assert.match((await addProject(ctx, { space: "TST", key: "x", remote: "https://github.com/acme/x", trunk: "main", color: "blue" })).error, /not a color/);
    assert.match((await addProject(ctx, { space: "TST", key: "x", remote: "https://github.com/acme/x", trunk: "-main" })).error, /not a usable branch/);
    assert.equal(JSON.stringify(sync().plan.space), before, "nothing was written");
  } finally {
    stop();
  }
});

test("color, group and trunk change; lines move; a project with open tasks stays", async () => {
  const { ctx, sync, stop } = await setup();
  const projects = () => sync().plan.space!.projects;
  try {
    assert.deepEqual(await updateProject(ctx, { space: "TST", project: "site", color: "#12AB34", group: "Web" }), { ok: true, error: "" });
    assert.equal(projects().site!.color, "#12ab34");
    assert.equal(projects().site!.group, "Web");
    await updateProject(ctx, { space: "TST", project: "site", group: "" });
    assert.equal(projects().site!.group, undefined, "an empty group clears it");
    assert.equal(projects().site!.color, "#12ab34", "fields not named stay");
    assert.match((await updateProject(ctx, { space: "TST", project: "site", color: "blue" })).error, /not a color/);
    assert.match((await updateProject(ctx, { space: "TST", project: "nope", color: "#000000" })).error, /lists no project nope/);
    for (const project of ["toString", "constructor"]) {
      assert.match((await removeProject(ctx, { space: "TST", project })).error, /lists no project/, project);
      assert.match((await updateProject(ctx, { space: "TST", project, group: "x" })).error, /lists no project/, project);
    }

    assert.equal((await moveProject(ctx, { space: "TST", project: "site", offset: -1 })).ok, true);
    assert.deepEqual(Object.keys(projects()), ["site", "core"]);
    assert.deepEqual(await moveProject(ctx, { space: "TST", project: "site", offset: -1 }), { ok: true, error: "" }, "the first line cannot go higher");
    assert.deepEqual(Object.keys(projects()), ["site", "core"]);

    const refused = await removeProject(ctx, { space: "TST", project: "site" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /1 open task\(s\) use site: TST-ST001/);
    await addProject(ctx, { space: "TST", key: "tmp", remote: "https://github.com/acme/tmp", trunk: "main" });
    assert.deepEqual(await removeProject(ctx, { space: "TST", project: "tmp" }), { ok: true, error: "" });
    assert.equal(projects().tmp, undefined);
  } finally {
    stop();
  }
});

test("a project maps by hand to a Paseo project with another remote, and back", async () => {
  const fork = checkout("git@github.com:me/core-fork.git");
  const { ctx, fake, stop } = await setup({ projects: [project("prj_fork", fork)] });
  const core = async () => (await listProjects(ctx, fake.api(), { space: "TST" })).projects.find((p) => p.key === "core")!;
  try {
    assert.equal((await core()).local, null);
    assert.deepEqual(await mapProject(ctx, fake.api(), { space: "TST", project: "core", local_project: "prj_fork" }), { ok: true, error: "" });
    assert.equal((await core()).local?.project_id, "prj_fork");
    assert.equal((await core()).override, true);
    assert.match((await mapProject(ctx, fake.api(), { space: "TST", project: "core", local_project: "prj_gone" })).error, /no project prj_gone/);
    await mapProject(ctx, fake.api(), { space: "TST", project: "core", local_project: "" });
    assert.equal((await core()).local, null);
  } finally {
    stop();
  }
});

test("a missing project is cloned, opened in Paseo and mapped by its remote", async () => {
  const origin = `file://${join(dirname(projectCheckout()), "origin.git")}`;
  const { ctx, fake, stop } = await setup({ projects: [] });
  try {
    assert.equal((await addProject(ctx, { space: "TST", key: "lib", remote: origin, trunk: "main" })).ok, true);
    const parent = mkdtempSync(join(tmpdir(), "dashboard-clone-"));
    assert.throws(() => cloneTarget(ctx, { space: "TST", project: "lib", directory: "relative/lib" }), /absolute path/);
    assert.throws(() => cloneTarget(ctx, { space: "TST", project: "lib", directory: parent }), /already exists/);
    assert.throws(() => cloneTarget(ctx, { space: "TST", project: "lib", directory: join(parent, "no", "lib") }), /is not a directory/);
    const target = cloneTarget(ctx, { space: "TST", project: "lib", directory: join(parent, "lib") });
    await cloneProject(ctx, fake.api(), target);
    assert.ok(existsSync(join(parent, "lib", ".git")));
    assert.deepEqual(fake.opened, [join(parent, "lib")]);
    const lib = (await listProjects(ctx, fake.api(), { space: "TST" })).projects.find((p) => p.key === "lib")!;
    assert.equal(lib.local?.root, join(parent, "lib"));
  } finally {
    stop();
  }
});

test("suggested keys are lower case, start with a letter and do not collide", () => {
  assert.equal(suggestKey("git@github.com:acme/Mobile_App.git", []), "mobile_app");
  assert.equal(suggestKey("https://github.com/acme/core", ["core"]), "core-2");
  assert.equal(suggestKey("https://github.com/acme/core", ["core", "core-2"]), "core-3");
  assert.equal(suggestKey("https://github.com/acme/123.paseo.plugin", []), "paseo-plugin");
  assert.equal(suggestKey("https://github.com/acme/...", []), "project");
});

test("the plan repository is created private on GitHub with the plan topic, cloned over the protocol gh is set to", async () => {
  const calls: string[][] = [];
  const shell =
    (protocol: string, fail = "", topicFails = false): Shell =>
    async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "repo" && args[1] === "create") return fail ? { code: 1, stdout: "", stderr: `${fail}\n` } : { code: 0, stdout: "https://github.com/me/plan\n", stderr: "" };
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "me/plan", sshUrl: "git@github.com:me/plan.git", url: "https://github.com/me/plan" }), stderr: "" };
      if (args[0] === "repo" && args[1] === "edit") return topicFails ? { code: 1, stdout: "", stderr: "HTTP 403\n" } : { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: `${protocol}\n`, stderr: "" };
    };
  assert.deepEqual(await createGithubRepo("me/plan", shell("ssh")), { remote: "git@github.com:me/plan.git", warning: "" });
  assert.deepEqual(calls[0], ["gh", "repo", "create", "me/plan", "--private", "--description", "Plan of Paseo Dash"]);
  assert.deepEqual(calls[2], ["gh", "repo", "edit", "me/plan", "--add-topic", PLAN_TOPIC]);
  calls.length = 0;
  assert.equal((await createGithubRepo("plan", shell("https"))).remote, "https://github.com/me/plan.git");
  assert.deepEqual(calls[2], ["gh", "repo", "edit", "me/plan", "--add-topic", PLAN_TOPIC], "the topic goes to the full name gh reported");
  const untagged = await createGithubRepo("me/plan", shell("ssh", "", true));
  assert.equal(untagged.remote, "git@github.com:me/plan.git", "a topic that failed does not undo the repository");
  assert.match(untagged.warning, /without the topic paseo-dashboard-plan.*HTTP 403.*gh repo edit me\/plan --add-topic paseo-dashboard-plan/);
  await assert.rejects(createGithubRepo("me/plan", shell("ssh", "GraphQL: Name already exists on this account")), /gh repo create failed: GraphQL: Name already exists/);
  const before = calls.length;
  await assert.rejects(createGithubRepo("me/plan --public", shell("ssh")), /not a GitHub repository name/);
  await assert.rejects(createGithubRepo("me/.hidden", shell("ssh")), /not a GitHub repository name/);
  await assert.rejects(createGithubRepo("--public", shell("ssh")), /not a GitHub repository name/);
  assert.equal(calls.length, before, "a bad name never reaches gh");
});

test("a write in a fresh process keeps the stored mapping until Paseo's projects are read", async () => {
  const { ctx, dashboard, stop } = await setup();
  try {
    const record = dashboard.spaces.get("TST")!.record;
    assert.equal(record.mapping.core, "prj_core");
    // A new process: the stored mapping is there, the list of local projects is not yet.
    (dashboard as unknown as { local: unknown }).local = undefined;
    assert.equal((await updateProject(ctx, { space: "TST", project: "site", group: "Web" })).ok, true);
    assert.equal(record.mapping.core, "prj_core", "not recomputed against an empty list");
  } finally {
    stop();
  }
});

test("moving or removing a line keeps every other line's color", async () => {
  const { ctx, sync, stop } = await setup();
  const colors = () => Object.fromEntries(Object.entries(sync().plan.space!.projects).map(([key, p]) => [key, p.color]));
  try {
    assert.deepEqual(colors(), { core: undefined, site: undefined }, "both draw defaults by their place");
    assert.equal((await moveProject(ctx, { space: "TST", project: "site", offset: -1 })).ok, true);
    assert.deepEqual(colors(), { site: "#e5484d", core: "#3e8eed" }, "the colors they drew before the move are written");
    await addProject(ctx, { space: "TST", key: "tmp", remote: "https://github.com/acme/tmp", trunk: "main" });
    assert.equal(colors().tmp, "#30a46c");
    assert.deepEqual(await removeProject(ctx, { space: "TST", project: "tmp" }), { ok: true, error: "" });
    assert.deepEqual(colors(), { site: "#e5484d", core: "#3e8eed" });
  } finally {
    stop();
  }
});

test("git projects without a usable origin are named, so they can be added by URL", async () => {
  const bare = mkdtempSync(join(tmpdir(), "dashboard-no-origin-"));
  execFileSync("git", ["init", "--quiet", bare]);
  const { ctx, fake, stop } = await setup({ projects: [project("prj_ios", bare)] });
  try {
    const list = await listProjects(ctx, fake.api(), { space: "TST" });
    assert.deepEqual(list.no_remote, [{ name: bare.split("/").pop()!, root: bare }]);
    assert.deepEqual(list.candidates, []);
  } finally {
    stop();
  }
});

test("recoloring one line keeps the others' colors; two checkouts of one repository are one candidate", async () => {
  const one = checkout("git@github.com:acme/twin.git");
  const two = checkout("https://github.com/acme/twin");
  const { ctx, sync, fake, stop } = await setup({ projects: [project("prj_a", one), project("prj_b", two)] });
  const colors = () => Object.fromEntries(Object.entries(sync().plan.space!.projects).map(([key, p]) => [key, p.color]));
  try {
    assert.equal((await updateProject(ctx, { space: "TST", project: "core", color: "#e5484d" })).ok, true);
    assert.deepEqual(colors(), { core: "#e5484d", site: "#e5484d" }, "site keeps the color it drew, even if core now names it too");
    const list = await listProjects(ctx, fake.api(), { space: "TST" });
    assert.deepEqual(list.candidates.map((c) => c.project_id), ["prj_a"]);
  } finally {
    stop();
  }
});

test("a refused change of the lines writes nothing, not even the colors it would pin", async () => {
  const { f, ctx, sync, stop } = await setup();
  const colors = () => Object.fromEntries(Object.entries(sync().plan.space!.projects).map(([key, p]) => [key, p.color]));
  try {
    await sync().sync();
    const commits = remoteLog(f.remote).length;
    const refused = await removeProject(ctx, { space: "TST", project: "site" });
    assert.match(refused.error, /1 open task\(s\) use site/);
    assert.deepEqual(await updateProject(ctx, { space: "TST", project: "site", group: "" }), { ok: true, error: "" }, "nothing to change");
    assert.deepEqual(colors(), { core: undefined, site: undefined }, "both still draw defaults");
    assert.equal(sync().state.pending, 0, "nothing left in the journal");
    await sync().sync();
    assert.equal(remoteLog(f.remote).length, commits, "no commit");
    assert.deepEqual(sync().state.conflicts, []);
  } finally {
    stop();
  }
});
