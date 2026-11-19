import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setup } from "../api/testing.ts";
import { describeDashboard } from "../capabilities.ts";
import contribute from "../../index.server.ts";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { GITHUB_ORG_ROLES, GITLAB_ROLES, inviteSentence, PLAN_TOPIC, removeSentence, sharingInviteRpc, sharingRemoveRpc, suggestPersonKey } from "../../shared/sharing.ts";
import { availablePlans } from "./discover.ts";
import type { Shell, ShellResult } from "./github.ts";
import { checkSpace, invite, readSharing, removeAccess, targetOf } from "./sharing.ts";

/** A fake gh and glab: the first route whose pattern matches the joined command line answers. */
function fakeShell(routes: [RegExp, Partial<ShellResult>][]): { shell: Shell; calls: string[][] } {
  const calls: string[][] = [];
  const shell: Shell = async (command, args) => {
    calls.push([command, ...args]);
    const line = [command, ...args].join(" ");
    const route = routes.find(([pattern]) => pattern.test(line));
    if (!route) return { code: 1, stdout: "", stderr: `no route for ${line}` };
    return { code: 0, stdout: "", stderr: "", ...route[1] };
  };
  return { shell, calls };
}

const json = (value: unknown): Partial<ShellResult> => ({ stdout: JSON.stringify(value) });
const ndjson = (values: unknown[]): Partial<ShellResult> => ({ stdout: values.map((v) => JSON.stringify(v)).join("\n") + "\n" });

const ghRepo = (full: string, topics: string[], description = "") => ({
  full_name: full,
  ssh_url: `git@github.com:${full}.git`,
  clone_url: `https://github.com/${full}.git`,
  html_url: `https://github.com/${full}`,
  description,
  topics,
});
const glabProject = (path: string, topics: string[]) => ({
  path_with_namespace: path,
  ssh_url_to_repo: `git@git-ssh.example.work:${path}.git`,
  http_url_to_repo: `https://git.example.work/${path}.git`,
  web_url: `https://git.example.work/${path}`,
  description: null,
  topics,
});

test("discovery lists only plan repositories with the topic that are not connected yet", async () => {
  const { shell, calls } = fakeShell([
    [
      /^gh api --paginate user\/repos/,
      ndjson([
        ghRepo("acme/plan", [PLAN_TOPIC, "other"], "Acme's plan"),
        ghRepo("acme/app", ["android"]),
        ghRepo("me/plan", [PLAN_TOPIC]),
        { ...ghRepo("acme/untagged", []), topics: null },
      ]),
    ],
    [/^gh config get git_protocol/, { stdout: "ssh\n" }],
    [/^glab auth status/, { code: 1, stderr: "gitlab.com\n  x gitlab.com: API call failed: 401\ngit.example.work\n  ✓ Logged in to git.example.work as me (config.yml)\ngit-ssh.example.work\n  ✓ Logged in to git-ssh.example.work as me (config.yml)\n" }],
    [/^glab api --hostname git(-ssh)?\.example\.work --paginate projects\?topic=paseo-dashboard-plan/, json([glabProject("team/plan", [PLAN_TOPIC]), glabProject("team/site", [])])],
    [/^glab config get git_protocol --host/, { stdout: "ssh\n" }],
  ]);
  // me/plan is connected over HTTPS here; GitHub reports it over SSH.
  const found = await availablePlans(["https://github.com/me/plan"], shell);
  assert.deepEqual(found.notes, []);
  assert.deepEqual(
    found.plans.map((p) => [p.forge, p.host, p.path, p.remote]),
    [
      ["github", "github.com", "acme/plan", "git@github.com:acme/plan.git"],
      ["gitlab", "git.example.work", "team/plan", "git@git-ssh.example.work:team/plan.git"],
    ],
    "the topic decides, the connected one is left out, and one GitLab instance under two names shows its project once",
  );
  assert.equal(found.plans[0]!.description, "Acme's plan");
  assert.ok(calls.every(([, ...args]) => !args.includes("-X") && !args.includes("POST")), "discovery only reads");

  assert.match(calls.find((c) => c[0] === "gh" && c[2] === "--paginate")!.at(-1)!, /select\(\(\.topics \/\/ \[\]\) \| index\("paseo-dashboard-plan"\)\)/, "gh keeps only topic repositories");

  // A GitLab space connected over its HTTPS URL hides the project offered over SSH; case does not count.
  const again = await availablePlans(["https://git.example.work/Team/Plan.git", "git@github.com:ACME/plan.git", "git@github.com:me/plan.git"], shell);
  assert.deepEqual(again.plans, []);
});

