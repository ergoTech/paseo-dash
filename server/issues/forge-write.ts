import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssueUrl } from "../../shared/issues.ts";
import type { CommandResult, ForgeCli } from "../tracker/forge.ts";
import type { ProjectRepo } from "./link.ts";

/**
 * The issue mirror's forge calls (09-forge-issues.md, option c, the mirror): create an issue, set its
 * content and state, find one a create that timed out may have made, and read whether a repository is
 * public. Every call goes through `gh api` / `glab api` with the request body in a JSON file, so empty
 * lists (no labels, no assignee) are sent as such; the issue is named in full, so no checkout is
 * needed. Nothing here decides what to write: server/issues/mirror.ts does.
 */

const TIMEOUT_MS = 15_000;
/** GitLab's access level of a Developer, the least that may push. */
const GITLAB_DEVELOPER = 30;
/** A repository path and a host the CLIs may be given (as server/tracker/forge.ts checks them). */
const REPO_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;
/** A forge login: what GitHub and GitLab allow, and nothing a CLI could read as a flag. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** What an issue shows: written whole on every change, so edits made on the forge do not stay. */
export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
  /** The forge login of the task's assignee; empty for none. */
  assignee: string;
  state: "open" | "completed" | "not_planned";
}

/**
 * - `rate`: the forge said to slow down; nothing more goes to that host for a while.
 * - `invalid`: the forge refused the content (HTTP 422, an unknown assignee); the call may be retried
 *   without labels and assignee.
 * - `failed`: anything else, the network included.
 */
export type WriteResult<T> = { ok: true; value: T } | { ok: false; kind: "rate" | "invalid" | "failed"; error: string };

export interface Created {
  url: string;
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The CLI's own words for a failure, kept short, and what kind of failure it is. */
function failure<T>(command: string, result: CommandResult): WriteResult<T> {
  const said = `${result.stderr ?? ""}\n${result.stdout}`;
  const line = said
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 300);
  const error = line ? `${command}: ${line}` : `${command} failed (exit ${result.code}); is it installed and logged in?`;
  if (/rate limit|\b429\b|too many requests|retry-after/i.test(said)) return { ok: false, kind: "rate", error };
  if (/\b422\b|unprocessable|validation failed/i.test(said)) return { ok: false, kind: "invalid", error };
  return { ok: false, kind: "failed", error };
}

const glabProject = (repo: string) => `projects/${encodeURIComponent(repo)}`;

export class IssueWriter {
  private readonly cli: ForgeCli;
  private readonly dir: string;
  /** GitLab user ids by `host/login`, read once per process. */
  private readonly userIds = new Map<string, number>();

  /** `dir` holds the request bodies for the moment of a call; nothing stays there. */
  constructor(cli: ForgeCli, dir: string) {
    this.cli = cli;
    this.dir = dir;
  }

