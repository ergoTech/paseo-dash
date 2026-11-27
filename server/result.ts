import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { hasLiveRun, type Task } from "../shared/model.ts";
import type { tasksSendBackRpc, uiTaskResultRpc } from "../shared/ui.ts";
import { type acceptCheckRpc, RESULT_FAILING, type tasksResultRpc } from "../shared/api.ts";
import { cut, localHost, localRun } from "./api/view.ts";
import { releaseCheck } from "./api/reads.ts";
import { resolveEntity, resolveTaskForRead } from "./api/resolve.ts";
import { continueTask, ownerError, type WriteContext } from "./api/writes.ts";
import type { PaseoApi } from "./paseo.ts";
import { type CommandRunner, forgeOf, systemCommand } from "./tracker/forge.ts";
import { prDetails } from "./tracker/details.ts";

/**
 * Reviewing a task's result from the task screen (04-ux.md, Review and close): what its PR/MR holds
 * now, and sending the agent a person's comment. God Mode reads the PR/MR's checks and review
 * through `tasks.result`, the same read without the changed files, sends work back through
 * `tasks.send-back` (`send_back`), and hears what accepting the work stands on through
 * `tasks.accept-check`, the read-back of `accept_task` (06-god-mode.md, Accepting and sending back).
 */

type TaskResult = RpcOutput<typeof uiTaskResultRpc>;
type TaskChecks = RpcOutput<typeof tasksResultRpc>;
type AcceptCheck = RpcOutput<typeof acceptCheckRpc>;
type SendBack = RpcOutput<typeof tasksSendBackRpc>;

/** The PR/MR the task screen names: the tracker's view of the live run, else the run's recorded one. */
export function resultUrl(ctx: WriteContext, task: Task): string {
  const seen = ctx.dashboard.prs.seen.get(task.id);
  if (hasLiveRun(task) && seen && seen.run_id === task.run_id) return seen.url;
  return task.run_pr ?? "";
}

interface ReadResult {
  task?: Task;
  /** The forge of the task's project, when it has a checkout here to ask. */
  forge?: "github" | "gitlab";
  result: TaskResult;
}

async function readResult(ctx: WriteContext, asked: string, run: CommandRunner): Promise<ReadResult> {
  const readAt = (ctx.now ?? (() => new Date()))().toISOString();
  const answer = (fields: Partial<TaskResult>): TaskResult => ({ pr: null, changes: null, checks: null, review: "", read_at: readAt, error: "", ...fields });
  const owner = ownerError(ctx);
  if (owner) return { result: answer({ error: owner }) };
  // A read that only shows: a vague name may still find the one task search points to.
  const { found } = resolveTaskForRead([...ctx.dashboard.spaces.values()], asked);
  if (!found.ok) return { result: answer({ error: found.error }) };
  const { entity: task, space } = found.value;
  const url = resultUrl(ctx, task);
  if (!url) return { task, result: answer({}) };
  const project = task.project ? space.sync.plan.space?.projects[task.project] : undefined;
  const projectId = task.project ? space.record.mapping[task.project] : undefined;
  const root = projectId ? ctx.dashboard.projectRoots.get(projectId) : undefined;
  const link = { url, label: "", title: "", state: "", base: "", head: "" };
  if (!project || !root) return { task, result: answer({ pr: link, error: `Project ${task.project ?? "(none)"} has no checkout on this Mac, so its forge cannot be asked; open the link instead.` }) };
  const forge = forgeOf(project.remote);
  try {
    const details = await prDetails(root, project.remote, url, run);
    const { changes, checks, review, merge: _merge, merged_at: _at, merge_sha: _sha, head_sha: _head, created_at: _created, fork: _fork, verified: _verified, ...pr } = details;
    return { task, forge, result: answer({ pr, changes, checks, review }) };
  } catch (error) {
    return { task, forge, result: answer({ pr: link, error: String((error as Error)?.message ?? error) }) };
  }
}

