import { execFile } from "node:child_process";
import { normalizeRemote } from "../spaces/mapping.ts";

/**
 * PR/MR facts from the forge CLIs (05-architecture.md, 3. PR/MR state). Paseo's workspace descriptor
 * shows an open PR at the workspace's head but no merge time, and hides a merge once the heads
 * differ (08-phase-3-spikes.md, spike B), so `gh` and `glab` decide merges and their times. Both run
 * in the project's checkout, where they find the repository from its remote; arguments are arrays,
 * never a shell. A missing or logged-out CLI answers undefined: the task then waits for a person.
 */

export type PrState = "open" | "merged" | "closed";

export interface ForgePr {
  url: string;
  /** `#7` on GitHub, `!12` on GitLab: how a person names it. */
  label: string;
  state: PrState;
  mergedAt?: string;
  head?: string;
  /** The commit the PR/MR's branch pointed at (for a merged one: what was merged). */
  headSha?: string;
  createdAt?: string;
  /** An open draft: its work is not up for review yet. */
  draft?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  /** What the command said on failure; runners in tests may leave it out. */
  stderr?: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;

export const systemCommand: CommandRunner = (command, args, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const said = String(stderr).trim() || (failure && typeof failure.code !== "number" ? failure.message : "");
      resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0, stdout: String(stdout), stderr: said });
    });
  });

const TIMEOUT_MS = 15_000;
const GH_FIELDS = "number,url,state,mergedAt,headRefName,headRefOid,createdAt,isCrossRepository,isDraft";

/** GitHub when the project's remote is on github.com; anything else is treated as GitLab. */
export function forgeOf(remote: string): "github" | "gitlab" {
  return normalizeRemote(remote).toLowerCase().startsWith("github.com/") ? "github" : "gitlab";
}

/**
 * Whether a PR/MR URL belongs to the project's own repository: the same host and path as its
 * remote. An agent's reported `pr_url` counts only then. With `webHost` (space.yaml's `web_host`,
 * where the forge serves a remote cloned from another host), that host counts too.
 */
export function prUrlOfProject(url: string, remote: string, webHost?: string): boolean {
  const match = /^https:\/\/([^/\s]+)\/(.+?)\/(?:-\/merge_requests|pull)\/\d+\/?$/.exec(url.trim());
  if (!match) return false;
  const normal = normalizeRemote(remote);
  const path = normal.slice(normal.indexOf("/") + 1);
  const host = match[1]!.toLowerCase();
  return `${host}/${match[2]}` === normal || (Boolean(webHost) && host === webHost!.toLowerCase() && match[2] === path);
}

/** The repository path and number a PR/MR URL names: `frontend/site` and `975`; undefined when it names none. */
function prPath(url: string): { path: string; number: string } | undefined {
  const match = /^https:\/\/[^/\s]+\/(.+?)\/(?:-\/merge_requests|pull)\/(\d+)\/?$/.exec(url.trim());
  return match ? { path: match[1]!, number: match[2]! } : undefined;
}

function parse<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

interface GhPr {
  number: number;
  url: string;
  state: string;
  mergedAt?: string | null;
  headRefName?: string;
  headRefOid?: string;
  createdAt?: string;
  isCrossRepository?: boolean;
  isDraft?: boolean;
}

interface GlabMr {
  iid: number;
  web_url: string;
  state: string;
  merged_at?: string | null;
  source_branch?: string;
  sha?: string;
  created_at?: string;
  source_project_id?: number;
  target_project_id?: number;
  draft?: boolean;
}

/**
 * Only a PR/MR from the project's own repository can be a run's: a fork may use the same branch
 * name, and `gh pr list --head` matches the name only. One whose origin is not told is not taken.
 */
function ownGh(pr: GhPr): boolean {
  return pr.isCrossRepository === false;
}

function ownGlab(mr: GlabMr): boolean {
  return mr.source_project_id !== undefined && mr.source_project_id === mr.target_project_id;
}

function fromGh(pr: GhPr): ForgePr {
  const state = pr.state.toUpperCase() === "MERGED" ? "merged" : pr.state.toUpperCase() === "OPEN" ? "open" : "closed";
  return {
    url: pr.url,
    label: `#${pr.number}`,
    state,
    mergedAt: pr.mergedAt ?? undefined,
    head: pr.headRefName,
    ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
    ...(pr.createdAt ? { createdAt: pr.createdAt } : {}),
    ...(state === "open" && pr.isDraft ? { draft: true } : {}),
  };
}

function fromGlab(mr: GlabMr): ForgePr {
  const state = mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
  return {
    url: mr.web_url,
    label: `!${mr.iid}`,
    state,
    mergedAt: mr.merged_at ?? undefined,
    head: mr.source_branch,
    ...(mr.sha ? { headSha: mr.sha } : {}),
    ...(mr.created_at ? { createdAt: mr.created_at } : {}),
    ...(state === "open" && mr.draft ? { draft: true } : {}),
  };
}

