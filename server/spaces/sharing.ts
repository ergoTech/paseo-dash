import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { PERSON_KEY_PATTERN, type Person } from "../../shared/model.ts";
import {
  EMAIL_PATTERN,
  type Forge,
  GITHUB_ORG_ROLES,
  GITLAB_ROLES,
  type Role,
  type sharingInviteRpc,
  type sharingReadRpc,
  type sharingRemoveRpc,
  type spacesCheckRpc,
  suggestPersonKey,
} from "../../shared/sharing.ts";
import { putPerson } from "../api/team.ts";
import { ownerError, type WriteContext } from "../api/writes.ts";
import type { SpaceRecord } from "../dashboard.ts";
import { type Shell, systemShell } from "./github.ts";
import { normalizeRemote } from "./mapping.ts";

/**
 * "Share this space" (09-forge-issues.md, section 3 and F4): who can reach a space's plan
 * repository, inviting a person and taking access away, all through the inviter's own `gh` or
 * `glab` login; nothing here stores a credential. An invitation gives the person the power to write
 * briefs that become the inviter's agents' first prompts, so invite and remove refuse unless the
 * screen's confirmation was shown, and none of this is described to God Mode.
 *
 * GitHub: `PUT/DELETE repos/{owner}/{repo}/collaborators/{login}`, with a permission on an
 * organisation's repository only; pending invitations are withdrawn by id. GitLab: members by user
 * id (`projects/:id/members`) or invitations by email (`projects/:id/invitations`), with an access
 * level. Also the setup check: a GitLab plan repository whose default branch Developers cannot push.
 */

/**
 * One forge call. An invitation makes up to three in a row and then writes People, which can wait
 * for a busy sync; Paseo may stop waiting before that, but the invitation is never undone and the
 * People write goes on in the background.
 */
const FORGE_MS = 8_000;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const GITLAB_LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const GITLAB_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/;
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;

const GITHUB_PERMISSION: Record<string, string> = { read: "pull", triage: "triage", write: "push" };
const GITLAB_LEVEL: Record<string, number> = { reporter: 20, developer: 30, maintainer: 40 };
const GITLAB_ROLE_NAME: Record<number, string> = { 10: "Guest", 15: "Planner", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

export type Target = { forge: "github"; owner: string; name: string } | { forge: "gitlab"; host: string; path: string };

/** The forge repository a plan remote names; undefined for a remote on neither (a local path, a bad URL). */
export function targetOf(remote: string): Target | undefined {
  const normalized = normalizeRemote(remote);
  const slash = normalized.indexOf("/");
  if (slash === -1) return undefined;
  const host = normalized.slice(0, slash);
  const path = normalized.slice(slash + 1);
  if (!HOST.test(host) || !host.includes(".")) return undefined;
  if (host === "github.com") {
    const [owner, name, ...rest] = path.split("/");
    if (rest.length || !owner || !name || !GITHUB_LOGIN.test(owner) || !GITHUB_NAME.test(name) || /^\.+$/.test(name)) return undefined;
    return { forge: "github", owner, name };
  }
  return GITLAB_PATH.test(path) && !path.split("/").some((part) => /^\.+$/.test(part)) ? { forge: "gitlab", host, path } : undefined;
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(obj) : []);

/** A forge call: its parsed JSON answer, or an error in the CLI's own words. */
async function call(shell: Shell, command: "gh" | "glab", args: string[]): Promise<{ ok: true; value: unknown; empty: boolean } | { ok: false; error: string; notFound: boolean }> {
  const result = await shell(command, args, FORGE_MS);
  if (result.code !== 0) {
    const error = lastLine(result.stderr) || lastLine(result.stdout) || `${command} failed`;
    return { ok: false, error: `${command}: ${error}`, notFound: /\b404\b|Not Found/i.test(`${result.stderr}\n${result.stdout}`) };
  }
  return { ok: true, value: parse(result.stdout), empty: !result.stdout.trim() };
}

const gh = (shell: Shell, ...args: string[]) => call(shell, "gh", ["api", ...args]);
const glab = (shell: Shell, host: string, ...args: string[]) => call(shell, "glab", ["api", "--hostname", host, ...args]);

/** gh's `--jq` prints one JSON value per line. */
function lines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      const value = parse(l);
      return value === undefined ? [] : [obj(value)];
    });
}

