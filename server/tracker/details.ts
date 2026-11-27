import { RESULT_FILES } from "../../shared/ui.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { type CommandRunner, forgeOf, prUrlOfProject, systemCommand } from "./forge.ts";

/**
 * A PR/MR as a person reviews it from the task screen: state, changed files, checks and review,
 * from `gh pr view` and `glab mr view` in the project's checkout. Read only when the screen asks;
 * the PR/MR tracker (prs.ts) decides transitions and never needs these.
 */

export interface PrDetails {
  url: string;
  label: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  base: string;
  head: string;
  changes: { files: number; at_least: boolean; additions: number | null; deletions: number | null; list: { path: string; additions: number; deletions: number }[]; more: number } | null;
  checks: { state: "passing" | "failing" | "pending" | "waiting" | "none"; passed: number; failed: number; pending: number; failing: string[]; url: string } | null;
  review: string;
  /** Whether the forge would merge it now (an open one); "unknown" while it is still working it out. */
  merge: { state: "yes" | "no" | "unknown"; why: string };
  /** What the forge names of a merged one and of the branch it came from: the merge commit, the head, when. */
  merged_at: string;
  merge_sha: string;
  head_sha: string;
  created_at: string;
  /** From a fork, or its repository is not told: not the project's own work. */
  fork: boolean;
  /** At least one check succeeded: skipped and neutral ones pass a PR/MR's summary but verify nothing. */
  verified: boolean;
}

const TIMEOUT_MS = 15_000;
const FAILING_NAMES = 10;
const GH_FIELDS = "number,url,title,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,files,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus,mergedAt,mergeCommit,headRefOid,createdAt,isCrossRepository";

interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  workflowName?: string;
  startedAt?: string;
}

interface GhView {
  number: number;
  url: string;
  title?: string;
  state: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: { path: string; additions: number; deletions: number }[] | null;
  statusCheckRollup?: GhCheck[] | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  headRefOid?: string;
  createdAt?: string;
  isCrossRepository?: boolean;
}

interface GlabView {
  iid: number;
  web_url: string;
  title?: string;
  state: string;
  draft?: boolean;
  source_branch?: string;
  target_branch?: string;
  changes_count?: string | null;
  head_pipeline?: { status?: string; web_url?: string } | null;
  detailed_merge_status?: string | null;
  has_conflicts?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string;
  created_at?: string;
  source_project_id?: number;
  target_project_id?: number;
}

function parse<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

/** CheckRun conclusions that do not fail a PR, as GitHub's own summary counts them. */
const PASSING_RUN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** CheckRun conclusions gh's summary treats as not finished. */
const PENDING_RUN = new Set(["STALE", ""]);

export function ghChecks(rollup: GhCheck[] | null | undefined): PrDetails["checks"] {
  // A rerun repeats a check of the same workflow; the one started last is its current state. Checks
  // of two workflows that share a name are two checks.
  const latest = new Map<string, { check: GhCheck; name: string }>();
  (rollup ?? []).forEach((check, index) => {
    const name = check.name || check.context || `check ${index + 1}`;
    const key = `${check.workflowName ?? ""}\u0000${name}`;
    const known = latest.get(key);
    if (!known || (check.startedAt ?? "") >= (known.check.startedAt ?? "")) latest.set(key, { check, name });
  });
  let passed = 0;
  let pending = 0;
  const failing: string[] = [];
  for (const { check, name } of latest.values()) {
    if (check.__typename === "StatusContext" || (check.state && !check.status)) {
      const state = (check.state ?? "").toUpperCase();
      if (state === "SUCCESS") passed += 1;
      else if (state === "PENDING" || state === "EXPECTED") pending += 1;
      else failing.push(name);
      continue;
    }
    const conclusion = (check.conclusion ?? "").toUpperCase();
    if ((check.status ?? "").toUpperCase() !== "COMPLETED" || PENDING_RUN.has(conclusion)) pending += 1;
    else if (PASSING_RUN.has(conclusion)) passed += 1;
    else failing.push(name);
  }
  const state = failing.length ? "failing" : pending ? "pending" : passed ? "passing" : "none";
  return { state, passed, failed: failing.length, pending, failing: failing.slice(0, FAILING_NAMES), url: "" };
}

