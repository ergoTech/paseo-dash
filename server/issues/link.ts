import type { Task } from "../../shared/model.ts";
import { type IssueForge, type IssueRef, issueLabel, parseIssueUrl } from "../../shared/issues.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { forgeOf } from "../tracker/forge.ts";

/**
 * A task's link to a forge issue at start (09-forge-issues.md, option b): which closing keyword its
 * PR/MR description needs, and whether a merge can close the issue at all. The forge closes an issue
 * only for a PR/MR into the repository's default branch, and only on the same forge [H3][G3].
 */

/** Where a project's PR/MRs live: the forge, its web host (space.yaml's `web_host`, else the remote's host) and the path. */
export interface ProjectRepo {
  forge: IssueForge;
  host: string;
  repo: string;
}

/** A project of space.yaml, as far as issue links need it. */
export interface ProjectLink {
  remote: string;
  web_host?: string;
  trunk?: string;
}

export function projectRepo(project: ProjectLink): ProjectRepo | undefined {
  const normal = normalizeRemote(project.remote);
  const slash = normal.indexOf("/");
  if (slash <= 0 || slash === normal.length - 1) return undefined;
  const host = project.web_host ?? normal.slice(0, slash);
  const forge = host === "github.com" || forgeOf(project.remote) === "github" ? "github" : "gitlab";
  return { forge, host, repo: normal.slice(slash + 1) };
}

/** The repository's web URL, for the forge CLIs and for people: `https://gitlab.example.com/frontend/site`. */
export function repoWebUrl(repo: ProjectRepo): string {
  return `https://${repo.host}/${repo.repo}`;
}

export type ClosingReference = { ok: true; keyword: string } | { ok: false; reason: string };

/**
 * The line a PR/MR of `project` needs to close `issue`: `Closes #N` in the same repository,
 * `Closes owner/repo#N` (GitHub) or `Closes group/project#N` (GitLab) in another repository of the
 * same forge; none across forges.
 */
export function closingReference(issue: IssueRef, project: ProjectRepo | undefined): ClosingReference {
  if (!project) return { ok: false, reason: "the project's remote does not name a repository" };
  if (issue.forge !== project.forge || issue.host !== project.host) {
    // The same repository path on another host is most often a web host space.yaml does not name yet:
    // said as a check to make, never assumed (server/tracker/web-host.ts asks the forge).
    const sameRepo = issue.forge === project.forge && issue.repo.toLowerCase() === project.repo.toLowerCase();
    const fix = sameRepo ? `; if ${issue.host} serves the same repository, set the project's web host to ${issue.host} in Projects (reconcile says what the forge answers)` : "";
    return { ok: false, reason: `the issue is on ${issue.host} and the project on ${project.host}; a merge on one forge cannot close an issue on another${fix}` };
  }
  const same = issue.repo.toLowerCase() === project.repo.toLowerCase();
  return { ok: true, keyword: same ? `Closes #${issue.number}` : `Closes ${issue.repo}#${issue.number}` };
}

/** The start prompt's "## Issue" section; empty when the task has no usable issue link. */
export function issueSection(task: Pick<Task, "issue">, project: ProjectLink | undefined): string {
  const issue = parseIssueUrl(task.issue);
  if (!issue) return "";
  const reference = closingReference(issue, project ? projectRepo(project) : undefined);
  const text = reference.ok
    ? `This task stands for the issue ${issue.url}. Put the line "${reference.keyword}" in the merge request's description, so that the forge closes the issue when the merge request is merged into the default branch.`
    : `This task stands for the issue ${issue.url}. It is on another forge than this repository, so the merge cannot close it; mention the link in the merge request's description.`;
  return `## Issue\n\n${text}`;
}

export interface ClosureInput {
  task: Pick<Task, "issue" | "base">;
  project: ProjectLink | undefined;
  /** The repository's default branch as the checkout knows it (origin/HEAD); undefined when unknown. */
  defaultBranch: string | undefined;
}

/**
 * What the start confirmation says about the task's issue: whether the merge closes it, and when it
 * cannot (another forge, a feature-branch base, a trunk that is not the default branch). Empty when
 * the task has no issue.
 */
export function closureFact({ task, project, defaultBranch }: ClosureInput): string {
  if (!task.issue) return "";
  const issue = parseIssueUrl(task.issue);
  if (!issue) return `The task's issue link is not an issue URL, so no merge will close it.`;
  const name = `Its issue ${issueLabel(issue)}`;
  const repo = project ? projectRepo(project) : undefined;
  const reference = closingReference(issue, repo);
  if (!reference.ok) return `${name} will not close by itself: ${reference.reason}.`;
  const kind = repo?.forge === "gitlab" ? "MR" : "PR";
  if (task.base && defaultBranch && task.base !== defaultBranch) {
    return `${name} will not close by itself: the task's base is ${task.base}, and the forge closes issues only for merges into the default branch ${defaultBranch}.`;
  }
  const trunk = task.base ?? project?.trunk;
  if (trunk && defaultBranch && trunk !== defaultBranch) {
    return `${name} will not close by itself: the project's base branch ${trunk} is not the repository's default branch ${defaultBranch}, and the forge closes issues only for merges into the default branch.`;
  }
  const setting = repo?.forge === "gitlab" ? " if the project closes referenced issues automatically (GitLab's setting)" : "";
  if (trunk && !defaultBranch) {
    return `${name} closes when the ${kind} with "${reference.keyword}" merges${setting}, provided ${trunk} is the repository's default branch (not checked: the checkout does not know its default branch).`;
  }
  return `${name} closes when the ${kind} with "${reference.keyword}" merges into ${defaultBranch ?? "the default branch"}${setting}.`;
}