async function ghLines(shell: Shell, endpoint: string, jq: string): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const result = await shell("gh", ["api", "--paginate", endpoint, "--jq", jq], FORGE_MS);
  if (result.code !== 0) return { ok: false, error: `gh: ${lastLine(result.stderr) || "failed"}` };
  return { ok: true, rows: lines(result.stdout) };
}

const ghRepo = (t: { owner: string; name: string }) => `repos/${t.owner}/${t.name}`;
const glabProject = (path: string) => `projects/${encodeURIComponent(path)}`;

interface GithubRepo {
  organisation: boolean;
  owner: string;
}

async function githubRepo(shell: Shell, t: { owner: string; name: string }): Promise<GithubRepo | string> {
  const answer = await gh(shell, ghRepo(t));
  if (!answer.ok) return answer.error;
  const repo = obj(answer.value);
  const owner = obj(repo.owner);
  return { organisation: owner.type === "Organization", owner: text(owner.login) };
}

interface GitlabProject {
  id: number;
  /** The instance's web host, which may differ from the SSH host of the remote. */
  webHost: string;
  defaultBranch: string;
}

async function gitlabProject(shell: Shell, t: { host: string; path: string }): Promise<GitlabProject | string> {
  const answer = await glab(shell, t.host, glabProject(t.path));
  if (!answer.ok) return answer.error;
  const project = obj(answer.value);
  const id = project.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return `glab: ${t.path} has no project id on ${t.host}`;
  let webHost = t.host;
  try {
    webHost = new URL(text(project.web_url)).host || t.host;
  } catch {
    // The remote's host then.
  }
  return { id, webHost, defaultBranch: text(project.default_branch) };
}

async function gitlabUserId(shell: Shell, host: string, login: string): Promise<number | string> {
  const answer = await glab(shell, host, `users?username=${encodeURIComponent(login)}`);
  if (!answer.ok) return answer.error;
  const user = list(answer.value).find((u) => text(u.username).toLowerCase() === login.toLowerCase());
  return typeof user?.id === "number" ? user.id : `${host} has no user ${login}`;
}

type Read = RpcOutput<typeof sharingReadRpc>;
const NO_READ: Read = { ok: false, error: "", forge: "", repo: "", host: "", roles: [], by_email: false, members: [] };

function spaceRecord(ctx: WriteContext, key: string): SpaceRecord | string {
  const owner = ownerError(ctx);
  if (owner) return owner;
  const entry = ctx.dashboard.spaces.get(key.trim().toUpperCase());
  return entry ? entry.record : `No space ${key}.`;
}

function spaceTarget(ctx: WriteContext, key: string): { record: SpaceRecord; target: Target } | string {
  const record = spaceRecord(ctx, key);
  if (typeof record === "string") return record;
  const target = targetOf(record.remote);
  return target ? { record, target } : `The plan repository ${record.remote} is not on GitHub or a GitLab instance, so it is shared through its own host.`;
}

/** Who has access to the space's plan repository, and the roles an invitation there offers. */
export async function readSharing(ctx: WriteContext, input: RpcInput<typeof sharingReadRpc>, shell: Shell = systemShell): Promise<Read> {
  const found = spaceTarget(ctx, input.space);
  if (typeof found === "string") return { ...NO_READ, error: found };
  const { target } = found;
  if (target.forge === "github") {
    const base = { ...NO_READ, forge: "github" as const, repo: `${target.owner}/${target.name}`, host: "github.com" };
    const repo = await githubRepo(shell, target);
    if (typeof repo === "string") return { ...base, error: repo };
    const [people, invitations] = await Promise.all([
      ghLines(shell, `${ghRepo(target)}/collaborators?affiliation=direct&per_page=100`, ".[] | {login, name, role_name}"),
      ghLines(shell, `${ghRepo(target)}/invitations?per_page=100`, ".[] | {login: .invitee.login, permissions}"),
    ]);
    if (!people.ok) return { ...base, error: people.error };
    // Reading invitations needs admin; a collaborator with write still sees the others.
    return {
      ...base,
      ok: true,
      error: invitations.ok ? "" : `Invitations not shown: ${invitations.error}`,
      roles: repo.organisation ? GITHUB_ORG_ROLES : [],
      members: [
        ...people.rows.map((p) => ({
          kind: "member" as const,
          who: text(p.login),
          name: text(p.name),
          role: text(p.role_name),
          removable: text(p.login).toLowerCase() !== repo.owner.toLowerCase(),
        })),
        ...(invitations.ok ? invitations.rows : []).map((i) => ({ kind: "invitation" as const, who: text(i.login), name: "", role: text(i.permissions), removable: true })),
      ].filter((m) => m.who),
    };
  }
  const base = { ...NO_READ, forge: "gitlab" as const, repo: target.path, host: target.host, roles: GITLAB_ROLES, by_email: true };
  const project = await gitlabProject(shell, target);
  if (typeof project === "string") return { ...base, error: project };
  const [people, invitations] = await Promise.all([
    glab(shell, target.host, "--paginate", `projects/${project.id}/members?per_page=100`),
    glab(shell, target.host, "--paginate", `projects/${project.id}/invitations?per_page=100`),
  ]);
  if (!people.ok) return { ...base, host: project.webHost, error: people.error };
  // Reading invitations needs Maintainer; a Developer still sees the members.
  const invited = invitations.ok ? list(invitations.value) : [];
  return {
    ...base,
    host: project.webHost,
    ok: true,
    error: invitations.ok ? "" : `Invitations not shown: ${invitations.error}`,
    members: [
      ...list(people.value).map((m) => ({
        kind: "member" as const,
        who: text(m.username),
        name: text(m.name),
        role: GITLAB_ROLE_NAME[Number(m.access_level)] ?? text(m.access_level),
        removable: true,
      })),
      ...invited.map((i) => ({ kind: "invitation" as const, who: text(i.invite_email), name: "", role: GITLAB_ROLE_NAME[Number(i.access_level)] ?? text(i.access_level), removable: true })),
    ].filter((m) => m.who),
  };
}