const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };
/**
 * GitLab's `detailed_merge_status` values that say something about review. Required approvals are a
 * paid feature; whether Community Edition reports `requested_changes` is not verified.
 */
const GITLAB_REVIEW: Record<string, string> = { not_approved: "review required", requested_changes: "changes requested" };

/** GitHub's `mergeable` and `mergeStateStatus` as one answer: yes only when the forge itself would merge it. */
export function ghMerge(view: Pick<GhView, "mergeable" | "mergeStateStatus" | "isDraft">): PrDetails["merge"] {
  const state = (view.mergeStateStatus ?? "").toUpperCase();
  const mergeable = (view.mergeable ?? "").toUpperCase();
  if (view.isDraft || state === "DRAFT") return { state: "no", why: "it is a draft" };
  if (mergeable === "CONFLICTING" || state === "DIRTY") return { state: "no", why: "it conflicts with its base branch" };
  if (state === "BEHIND") return { state: "no", why: "its branch is behind its base: update it" };
  if (state === "BLOCKED") return { state: "no", why: "the forge blocks the merge (a required check or review is missing)" };
  if (mergeable === "MERGEABLE" && (state === "CLEAN" || state === "HAS_HOOKS" || state === "UNSTABLE")) return { state: "yes", why: "" };
  return { state: "unknown", why: "the forge has not worked out whether it can be merged" };
}

/** GitLab's `detailed_merge_status` the same way. */
export function glabMerge(view: Pick<GlabView, "detailed_merge_status" | "has_conflicts" | "draft">): PrDetails["merge"] {
  const status = view.detailed_merge_status ?? "";
  if (view.draft || status === "draft_status") return { state: "no", why: "it is a draft" };
  if (view.has_conflicts || status === "conflict") return { state: "no", why: "it conflicts with its target branch" };
  if (status === "mergeable") return { state: "yes", why: "" };
  if (["checking", "unchecked", "preparing", "approvals_syncing", ""].includes(status)) return { state: "unknown", why: "the forge has not worked out whether it can be merged" };
  return { state: "no", why: `the forge says: ${status.replace(/_/g, " ")}` };
}

function fromGh(view: GhView): PrDetails {
  const upper = view.state.toUpperCase();
  const state = upper === "MERGED" ? "merged" : upper === "OPEN" ? (view.isDraft ? "draft" : "open") : "closed";
  const files = view.files ?? [];
  const list = files.slice(0, RESULT_FILES).map(({ path, additions, deletions }) => ({ path, additions, deletions }));
  const count = view.changedFiles ?? files.length;
  return {
    url: view.url,
    label: `#${view.number}`,
    title: view.title ?? "",
    state,
    base: view.baseRefName ?? "",
    head: view.headRefName ?? "",
    changes: { files: count, at_least: false, additions: view.additions ?? null, deletions: view.deletions ?? null, list, more: Math.max(0, count - list.length) },
    checks: ghChecks(view.statusCheckRollup),
    review: REVIEW[(view.reviewDecision ?? "").toUpperCase()] ?? "",
    merge: ghMerge(view),
    merged_at: view.mergedAt ?? "",
    merge_sha: upper === "MERGED" ? (view.mergeCommit?.oid ?? "") : "",
    head_sha: view.headRefOid ?? "",
    created_at: view.createdAt ?? "",
    fork: view.isCrossRepository !== false,
    verified: (view.statusCheckRollup ?? []).some((check) => (check.conclusion ?? check.state ?? "").toUpperCase() === "SUCCESS"),
  };
}

/** GitLab pipeline statuses that failed it, and those that wait for a person or a schedule. */
const PIPELINE_FAILED = new Set(["failed", "canceled"]);
const PIPELINE_WAITING = new Set(["manual", "scheduled"]);