export async function taskResult(ctx: WriteContext, input: RpcInput<typeof uiTaskResultRpc>, run: CommandRunner = systemCommand): Promise<TaskResult> {
  return (await readResult(ctx, input.task, run)).result;
}

/** A failed check's name as God Mode reads it out; a check's name is any text its CI config gives. */
const CHECK_NAME_MAX = 100;

/**
 * The same read for God Mode (`tasks.result`), flat and without the changed files. An answer that
 * could not be read carries the link in `error` too: God Mode reads a refused read's reason aloud,
 * not its fields.
 */
export async function taskChecks(ctx: WriteContext, input: RpcInput<typeof tasksResultRpc>, run: CommandRunner = systemCommand): Promise<TaskChecks> {
  const { task, forge, result } = await readResult(ctx, input.task, run);
  const { pr, checks } = result;
  const url = pr?.url ?? "";
  const checksUrl = checks?.url || (forge === "github" && pr?.label ? `${url.replace(/\/+$/, "")}/checks` : "");
  return {
    id: task?.id ?? "",
    title: task?.title ?? "",
    pr: pr?.label ?? "",
    state: pr?.state ?? "",
    checks: checks?.state ?? "",
    failing: (checks?.failing ?? []).slice(0, RESULT_FAILING).map((name) => cut(name, CHECK_NAME_MAX)),
    review: result.review,
    passed: checks?.passed ?? 0,
    failed: checks?.failed ?? 0,
    pending: checks?.pending ?? 0,
    url,
    checks_url: checksUrl,
    pr_title: pr?.title ?? "",
    read_at: result.read_at,
    error: result.error && url && !result.error.includes(url) ? `${result.error.replace(/[.\s]*$/, ".")} Link: ${url}` : result.error,
  };
}

/** Failed checks a read-back names, and how much of each name; the rest are left to `task_result`. */
const SPOKEN_FAILING = 3;
const SPOKEN_CHECK_NAME_MAX = 40;

/**
 * The PR/MR in one line for a read-back. No counts: they change while CI runs, and God Mode asks
 * again when a shown field differs on the confirmed call; a change of state (pending to failing)
 * should, a counter should not.
 */
function resultLine({ forge, result }: ReadResult): string {
  const { pr, checks, review, error } = result;
  if (!pr) return error ? `the PR/MR could not be read: ${error}` : "no PR/MR";
  if (error) return `the PR/MR ${pr.url} could not be read: ${error}`;
  const kind = forge === "gitlab" ? "MR" : "PR";
  const failing = checks?.failing.length ? ` (${checks.failing.slice(0, SPOKEN_FAILING).map((name) => cut(name, SPOKEN_CHECK_NAME_MAX)).join(", ")})` : "";
  const ci = !checks || checks.state === "none" ? "no checks" : checks.state === "waiting" ? "checks waiting for a manual or scheduled job" : `checks ${checks.state}${failing}`;
  return `${kind} ${pr.label} ${pr.state}, ${ci}, ${review ? `review ${review}` : "no review decision"}`;
}

/**
 * The target of `accept_task` (`tasks.release` to done): who holds the task, as `release_task` says
 * it, what its PR/MR's checks and review are now, and what becomes of its agent, as `tasks.release`
 * does it. Only a task in review has work to accept; a release to done of any other stays
 * `release_task`'s.
 */