type Invite = RpcOutput<typeof sharingInviteRpc>;
const refuse = (error: string): Invite => ({ ok: false, error, sent: "", person: "", warning: "" });

/** The key of the person who holds this login (or email) already. */
function holder(people: Record<string, Person>, forge: Forge, webHost: string, who: string): string | undefined {
  return Object.keys(people).find((k) => holds(people[k]!, forge, webHost, who));
}

/** The login a person entry holds for this forge, or their email. */
function holds(person: Person, forge: Forge, webHost: string, who: string): boolean {
  const wanted = who.toLowerCase();
  if (EMAIL_PATTERN.test(who)) return person.emails.some((e) => e.toLowerCase() === wanted);
  if (forge === "github") return person.github?.toLowerCase() === wanted;
  return Object.entries(person.gitlab).some(([host, login]) => host.toLowerCase() === webHost.toLowerCase() && login.toLowerCase() === wanted);
}

/**
 * Why listing `who` under `key` would rewrite someone else: the entry holds another login for the
 * same forge (host). An email only joins the entry's list, which the confirmation names.
 */
function collision(person: Person | undefined, key: string, forge: Forge, webHost: string, who: string): string | undefined {
  if (!person || EMAIL_PATTERN.test(who)) return undefined;
  const other =
    forge === "github"
      ? person.github
      : Object.entries(person.gitlab).find(([host]) => host.toLowerCase() === webHost.toLowerCase())?.[1];
  if (!other || other.toLowerCase() === who.toLowerCase()) return undefined;
  return `People's ${key} has the ${forge === "github" ? "GitHub" : webHost} login ${other}; choose another key for ${who}. Nothing was sent.`;
}

/**
 * Invites `who` to the space's plan repository, then lists them in the space's people under
 * `person_key` (or a key from their login) with that login or email, unless someone there holds it
 * already. Every refusal comes before the forge is written to; only reads may come first.
 */