  private async call(command: "gh" | "glab", args: string[], body?: unknown): Promise<CommandResult> {
    if (body === undefined) return this.cli.exec(command, args, this.dir, TIMEOUT_MS);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `.mirror-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    try {
      return await this.cli.exec(command, [...args, "--input", file, "-H", "Content-Type: application/json"], this.dir, TIMEOUT_MS);
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** The repository is one the CLIs may be given; an error otherwise. */
  private refuse(repo: ProjectRepo): string | undefined {
    // A `.` or `..` segment would make the API path name something else than the repository.
    const dots = repo.repo.split("/").some((part) => part === "." || part === "..");
    return REPO_PATH.test(repo.repo) && HOST.test(repo.host) && !dots ? undefined : `${repo.host}/${repo.repo} is not a repository path the forge CLIs are given`;
  }

  /**
   * A GitLab login's user id on the host: undefined when the host has no such user, a failure when
   * the host could not be asked (then nothing is written, so the assignee is not dropped by mistake).
   */
  private async gitlabUser(host: string, login: string): Promise<WriteResult<number | undefined>> {
    const key = `${host}/${login.toLowerCase()}`;
    const known = this.userIds.get(key);
    if (known !== undefined) return { ok: true, value: known };
    const result = await this.call("glab", ["api", "--hostname", host, `users?username=${encodeURIComponent(login)}`]);
    if (result.code !== 0) return failure("glab api", result);
    const users = parse(result.stdout);
    if (!Array.isArray(users)) return { ok: false, kind: "failed", error: "glab api answered something that is not a list of users" };
    const user = users.map(obj).find((u) => String(u.username ?? "").toLowerCase() === login.toLowerCase());
    if (typeof user?.id !== "number") return { ok: true, value: undefined };
    this.userIds.set(key, user.id);
    return { ok: true, value: user.id };
  }

  private async gitlabBody(repo: ProjectRepo, content: IssueContent, bare: boolean): Promise<WriteResult<Record<string, unknown>>> {
    const user = !bare && content.assignee && LOGIN.test(content.assignee) ? await this.gitlabUser(repo.host, content.assignee) : { ok: true as const, value: undefined };
    if (!user.ok) return user;
    return {
      ok: true,
      value: {
        title: content.title,
        description: content.body,
        // Comma-separated on GitLab: a label with a comma would read as two, so it stays off.
        labels: bare ? "" : content.labels.filter((l) => !l.includes(",")).join(","),
        assignee_ids: user.value === undefined ? [] : [user.value],
      },
    };
  }

  private githubBody(content: IssueContent, bare: boolean): Record<string, unknown> {
    return {
      title: content.title,
      body: content.body,
      labels: bare ? [] : content.labels,
      assignees: !bare && content.assignee && LOGIN.test(content.assignee) ? [content.assignee] : [],
    };
  }

  /**
   * Opens an issue. With `bare`, labels and assignee are left out (a retry after the forge refused
   * them). The URL is the forge's own answer, in the form tasks store.
   */
  async create(repo: ProjectRepo, content: IssueContent, bare = false): Promise<WriteResult<Created>> {
    const refused = this.refuse(repo);
    if (refused) return { ok: false, kind: "failed", error: refused };
    if (repo.forge === "github") {
      const result = await this.call("gh", ["api", "-X", "POST", `repos/${repo.repo}/issues`], this.githubBody(content, bare));
      if (result.code !== 0) return failure("gh api", result);
      const issue = obj(parse(result.stdout));
      const url = parseIssueUrl(String(issue.html_url ?? ""))?.url ?? (typeof issue.number === "number" ? `https://${repo.host}/${repo.repo}/issues/${issue.number}` : "");
      return url ? { ok: true, value: { url } } : { ok: false, kind: "failed", error: "gh api answered something that is not an issue" };
    }
    const body = await this.gitlabBody(repo, content, bare);
    if (!body.ok) return body;
    const result = await this.call("glab", ["api", "--hostname", repo.host, "-X", "POST", `${glabProject(repo.repo)}/issues`], body.value);
    if (result.code !== 0) return failure("glab api", result);
    const issue = obj(parse(result.stdout));
    const url = parseIssueUrl(String(issue.web_url ?? ""))?.url ?? (typeof issue.iid === "number" ? `https://${repo.host}/${repo.repo}/-/issues/${issue.iid}` : "");
    return url ? { ok: true, value: { url } } : { ok: false, kind: "failed", error: "glab api answered something that is not an issue" };
  }

  /** Writes the whole content and state of an issue the mirror made. */
  async update(url: string, content: IssueContent, bare = false): Promise<WriteResult<true>> {
    const ref = parseIssueUrl(url);
    if (!ref) return { ok: false, kind: "failed", error: `${url} is not an issue URL` };
    const repo: ProjectRepo = { forge: ref.forge, host: ref.host, repo: ref.repo };
    const refused = this.refuse(repo);
    if (refused) return { ok: false, kind: "failed", error: refused };
    if (ref.forge === "github") {
      const state = content.state === "open" ? { state: "open" } : { state: "closed", state_reason: content.state };
      const result = await this.call("gh", ["api", "-X", "PATCH", `repos/${ref.repo}/issues/${ref.number}`], { ...this.githubBody(content, bare), ...state });
      return result.code === 0 ? { ok: true, value: true } : failure("gh api", result);
    }
    const body = await this.gitlabBody(repo, content, bare);
    if (!body.ok) return body;
    const state_event = content.state === "open" ? "reopen" : "close";
    const result = await this.call("glab", ["api", "--hostname", ref.host, "-X", "PUT", `${glabProject(ref.repo)}/issues/${ref.number}`], { ...body.value, state_event });
    return result.code === 0 ? { ok: true, value: true } : failure("glab api", result);
  }

  /** Closes an issue the mirror made as not planned and replaces its text; labels and assignee stay. */
  async close(url: string, body: string): Promise<WriteResult<true>> {
    const ref = parseIssueUrl(url);
    if (!ref) return { ok: false, kind: "failed", error: `${url} is not an issue URL` };
    const refused = this.refuse({ forge: ref.forge, host: ref.host, repo: ref.repo });
    if (refused) return { ok: false, kind: "failed", error: refused };
    const result =
      ref.forge === "github"
        ? await this.call("gh", ["api", "-X", "PATCH", `repos/${ref.repo}/issues/${ref.number}`], { body, state: "closed", state_reason: "not_planned" })
        : await this.call("glab", ["api", "--hostname", ref.host, "-X", "PUT", `${glabProject(ref.repo)}/issues/${ref.number}`], { description: body, state_event: "close" });
    return result.code === 0 ? { ok: true, value: true } : failure(ref.forge === "github" ? "gh api" : "glab api", result);
  }

  /**
   * An issue of the repository created or changed since `since` whose body ends with `marker`: what a
   * create that timed out may have made. `undefined` value: there is none; an error: the forge could
   * not be read, so nobody can tell.
   */
  async find(repo: ProjectRepo, marker: string, since: string): Promise<WriteResult<string | undefined>> {
    const refused = this.refuse(repo);
    if (refused) return { ok: false, kind: "failed", error: refused };
    const at = encodeURIComponent(since);
    const github = repo.forge === "github";
    const result = github
      ? await this.call("gh", ["api", `repos/${repo.repo}/issues?state=all&since=${at}&sort=created&direction=desc&per_page=100`])
      : await this.call("glab", ["api", "--hostname", repo.host, `${glabProject(repo.repo)}/issues?scope=all&state=all&created_after=${at}&per_page=100`]);
    if (result.code !== 0) return failure(github ? "gh api" : "glab api", result);
    const read = parse(result.stdout);
    if (!Array.isArray(read)) return { ok: false, kind: "failed", error: `${github ? "gh" : "glab"} api answered something that is not a list of issues` };
    for (const issue of read.map(obj)) {
      // GitHub lists pull requests among issues.
      if (github && issue.pull_request) continue;
      // Only the body's own last line: a marker quoted inside a brief is another task's.
      const lines = String((github ? issue.body : issue.description) ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.at(-1) !== marker) continue;
      const url = parseIssueUrl(String((github ? issue.html_url : issue.web_url) ?? ""))?.url;
      if (url) return { ok: true, value: url };
    }
    return { ok: true, value: undefined };
  }

  /** `public`, `private` or `internal` as the forge says; an error when it cannot be read. */
  async visibility(repo: ProjectRepo): Promise<WriteResult<string>> {
    const read = await this.access(repo);
    if (!read.ok) return read;
    return read.value.visibility ? { ok: true, value: read.value.visibility } : { ok: false, kind: "failed", error: "the forge did not say whether the repository is public" };
  }

  /**
   * The repository's visibility, and whether the login the CLI uses can write to it: push (or
   * maintain, admin) on GitHub, Developer or above on GitLab. Anyone may open an issue in a public
   * repository, so the forge's own refusal is no guard: the mirror asks this before it makes one.
   * `write` is false also when the forge does not say (an unauthenticated read).
   */
  async access(repo: ProjectRepo): Promise<WriteResult<{ visibility: string; write: boolean }>> {
    const refused = this.refuse(repo);
    if (refused) return { ok: false, kind: "failed", error: refused };
    const github = repo.forge === "github";
    const result = github
      ? await this.call("gh", ["api", `repos/${repo.repo}`])
      : await this.call("glab", ["api", "--hostname", repo.host, glabProject(repo.repo)]);
    if (result.code !== 0) return failure(github ? "gh api" : "glab api", result);
    const read = obj(parse(result.stdout));
    const visibility = typeof read.visibility === "string" ? read.visibility : typeof read.private === "boolean" ? (read.private ? "private" : "public") : "";
    const permissions = obj(read.permissions);
    const level = (key: string) => {
      const value = obj(permissions[key]).access_level;
      return typeof value === "number" ? value : 0;
    };
    const write = github
      ? permissions.push === true || permissions.maintain === true || permissions.admin === true
      : Math.max(level("project_access"), level("group_access")) >= GITLAB_DEVELOPER;
    return { ok: true, value: { visibility, write } };
  }
}