export async function acceptCheck(ctx: WriteContext, input: RpcInput<typeof acceptCheckRpc>, run: CommandRunner = systemCommand): Promise<AcceptCheck> {
  const empty = { title: "", held_by: "", host: "", since: "", result: "", agent: "" };
  const owner = ownerError(ctx);
  if (owner) return { ...empty, error: owner };
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return { ...empty, error: found.error };
  const task = found.value.entity;
  if (task.status !== "review") return { ...empty, error: `«${task.title}» (${task.id}) is ${task.status}, not in review: there is no work to accept. release_task sets it done anyway.` };
  const held = releaseCheck(ctx, { task: task.id });
  if (held.error) return { ...empty, error: held.error };
  const local = localRun(ctx.dashboard.runs, task);
  const agent =
    local?.agentId && local.activity !== "stopped"
      ? "its agent on this Mac is stopped; its chat stays"
      : !local && task.run_host && task.run_host !== localHost()
        ? `its agent on ${task.run_host} keeps running; stop it in its chat if it should`
        : "no agent of it runs on this Mac";
  return { ...held, result: resultLine(await readResult(ctx, task.id, run)), agent, error: "" };
}

/**
 * The comment as the agent reads it: from the user, about this task, and what to do with it. The
 * branch is the run's own, as its start prompt named it, never the plan's `run_branch`, which any
 * collaborator with push access can edit. An agent of a tracked workspace (`adopted`) may work in a
 * person's own checkout and has no report tool, so it hears neither "worktree" nor "report".
 */
export function feedbackText(task: Task, comment: string, branch: string, hasPr: boolean, adopted = false): string {
  const push = hasPr ? " and push to the same branch, so the open PR/MR is updated rather than replaced" : "";
  return [
    `Review feedback from the user on ${task.id} «${task.title}»:`,
    "",
    comment.trim(),
    "",
    adopted ? `Address it in this workspace on branch ${branch}${push}.` : `Address it in this worktree on branch ${branch}${push}. Report again when it is done.`,
  ].join("\n");
}

export async function sendBack(ctx: WriteContext, paseo: PaseoApi, input: RpcInput<typeof tasksSendBackRpc>): Promise<SendBack> {
  const fail = (error: string, status = ""): SendBack => ({ ok: false, status, note: "", error });
  const sent = (status: string, note = ""): SendBack => ({ ok: true, status, note, error: "" });
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const found = resolveEntity([...ctx.dashboard.spaces.values()], "task", input.task);
  if (!found.ok) return fail(found.error);
  const { entity: task } = found.value;
  const name = `«${task.title}» (${task.id})`;
  if (!hasLiveRun(task)) return fail(`${name} has no live run to send it to.`, task.status);
  const run = localRun(ctx.dashboard.runs, task);
  if (!run?.agentId) return fail(`${name} runs on ${task.run_host ?? "another machine"}; send it there.`, task.status);
  const agent = paseo.agents.ref(run.agentId);
  const snapshot = await agent.refresh();
  if (!snapshot || snapshot.agent.archivedAt) return fail(`The agent of ${name} is gone; start the task again or release it.`, task.status);
  // A message to a working agent would be mixed into its turn; it is sent once the agent waits.
  if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return fail(`The agent of ${name} is still working; send it once it waits, or write in its chat.`, task.status);
  // A reply goes as the person wrote it, like a message in the agent's chat.
  if (input.reply) {
    await agent.send(input.comment.trim());
    return sent(task.status);
  }
  await agent.send(feedbackText(task, input.comment, run.branch, Boolean(resultUrl(ctx, task)), Boolean(run.adopted)));
  // A tracked workspace's agent cannot report the work done again, and the tracker moves a run to
  // review only on a PR/MR it has not recorded yet: back in progress, the task would stay there until
  // the merge. So it stays in review, where its open PR/MR is (05-architecture.md, Tracking a Paseo
  // workspace as a task).
  if (task.status !== "review" || run.adopted) return sent(task.status);
  // The message is with the agent either way; a refused or unclear move is said, not hidden, and
  // not as `error`, which tells God Mode the comment was not sent.
  const moved = await continueTask(ctx, { task: task.id }).catch((error: unknown) => ({ ok: false, status: task.status, error: `unknown whether it moved: ${String((error as Error)?.message ?? error)}` }));
  return moved.ok ? sent(moved.status) : sent(task.status, `Sent, but the task stays in review: ${moved.error}`);
}