export async function invite(ctx: WriteContext, input: RpcInput<typeof sharingInviteRpc>, shell: Shell = systemShell): Promise<Invite> {
  const found = spaceTarget(ctx, input.space);
  if (typeof found === "string") return refuse(found);
  const { target } = found;
  if (!input.confirmed) return refuse("Confirm the invitation first: nothing was sent.");
  const space = ctx.dashboard.spaces.get(found.record.key)!;
  const people = space.sync.plan.space?.people;
  if (!people) return refuse("space.yaml cannot be read; fix it first");
  const who = input.who.trim();
  const email = EMAIL_PATTERN.test(who);
  let role: Role | undefined;
  if (target.forge === "github") {
    if (email) return refuse("GitHub invites a login, not an email.");
    if (!GITHUB_LOGIN.test(who)) return refuse(`${JSON.stringify(who)} is not a GitHub login`);
  } else if (!email && !GITLAB_LOGIN.test(who)) return refuse(`${JSON.stringify(who)} is not a GitLab username or an email`);
  const key = input.person_key.trim() || suggestPersonKey(who);
  if (!Object.hasOwn(people, key) && !PERSON_KEY_PATTERN.test(key)) {
    return refuse(`${JSON.stringify(key)} is not a person key: lower-case letters, digits, - and _, starting with a letter`);
  }

  let sent: Invite["sent"];
  let webHost = "github.com";
  if (target.forge === "github") {
    const repo = await githubRepo(shell, target);
    if (typeof repo === "string") return refuse(repo);
    const fields: string[] = [];
    if (repo.organisation) {
      role = GITHUB_ORG_ROLES.find((r) => r.value === input.role);
      if (!role) return refuse(`Choose a role: ${GITHUB_ORG_ROLES.map((r) => r.value).join(", ")}.`);
      fields.push("-f", `permission=${GITHUB_PERMISSION[role.value]}`);
    } else if (input.role) return refuse("A repository owned by a user has no roles: every collaborator can push.");
    const clash = holder(people, target.forge, webHost, who) ? undefined : collision(people[key], key, target.forge, webHost, who);
    if (clash) return refuse(clash);
    const answer = await gh(shell, "-X", "PUT", `${ghRepo(target)}/collaborators/${who}`, ...fields);
    if (!answer.ok) return refuse(answer.error);
    // 201 with the invitation; 204 and no body when they get access without one: an existing
    // collaborator (whose permission PUT sets), an organisation member, a member of a team.
    sent = answer.empty ? "added" : "invited";
  } else {
    role = GITLAB_ROLES.find((r) => r.value === input.role);
    if (!role) return refuse(`Choose a role: ${GITLAB_ROLES.map((r) => r.value).join(", ")}.`);
    const level = String(GITLAB_LEVEL[role.value]);
    const project = await gitlabProject(shell, target);
    if (typeof project === "string") return refuse(project);
    webHost = project.webHost;
    const clash = holder(people, target.forge, webHost, who) ? undefined : collision(people[key], key, target.forge, webHost, who);
    if (clash) return refuse(clash);
    if (email) {
      const answer = await glab(shell, target.host, "-X", "POST", `projects/${project.id}/invitations`, "-f", `email=${who}`, "-F", `access_level=${level}`);
      if (!answer.ok) return refuse(answer.error);
      // GitLab answers a refused invitation with `status: error` and the reason per email.
      const body = obj(answer.value);
      if (body.status === "error") return refuse(`GitLab refused: ${Object.values(obj(body.message)).map(text).join("; ") || text(body.message) || "no reason given"}`);
      sent = "invited";
    } else {
      const id = await gitlabUserId(shell, target.host, who);
      if (typeof id === "string") return refuse(id);
      const answer = await glab(shell, target.host, "-X", "POST", `projects/${project.id}/members`, "-F", `user_id=${id}`, "-F", `access_level=${level}`);
      if (!answer.ok) return refuse(/already exists/i.test(answer.error) ? `${who} is already a member; change their role on GitLab.` : answer.error);
      sent = "added";
    }
  }

  // People as it is now: a sync may have changed it while the forge answered.
  const now = space.sync.plan.space?.people ?? people;
  const listedAs = holder(now, target.forge, webHost, who);
  if (listedAs) return { ok: true, error: "", sent, person: listedAs, warning: "" };
  const current = now[key];
  const late = collision(current, key, target.forge, webHost, who);
  if (late) return { ok: true, error: "", sent, person: "", warning: `Invited, but not added to People: ${late.replace(" Nothing was sent.", "")}` };
  const gitlab = Object.entries(current?.gitlab ?? {}).map(([host, login]) => ({ host, login }));
  if (target.forge === "gitlab" && !email && !gitlab.some((g) => g.host.toLowerCase() === webHost.toLowerCase())) gitlab.push({ host: webHost, login: who });
  try {
    const listed = await putPerson(ctx, {
      space: found.record.key,
      key,
      name: current?.name ?? (input.person_name.trim() || undefined),
      emails: [...(current?.emails ?? []), ...(email ? [who] : [])],
      github: target.forge === "github" ? who : current?.github,
      gitlab,
    });
    if (!listed.ok) return { ok: true, error: "", sent, person: "", warning: `Invited, but not added to People: ${listed.error}` };
  } catch (error) {
    // The plan was busy: the invitation went out, and the People change is queued or failed.
    return { ok: true, error: "", sent, person: "", warning: `Invited; People not updated yet: ${(error as Error).message}` };
  }
  return { ok: true, error: "", sent, person: key, warning: "" };
}

type Remove = RpcOutput<typeof sharingRemoveRpc>;