test("discovery says which forge it could not search, and offers HTTPS where the CLI is set to it", async () => {
  const { shell } = fakeShell([
    [/^gh api --paginate user\/repos/, { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" }],
    [/^glab auth status/, { stdout: "  ✓ Logged in to git.example.work as me\n" }],
    [/^glab api --hostname git\.example\.work --paginate projects/, json([glabProject("team/plan", [PLAN_TOPIC])])],
    [/^glab config get git_protocol --host git\.example\.work/, { stdout: "https\n" }],
  ]);
  const found = await availablePlans([], shell);
  assert.deepEqual(found.notes, ["GitHub not searched: To get started with GitHub CLI, please run:  gh auth login"]);
  assert.deepEqual(
    found.plans.map((p) => p.remote),
    ["https://git.example.work/team/plan.git"],
  );
});

test("a plan remote names its forge repository; anything else is not shared from here", () => {
  assert.deepEqual(targetOf("git@github.com:acme/plan.git"), { forge: "github", owner: "acme", name: "plan" });
  assert.deepEqual(targetOf("https://github.com/acme/plan"), { forge: "github", owner: "acme", name: "plan" });
  assert.deepEqual(targetOf("git@git-ssh.example.work:team/sub/plan.git"), { forge: "gitlab", host: "git-ssh.example.work", path: "team/sub/plan" });
  assert.equal(targetOf("/tmp/remote.git"), undefined);
  assert.equal(targetOf("https://github.com/acme/../x"), undefined);
  assert.equal(targetOf("https://github.com/acme/plan/extra"), undefined);
});

/** A space whose plan repository is `remote`, with the TST fixture behind it. */
async function space(remote: string) {
  const env = await setup();
  env.dashboard.spaces.get("TST")!.record.remote = remote;
  return env;
}

const people = (env: Awaited<ReturnType<typeof setup>>) => env.sync().plan.space!.people;

test("GitHub organisation: invite with a role, then the person is in People; remove is the reverse call", async () => {
  const env = await space("git@github.com:acme/plan.git");
  try {
    const { shell, calls } = fakeShell([
      [/^gh api repos\/acme\/plan$/, json({ owner: { login: "acme", type: "Organization" } })],
      [/^gh api -X PUT repos\/acme\/plan\/collaborators\/anna-k -f permission=push$/, json({ id: 7, invitee: { login: "anna-k" } })],
      [/^gh api -X DELETE repos\/acme\/plan\/collaborators\/anna-k$/, {}],
    ]);
    const answer = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "tst", who: "anna-k", role: "write", person_name: "Anna", confirmed: true }), shell);
    assert.deepEqual(answer, { ok: true, error: "", sent: "invited", person: "anna-k", warning: "" });
    assert.deepEqual(calls, [
      ["gh", "api", "repos/acme/plan"],
      ["gh", "api", "-X", "PUT", "repos/acme/plan/collaborators/anna-k", "-f", "permission=push"],
    ]);
    assert.deepEqual(people(env)["anna-k"], { name: "Anna", emails: [], github: "anna-k", gitlab: {} });
    assert.match((await env.remoteFile(/^space\.yaml$/))!, /anna-k:[\s\S]*github: anna-k/, "the person reached the plan repository");

    // A second invitation of someone People already holds leaves People alone.
    const again = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "Anna-K", role: "write", person_key: "other", confirmed: true }), fakeShell([
      [/^gh api repos\/acme\/plan$/, json({ owner: { login: "acme", type: "Organization" } })],
      [/collaborators\/Anna-K/, { stdout: "" }],
    ]).shell);
    assert.deepEqual(again, { ok: true, error: "", sent: "added", person: "anna-k", warning: "" }, "204: access without an invitation");
    assert.equal(people(env).other, undefined);

    calls.length = 0;
    assert.deepEqual(await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "member", who: "anna-k", confirmed: true }), shell), { ok: true, error: "" });
    assert.deepEqual(calls, [["gh", "api", "-X", "DELETE", "repos/acme/plan/collaborators/anna-k"]]);
    assert.ok(people(env)["anna-k"], "their People entry stays");
  } finally {
    env.stop();
  }
});