/** An issue's state as the forge has it now; `closedBy` holds the URLs of the PR/MRs that closed it. */
export interface IssueState {
  state: "open" | "closed";
  closedBy: string[];
}

/** An open issue as the import lists it; the body is other people's text. */
export interface ForgeIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  milestone: string;
  body: string;
}

export type IssueList = { ok: true; issues: ForgeIssue[]; more: boolean } | { ok: false; error: string };

/** A repository path the CLIs may be given: segments of letters, digits, `.`, `_` and `-`. */
const REPO_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;

interface GhIssue {
  number: number;
  title: string;
  url: string;
  state?: string;
  body?: string | null;
  labels?: { name?: string }[] | null;
  milestone?: { title?: string } | null;
  closedByPullRequestsReferences?: { url?: string }[] | null;
}

interface GlabIssue {
  iid: number;
  title: string;
  web_url: string;
  state?: string;
  description?: string | null;
  labels?: (string | { name?: string })[] | null;
  milestone?: { title?: string } | null;
}

/** The CLI's own words for a failure, one line, or a fallback. */
function cliError(result: CommandResult, command: string): string {
  const said = (result.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ");
  return said ? `${command}: ${said.slice(0, 300)}` : `${command} failed (exit ${result.code}); is it installed and logged in?`;
}

export class ForgeCli {
  private readonly runner: CommandRunner;
  private controller = new AbortController();

  constructor(run: CommandRunner = systemCommand) {
    this.runner = run;
  }

  private run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
    return this.runner(command, args, cwd, timeoutMs, this.controller.signal);
  }

  /** Runs a forge CLI, ended with the others on `abort` (issue reads, server/tracker/forge.ts ForgeIssues). */
  exec(command: "gh" | "glab", args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
    return this.run(command, args, cwd, timeoutMs);
  }

  /** Ends every CLI process still running (plugin cleanup); later calls start fresh. */
  abort(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  /**
   * The commit a branch points at on `origin` now: its sha, "" when the branch is gone there, or
   * undefined when git cannot tell. Compared with a merged PR/MR's head, it shows work pushed after it.
   */
  async branchTip(cwd: string, branch: string, timeoutMs = TIMEOUT_MS): Promise<string | undefined> {
    const result = await this.run("git", ["ls-remote", "origin", `refs/heads/${branch}`], cwd, timeoutMs);
    if (result.code !== 0) return undefined;
    return /^([0-9a-f]{40,64})\s/m.exec(result.stdout)?.[1] ?? "";
  }

  /** Every PR/MR whose source is this branch, newest first; undefined when the CLI cannot tell. */
  async byBranch(cwd: string, remote: string, branch: string, timeoutMs = TIMEOUT_MS): Promise<ForgePr[] | undefined> {
    if (forgeOf(remote) === "github") {
      const result = await this.run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", GH_FIELDS], cwd, timeoutMs);
      const list = result.code === 0 ? parse<GhPr[]>(result.stdout) : undefined;
      return list?.filter(ownGh).map(fromGh).filter((pr) => pr.head === branch).sort(newestFirst);
    }
    const result = await this.run("glab", ["mr", "list", "--source-branch", branch, "--all", "-F", "json"], cwd, timeoutMs);
    const list = result.code === 0 ? parse<GlabMr[]>(result.stdout) : undefined;
    return list?.filter(ownGlab).map(fromGlab).filter((mr) => mr.head === branch).sort(newestFirst);
  }

  /**
   * One PR/MR of the project's repository by its URL; undefined when it is not one or cannot be read.
   * `webHost` is the project's web host when it differs from its remote's (space.yaml `web_host`).
   */
  async byUrl(cwd: string, remote: string, url: string, webHost?: string): Promise<ForgePr | undefined> {
    if (!prUrlOfProject(url, remote, webHost)) return undefined;
    if (forgeOf(remote) === "github") {
      const result = await this.run("gh", ["pr", "view", url, "--json", GH_FIELDS], cwd, TIMEOUT_MS);
      const pr = result.code === 0 ? parse<GhPr>(result.stdout) : undefined;
      return pr && ownGh(pr) ? fromGh(pr) : undefined;
    }
    const iid = /\/-\/merge_requests\/(\d+)/.exec(url)?.[1];
    if (!iid) return undefined;
    const result = await this.run("glab", ["mr", "view", iid, "-F", "json"], cwd, TIMEOUT_MS);
    const mr = result.code === 0 ? parse<GlabMr>(result.stdout) : undefined;
    // glab reads the MR of the project the checkout's remotes name, by number: an MR of another
    // project (a fork's remote, a hand-mapped checkout) is not the one the URL names. GitLab routes
    // paths without regard to case, and a remote may spell them otherwise than its web_url.
    const named = mr ? prPath(mr.web_url ?? "") : undefined;
    if (!mr || !named || named.path.toLowerCase() !== prPath(url)?.path.toLowerCase() || named.number !== iid) return undefined;
    return ownGlab(mr) ? fromGlab(mr) : undefined;
  }
}

export interface IssueFilter {
  label?: string;
  milestone?: string;
}

/**
 * Issue reads (09-forge-issues.md, F2 and F3); the issue mirror writes through server/issues/forge-write.ts. `cwd` is any
 * directory: the issue or repository is named in full, so no checkout is needed.
 */
export class ForgeIssues {
  private readonly cli: ForgeCli;

  constructor(cli: ForgeCli) {
    this.cli = cli;
  }

  /** The issue's state and the PR/MRs that closed it; undefined when the forge did not answer. */
  async state(issue: { forge: "github" | "gitlab"; host: string; repo: string; number: number; url: string }, cwd: string): Promise<IssueState | undefined> {
    if (!REPO_PATH.test(issue.repo) || !HOST.test(issue.host)) return undefined;
    if (issue.forge === "github") {
      const result = await this.cli.exec("gh", ["issue", "view", issue.url, "--json", "state,closedByPullRequestsReferences"], cwd, TIMEOUT_MS);
      const read = result.code === 0 ? parse<GhIssue>(result.stdout) : undefined;
      if (!read?.state) return undefined;
      const closed = read.state.toUpperCase() === "CLOSED";
      return { state: closed ? "closed" : "open", closedBy: closed ? (read.closedByPullRequestsReferences ?? []).flatMap((pr) => (pr.url ? [pr.url] : [])) : [] };
    }
    const path = `projects/${encodeURIComponent(issue.repo)}/issues/${issue.number}`;
    const result = await this.cli.exec("glab", ["api", "--hostname", issue.host, path], cwd, TIMEOUT_MS);
    const read = result.code === 0 ? parse<GlabIssue>(result.stdout) : undefined;
    if (!read?.state) return undefined;
    if (read.state !== "closed") return { state: "open", closedBy: [] };
    const by = await this.cli.exec("glab", ["api", "--hostname", issue.host, `${path}/closed_by`], cwd, TIMEOUT_MS);
    const mrs = by.code === 0 ? parse<{ web_url?: string }[]>(by.stdout) : undefined;
    return { state: "closed", closedBy: (Array.isArray(mrs) ? mrs : []).flatMap((mr) => (mr.web_url ? [mr.web_url] : [])) };
  }

  /** The repository's open issues, newest first, at most `max`; `more` when the forge has others. */
  async list(repo: { forge: "github" | "gitlab"; host: string; repo: string }, filter: IssueFilter, cwd: string, max: number): Promise<IssueList> {
    if (!REPO_PATH.test(repo.repo) || !HOST.test(repo.host)) return { ok: false, error: `${repo.host}/${repo.repo} is not a repository path the forge CLIs are given` };
    const label = filter.label?.trim();
    const milestone = filter.milestone?.trim();
    // `--flag=value`, so a value starting with "-" is never read as another flag.
    if (repo.forge === "github") {
      const args = ["issue", "list", "-R", `${repo.host}/${repo.repo}`, "--state", "open", "--limit", String(max + 1), "--json", "number,title,url,labels,milestone,body"];
      if (label) args.push(`--label=${label}`);
      if (milestone) args.push(`--milestone=${milestone}`);
      const result = await this.cli.exec("gh", args, cwd, TIMEOUT_MS);
      if (result.code !== 0) return { ok: false, error: cliError(result, "gh issue list") };
      const read = parse<GhIssue[]>(result.stdout);
      if (!Array.isArray(read)) return { ok: false, error: "gh issue list answered something that is not a list of issues" };
      const issues = read.map((i): ForgeIssue => ({
        number: i.number,
        title: i.title,
        url: i.url,
        labels: (i.labels ?? []).flatMap((l) => (l?.name ? [l.name] : [])),
        milestone: i.milestone?.title ?? "",
        body: i.body ?? "",
      }));
      return { ok: true, issues: issues.slice(0, max), more: issues.length > max };
    }
    const args = ["issue", "list", "-R", `https://${repo.host}/${repo.repo}`, "-O", "json", "-P", String(max + 1)];
    if (label) args.push(`--label=${label}`);
    if (milestone) args.push(`--milestone=${milestone}`);
    const result = await this.cli.exec("glab", args, cwd, TIMEOUT_MS);
    if (result.code !== 0) return { ok: false, error: cliError(result, "glab issue list") };
    const read = parse<GlabIssue[]>(result.stdout);
    if (!Array.isArray(read)) return { ok: false, error: "glab issue list answered something that is not a list of issues" };
    const issues = read.map((i): ForgeIssue => ({
      number: i.iid,
      title: i.title,
      url: i.web_url,
      labels: (i.labels ?? []).flatMap((l) => (typeof l === "string" ? [l] : l?.name ? [l.name] : [])),
      milestone: i.milestone?.title ?? "",
      body: i.description ?? "",
    }));
    return { ok: true, issues: issues.slice(0, max), more: issues.length > max };
  }
}

function newestFirst(a: ForgePr, b: ForgePr): number {
  return Number(b.label.slice(1)) - Number(a.label.slice(1));
}