/** Takes a person's access away, or withdraws a pending invitation; their People entry stays. */
export async function removeAccess(ctx: WriteContext, input: RpcInput<typeof sharingRemoveRpc>, shell: Shell = systemShell): Promise<Remove> {
  const found = spaceTarget(ctx, input.space);
  if (typeof found === "string") return { ok: false, error: found };
  const { target } = found;
  if (!input.confirmed) return { ok: false, error: "Confirm the removal first: nothing was changed." };
  const who = input.who.trim();
  const fail = (error: string): Remove => ({ ok: false, error });
  if (target.forge === "github") {
    if (!GITHUB_LOGIN.test(who)) return fail(`${JSON.stringify(who)} is not a GitHub login`);
    if (input.kind === "member") {
      const answer = await gh(shell, "-X", "DELETE", `${ghRepo(target)}/collaborators/${who}`);
      return answer.ok ? { ok: true, error: "" } : fail(answer.error);
    }
    const invitations = await ghLines(shell, `${ghRepo(target)}/invitations?per_page=100`, ".[] | {id, login: .invitee.login}");
    if (!invitations.ok) return fail(invitations.error);
    const id = invitations.rows.find((i) => text(i.login).toLowerCase() === who.toLowerCase())?.id;
    if (typeof id !== "number") return fail(`${target.owner}/${target.name} has no pending invitation for ${who}.`);
    const answer = await gh(shell, "-X", "DELETE", `${ghRepo(target)}/invitations/${id}`);
    return answer.ok ? { ok: true, error: "" } : fail(answer.error);
  }
  const project = await gitlabProject(shell, target);
  if (typeof project === "string") return fail(project);
  if (input.kind === "invitation") {
    if (!EMAIL_PATTERN.test(who)) return fail(`${JSON.stringify(who)} is not an email`);
    const answer = await glab(shell, target.host, "-X", "DELETE", `projects/${project.id}/invitations/${encodeURIComponent(who)}`);
    return answer.ok ? { ok: true, error: "" } : fail(answer.error);
  }
  if (!GITLAB_LOGIN.test(who)) return fail(`${JSON.stringify(who)} is not a GitLab username`);
  const id = await gitlabUserId(shell, target.host, who);
  if (typeof id === "string") return fail(id);
  const answer = await glab(shell, target.host, "-X", "DELETE", `projects/${project.id}/members/${id}`);
  return answer.ok ? { ok: true, error: "" } : fail(answer.error);
}

type Check = RpcOutput<typeof spacesCheckRpc>;

/** GitLab's push levels: 0 no one, 30 Developers + Maintainers, 40 Maintainers, 60 administrators. */
const DEVELOPER = 30;

/**
 * The setup check of a space's plan repository. On GitLab the default branch is protected for
 * Maintainers unless someone changed it, and the dashboard pushes every plan change and every
 * start there (D13), so a Developer collaborator could neither plan nor start. GitHub has nothing
 * to check here: a user-owned private repository on the free plan cannot protect a branch.
 */
export async function checkSpace(ctx: WriteContext, input: RpcInput<typeof spacesCheckRpc>, shell: Shell = systemShell): Promise<Check> {
  const record = spaceRecord(ctx, input.space);
  if (typeof record === "string") return { checked: false, error: record, problems: [] };
  const target = targetOf(record.remote);
  if (!target || target.forge === "github") return { checked: true, error: "", problems: [] };
  const project = await gitlabProject(shell, target);
  if (typeof project === "string") return { checked: false, error: project, problems: [] };
  const branch = record.branch;
  const answer = await glab(shell, target.host, `projects/${project.id}/protected_branches/${encodeURIComponent(branch)}`);
  if (!answer.ok) return answer.notFound ? { checked: true, error: "", problems: [] } : { checked: false, error: answer.error, problems: [] };
  const levels = list(obj(answer.value).push_access_levels).map((l) => l.access_level);
  if (levels.some((level) => typeof level === "number" && level > 0 && level <= DEVELOPER)) return { checked: true, error: "", problems: [] };
  return {
    checked: true,
    error: "",
    problems: [
      {
        problem: `Developers cannot push to ${branch}, the branch the plan lives on: a collaborator with the Developer role can read the plan but not plan or start tasks.`,
        fix: `On ${project.webHost}, open ${target.path} → Settings → Repository → Protected branches and set "Allowed to push and merge" of ${branch} to "Developers + Maintainers"; or give every collaborator the Maintainer role.`,
      },
    ],
  };
}