test("GitHub user repository: a collaborator without a role; an organisation's role is required", async () => {
  const env = await space("https://github.com/me/plan.git");
  try {
    const user = fakeShell([
      [/^gh api repos\/me\/plan$/, json({ owner: { login: "me", type: "User" } })],
      [/^gh api -X PUT repos\/me\/plan\/collaborators\/bob$/, json({ id: 9 })],
    ]);
    const answer = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "bob", confirmed: true }), user.shell);
    assert.equal(answer.ok, true, answer.error);
    assert.deepEqual(user.calls[1], ["gh", "api", "-X", "PUT", "repos/me/plan/collaborators/bob"], "no permission field");
    const withRole = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "carl", role: "read", confirmed: true }), user.shell);
    assert.match(withRole.error, /owned by a user has no roles/);

    const org = fakeShell([[/^gh api repos\/me\/plan$/, json({ owner: { login: "acme", type: "Organization" } })]]);
    const noRole = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "carl", confirmed: true }), org.shell);
    assert.match(noRole.error, /Choose a role: write, triage, read/);
    assert.equal(org.calls.length, 1, "nothing was sent");
  } finally {
    env.stop();
  }
});

test("GitHub: a pending invitation is withdrawn by its id; the owner cannot be removed", async () => {
  const env = await space("git@github.com:me/plan.git");
  try {
    const { shell, calls } = fakeShell([
      [/^gh api repos\/me\/plan$/, json({ owner: { login: "me", type: "User" } })],
      [/^gh api --paginate repos\/me\/plan\/collaborators/, ndjson([{ login: "me", name: "Me", role_name: "admin" }, { login: "bob", name: null, role_name: "write" }])],
      [/^gh api --paginate repos\/me\/plan\/invitations/, ndjson([{ id: 41, login: "dana", permissions: "write" }])],
      [/^gh api -X DELETE repos\/me\/plan\/invitations\/41$/, {}],
    ]);
    const read = await readSharing(env.ctx, { space: "TST" }, shell);
    assert.equal(read.ok, true, read.error);
    assert.deepEqual(read.roles, []);
    assert.deepEqual(
      read.members.map((m) => [m.kind, m.who, m.role, m.removable]),
      [
        ["member", "me", "admin", false],
        ["member", "bob", "write", true],
        ["invitation", "dana", "write", true],
      ],
    );
    calls.length = 0;
    assert.deepEqual(await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "invitation", who: "dana", confirmed: true }), shell), { ok: true, error: "" });
    assert.deepEqual(calls.at(-1), ["gh", "api", "-X", "DELETE", "repos/me/plan/invitations/41"]);
  } finally {
    env.stop();
  }
});