function fromGlab(view: GlabView): PrDetails {
  const state = view.state === "merged" ? "merged" : view.state === "opened" ? (view.draft ? "draft" : "open") : "closed";
  // A string, "1000+" past GitLab's limit.
  const files = Number.parseInt(view.changes_count ?? "", 10);
  const pipeline = view.head_pipeline;
  const status = pipeline?.status ?? "";
  const checks: PrDetails["checks"] = !pipeline || status === "skipped"
    ? { state: "none", passed: 0, failed: 0, pending: 0, failing: [], url: pipeline?.web_url ?? "" }
    : status === "success"
      ? { state: "passing", passed: 1, failed: 0, pending: 0, failing: [], url: pipeline.web_url ?? "" }
      : PIPELINE_FAILED.has(status)
        ? { state: "failing", passed: 0, failed: 1, pending: 0, failing: [`pipeline ${status}`], url: pipeline.web_url ?? "" }
        : PIPELINE_WAITING.has(status)
          ? { state: "waiting", passed: 0, failed: 0, pending: 1, failing: [], url: pipeline.web_url ?? "" }
          : { state: "pending", passed: 0, failed: 0, pending: 1, failing: [], url: pipeline.web_url ?? "" };
  return {
    url: view.web_url,
    label: `!${view.iid}`,
    title: view.title ?? "",
    state,
    base: view.target_branch ?? "",
    head: view.source_branch ?? "",
    changes: Number.isFinite(files) ? { files, at_least: (view.changes_count ?? "").endsWith("+"), additions: null, deletions: null, list: [], more: files } : null,
    checks,
    review: GITLAB_REVIEW[view.detailed_merge_status ?? ""] ?? "",
    merge: glabMerge(view),
    merged_at: view.merged_at ?? "",
    merge_sha: state === "merged" ? (view.squash_commit_sha || view.merge_commit_sha || "") : "",
    head_sha: view.sha ?? "",
    created_at: view.created_at ?? "",
    fork: view.source_project_id === undefined || view.source_project_id !== view.target_project_id,
    verified: status === "success",
  };
}

/**
 * The GitLab MR's number when the URL names the project's own repository by path. Its web host may
 * differ from the remote's (`gitlab.example.com` serves `git@gitlab-ssh.example.com:…`), and `glab mr
 * view` reads the MR of the checkout's own project by number, so the path is what is compared.
 */
export function gitlabIid(url: string, remote: string): string | undefined {
  const match = /^https:\/\/[^/\s]+\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(url.trim());
  if (!match) return undefined;
  const path = normalizeRemote(remote).split("/").slice(1).join("/");
  return match[1] === path ? match[2] : undefined;
}

/** The details of one PR/MR of the project; throws with the CLI's reason when it cannot tell. */
export async function prDetails(cwd: string, remote: string, url: string, run: CommandRunner = systemCommand): Promise<PrDetails> {
  if (forgeOf(remote) === "github") {
    if (!prUrlOfProject(url, remote)) throw new Error(`${url} is not a pull request of ${normalizeRemote(remote)}`);
    const result = await run("gh", ["pr", "view", url, "--json", GH_FIELDS], cwd, TIMEOUT_MS);
    const view = result.code === 0 ? parse<GhView>(result.stdout) : undefined;
    if (!view?.url) throw new Error("gh could not read it: not installed on the daemon's PATH, not logged in (gh auth status), or no access to the repository");
    return fromGh(view);
  }
  const iid = gitlabIid(url, remote);
  if (!iid) throw new Error(`${url} is not a merge request of ${normalizeRemote(remote)}`);
  const result = await run("glab", ["mr", "view", iid, "-F", "json"], cwd, TIMEOUT_MS);
  const view = result.code === 0 ? parse<GlabView>(result.stdout) : undefined;
  if (!view?.web_url) throw new Error("glab could not read it: not installed on the daemon's PATH, not logged in to this GitLab (glab auth status), or no access to the project");
  // glab picks the project from the checkout's remotes: an MR of another project (a fork's remote,
  // a hand-mapped checkout) is not this task's.
  if (gitlabIid(view.web_url, remote) !== iid) throw new Error(`glab answered with ${view.web_url}, which is not ${url}`);
  return fromGlab(view);
}