test("GitLab: a member by username or an invitation by email, with a role, listed under the instance's web host", async () => {
  const env = await space("git@git-ssh.example.work:team/plan.git");
  try {
    const project = json({ id: 12, web_url: "https://git.example.work/team/plan", default_branch: "main" });
    const { shell, calls } = fakeShell([
      [/^glab api --hostname git-ssh\.example\.work projects\/team%2Fplan$/, project],
      [/^glab api --hostname git-ssh\.example\.work users\?username=anna$/, json([{ id: 5, username: "anna" }])],
      [/^glab api --hostname git-ssh\.example\.work -X POST projects\/12\/members -F user_id=5 -F access_level=30$/, json({ id: 5 })],
      [/^glab api --hostname git-ssh\.example\.work -X POST projects\/12\/invitations -f email=new@example\.com -F access_level=20$/, json({ status: "success" })],
      [/^glab api --hostname git-ssh\.example\.work -X DELETE projects\/12\/members\/5$/, {}],
      [/^glab api --hostname git-ssh\.example\.work -X DELETE projects\/12\/invitations\/new%40example\.com$/, {}],
    ]);
    const member = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "anna", role: "developer", confirmed: true }), shell);
    assert.deepEqual(member, { ok: true, error: "", sent: "added", person: "anna", warning: "" });
    assert.deepEqual(people(env).anna?.gitlab, { "git.example.work": "anna" });

    const invited = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "new@example.com", role: "reporter", person_key: "newbie", confirmed: true }), shell);
    assert.deepEqual(invited, { ok: true, error: "", sent: "invited", person: "newbie", warning: "" });
    assert.deepEqual(people(env).newbie?.emails, ["new@example.com"]);

    assert.equal((await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "member", who: "anna", confirmed: true }), shell)).ok, true);
    assert.equal((await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "invitation", who: "new@example.com", confirmed: true }), shell)).ok, true);
    const writes = calls.filter((c) => c.includes("-X")).map((c) => c.slice(4).join(" "));
    assert.deepEqual(writes, [
      "-X POST projects/12/members -F user_id=5 -F access_level=30",
      "-X POST projects/12/invitations -f email=new@example.com -F access_level=20",
      "-X DELETE projects/12/members/5",
      "-X DELETE projects/12/invitations/new%40example.com",
    ]);

    const refused = fakeShell([
      [/projects\/team%2Fplan$/, project],
      [/invitations/, json({ status: "error", message: { "x@example.com": "Invite email has already been taken" } })],
    ]);
    const taken = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "x@example.com", role: "developer", confirmed: true }), refused.shell);
    assert.equal(taken.ok, false);
    assert.match(taken.error, /already been taken/);
  } finally {
    env.stop();
  }
});

test("an invitation never rewrites someone else's People entry, and a busy plan does not hide a sent one", async () => {
  const env = await space("git@github.com:me/plan.git");
  try {
    const repo: [RegExp, Partial<ShellResult>] = [/^gh api repos\/me\/plan$/, json({ owner: { login: "me", type: "User" } })];
    const listed = fakeShell([repo, [/-X PUT/, json({ id: 3 })]]);
    assert.equal((await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "bobsmith", person_key: "bob", confirmed: true }), listed.shell)).person, "bob");
    listed.calls.length = 0;
    const clash = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "bob", confirmed: true }), listed.shell);
    assert.equal(clash.ok, false);
    assert.match(clash.error, /People's bob has the GitHub login bobsmith; choose another key/);
    assert.ok(listed.calls.every((c) => !c.includes("PUT")), "refused before the forge was written to");
    assert.equal(people(env).bob?.github, "bobsmith");

    // The plan is busy past the write's wait: the invitation went out and the answer says so.
    const sync = env.sync();
    sync.record = () => ({ outcomes: new Promise(() => undefined), forget: () => undefined }) as never;
    const busy = await invite({ ...env.ctx, writeWaitMs: 5 }, sharingInviteRpc.input.parse({ space: "TST", who: "bob", person_key: "bob2", confirmed: true }), listed.shell);
    assert.equal(busy.ok, true);
    assert.equal(busy.sent, "invited");
    assert.match(busy.warning, /^Invited; People not updated yet: .*busy syncing/);
  } finally {
    env.stop();
  }
});

test("a GitHub collaborator who may not read invitations still sees who has access", async () => {
  const env = await space("git@github.com:me/plan.git");
  try {
    const { shell } = fakeShell([
      [/^gh api repos\/me\/plan$/, json({ owner: { login: "me", type: "User" } })],
      [/collaborators/, ndjson([{ login: "me", role_name: "admin" }])],
      [/invitations/, { code: 1, stderr: "Must have admin rights to Repository. (HTTP 403)\n" }],
    ]);
    const read = await readSharing(env.ctx, { space: "TST" }, shell);
    assert.equal(read.ok, true);
    assert.match(read.error, /^Invitations not shown: gh: Must have admin rights/);
    assert.deepEqual(read.members.map((m) => m.who), ["me"]);
  } finally {
    env.stop();
  }
});

test("nothing reaches the forge without the confirmation, or with a login that could be an argument or a path", async () => {
  const env = await space("git@github.com:acme/plan.git");
  try {
    const { shell, calls } = fakeShell([[/./, json({ owner: { login: "acme", type: "Organization" } })]]);
    const unconfirmed = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "anna", role: "write" }), shell);
    assert.match(unconfirmed.error, /Confirm the invitation first/);
    const removal = await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "member", who: "anna" }), shell);
    assert.match(removal.error, /Confirm the removal first/);
    for (const who of ["--hostname", "../../orgs/acme", "anna/x", "a b", "anna@example.com"]) {
      const answer = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who, role: "write", confirmed: true }), shell);
      assert.equal(answer.ok, false, who);
    }
    const badKey = await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "anna", role: "write", person_key: "Not A Key", confirmed: true }), shell);
    assert.match(badKey.error, /not a person key/);
    assert.deepEqual(calls, [], "every refusal came before the forge");

    env.dashboard.spaces.get("TST")!.record.remote = "/tmp/plan.git";
    assert.match((await readSharing(env.ctx, { space: "TST" }, shell)).error, /not on GitHub or a GitLab instance/);
  } finally {
    env.stop();
  }
});

test("the confirmations say what the person gets, through whose login", () => {
  const writes = inviteSentence({ forge: "github", repo: "acme/plan", who: "anna", role: GITHUB_ORG_ROLES[0], person: "anna" });
  assert.match(writes, /^Invite anna to acme\/plan on GitHub as Write, with your own gh login\?/);
  assert.match(writes, /briefs they write become the first prompts of agents/);
  assert.match(writes, /added to People as anna/);
  assert.match(inviteSentence({ forge: "github", repo: "acme/plan", who: "anna", role: GITHUB_ORG_ROLES[0], person: "anna", listed: "held" }), /in People as anna already/);
  assert.match(inviteSentence({ forge: "gitlab", repo: "t/p", who: "a@b.co", role: GITLAB_ROLES[0], person: "anna", listed: "extended" }), /People's anna gets this email/);
  assert.match(inviteSentence({ forge: "github", repo: "me/plan", who: "bob", person: "" }), /as a collaborator.*push to the plan/);
  assert.match(inviteSentence({ forge: "gitlab", repo: "team/plan", who: "x@example.com", role: GITLAB_ROLES[2], person: "x" }), /glab login.*emails them an invitation.*read the plan, not change it/);
  assert.match(removeSentence({ forge: "gitlab", repo: "team/plan", who: "anna", kind: "member" }), /^Remove anna's access to team\/plan on GitLab\?/);
  assert.equal(suggestPersonKey("Anna.K@example.com"), "anna-k");
  assert.equal(suggestPersonKey("42bob"), "bob");
});

test("sharing and discovery are registered RPCs that meta.describe does not offer", () => {
  const names: string[] = [];
  contribute({ handle: (c: PluginRpcContract) => void names.push(c.name), on: () => () => undefined, before: () => () => undefined } as never)();
  const ours = ["plans.available", "sharing.read", "sharing.invite", "sharing.remove", "spaces.check"];
  for (const name of ours) assert.ok(names.includes(name), `${name} is registered`);
  const described = JSON.stringify(describeDashboard());
  for (const name of ours) assert.ok(!described.includes(name), `${name} is not described`);
  assert.ok(!/invite|collaborator|sharing/i.test(described), "no operation talks about sharing");
});

test("the setup check reports a GitLab default branch Developers cannot push, with the fix", async () => {
  const env = await space("git@git-ssh.example.work:team/plan.git");
  try {
    const project: [RegExp, Partial<ShellResult>] = [/projects\/team%2Fplan$/, json({ id: 12, web_url: "https://git.example.work/team/plan", default_branch: "main" })];
    const maintainers = fakeShell([project, [/protected_branches\/main$/, json({ name: "main", push_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }] })]]);
    const blocked = await checkSpace(env.ctx, { space: "TST" }, maintainers.shell);
    assert.equal(blocked.checked, true);
    assert.equal(blocked.problems.length, 1);
    assert.match(blocked.problems[0]!.problem, /Developers cannot push to main/);
    assert.match(blocked.problems[0]!.fix, /git\.example\.work.*Protected branches.*Developers \+ Maintainers/);

    const developers = fakeShell([project, [/protected_branches\/main$/, json({ push_access_levels: [{ access_level: 30 }] })]]);
    assert.deepEqual(await checkSpace(env.ctx, { space: "TST" }, developers.shell), { checked: true, error: "", problems: [] });
    const unprotected = fakeShell([project, [/protected_branches\/main$/, { code: 1, stderr: "glab: 404 Not Found (HTTP 404)" }]]);
    assert.deepEqual(await checkSpace(env.ctx, { space: "TST" }, unprotected.shell), { checked: true, error: "", problems: [] });
    const forbidden = fakeShell([project, [/protected_branches\/main$/, { code: 1, stderr: "glab: 403 Forbidden (HTTP 403)" }]]);
    const unknown = await checkSpace(env.ctx, { space: "TST" }, forbidden.shell);
    assert.equal(unknown.checked, false);
    assert.match(unknown.error, /403/);
    assert.ok(maintainers.calls.every((c) => !c.includes("-X")), "the check only reads");

    env.dashboard.spaces.get("TST")!.record.remote = "git@github.com:me/plan.git";
    const github = fakeShell([]);
    assert.deepEqual(await checkSpace(env.ctx, { space: "TST" }, github.shell), { checked: true, error: "", problems: [] });
    assert.deepEqual(github.calls, []);
  } finally {
    env.stop();
  }
});

/** Every file under `dir` with its size and modification time. */
function files(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else found.set(relative(dir, path), `${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(dir);
  return found;
}

test("sharing writes no credential: outside the space's own clone and journal, the data directory is untouched", async () => {
  const env = await space("git@github.com:acme/plan.git");
  try {
    const before = files(env.dashboard.dataDir);
    const { shell } = fakeShell([
      [/^gh api repos\/acme\/plan$/, json({ owner: { login: "acme", type: "Organization" } })],
      [/-X PUT/, json({ id: 1 })],
      [/-X DELETE/, {}],
      [/^gh api --paginate user\/repos/, ndjson([])],
      [/^gh config/, { stdout: "ssh\n" }],
      [/^glab auth status/, { stdout: "" }],
    ]);
    assert.equal((await invite(env.ctx, sharingInviteRpc.input.parse({ space: "TST", who: "anna", role: "write", confirmed: true }), shell)).ok, true);
    assert.equal((await removeAccess(env.ctx, sharingRemoveRpc.input.parse({ space: "TST", kind: "member", who: "anna", confirmed: true }), shell)).ok, true);
    await availablePlans([], shell);
    await env.sync().sync();
    const after = files(env.dashboard.dataDir);
    const changed = [...after].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path);
    const outside = changed.filter((path) => !path.startsWith(join("spaces", "TST", "repo")) && path !== join("spaces", "TST", "journal.json"));
    assert.deepEqual(outside, [], "only the plan's own clone and journal changed");
  } finally {
    env.stop();
  }
});
