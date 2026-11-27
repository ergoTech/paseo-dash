import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { RECONCILE_LEFT, type reconcileRpc } from "../../shared/api.ts";
import { hasLiveRun, type Task } from "../../shared/model.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import { type MergedPr, mergedCandidates } from "../tracker/merged.ts";
import { webHostProblem } from "../tracker/web-host.ts";
import type { Dashboard } from "../dashboard.ts";
import type { Verdict } from "../reconcile/verdict.ts";
import { cut } from "./view.ts";
import type { ReadContext } from "./reads.ts";
import { resolveSpaces, resolveTaskForRead, type SpaceEntry } from "./resolve.ts";

/**
 * Work merged on the forge while its task stayed open (06-god-mode.md, Reconcile): what was merged,
 * by which commit and branch, how it is tied to the task, what of its acceptance is still open and
 * what a person does now. Merged code is not accepted work: nothing here changes a task, and a start
 * of such a task says what was merged first (server/api/start-verdict.ts).
 */

type Reconcile = RpcOutput<typeof reconcileRpc>;
type Row = Reconcile["tasks"][number];

/** How long a read of one task waits for its forge (Paseo stops waiting at 30 s). */
const TASK_WAIT_MS = 20_000;
/** Rows a read of a whole space lists. */
const ROWS = 20;

/** The merged work's short name: "!412 (5e1f0c4) on chore/erg-7mrg1-…", several joined. */
export function mergedText(merged: MergedPr[]): string {
  return merged
    .map((pr) => `${pr.label}${pr.sha ? ` (${pr.sha.slice(0, 7)})` : ""}${pr.branch ? ` on ${pr.branch}` : ""}`)
    .join(", ");
}

/** What a person does about a task whose work is merged: never "done" by itself, never a second implementation. */
export function reconcileNext(merged: MergedPr[], acceptance: { done: boolean }[]): string {
  const where = mergedText(merged);
  const open = acceptance.filter((a) => !a.done).length;
  if (!acceptance.length) return `its work is merged in ${where}; it lists no acceptance: check the PR/MR, then mark it done (update_task status done). Do not start it again for the same work.`;
  if (!open) return `its work is merged in ${where} and every acceptance line is ticked: mark it done after a look (update_task status done). Do not start it again.`;
  return `its code is merged in ${where}, but ${open} of ${acceptance.length} acceptance lines are open (QA, manual or live checks): do those and tick them, then mark it done. Start it again only for what is left, never to redo the merged work.`;
}

function row(task: Task, loaded: LoadedEntity, merged: MergedPr[], held?: Verdict, rule?: string): Row {
  const open = loaded.acceptance.filter((a) => !a.done).map((a) => cut(a.text, 200));
  const first = held?.holds[0];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    project: task.project ?? "",
    merged: merged.map((pr) => ({ pr: pr.label, url: pr.url, sha: pr.sha ?? "", branch: pr.branch ?? "", merged_at: pr.merged_at, by: pr.by.join(", ") })),
    left: open.slice(0, RECONCILE_LEFT),
    left_count: open.length,
    next: held ? (first ? first.next : "nothing: everything is verified and the rule closes it") : merged.length ? reconcileNext(merged, loaded.acceptance) : "",
    ...(held ? { verdict: held.close ? ("closes" as const) : ("held" as const), diagnosis: first ? cut(first.text, 300) : "", sources: held.sources.filter((s) => s.url), rule: rule ?? "" } : {}),
  };
}

/** What this Mac's reconciliation knows of a card, as a row; undefined for a project it does not reconcile. */
function watchedRow(dashboard: Dashboard, space: SpaceEntry, task: Task, loaded: LoadedEntity): Row | undefined {
  const rule = dashboard.reconciler.rule(space, task);
  const verdict = rule ? dashboard.reconciler.verdict(space, task) : undefined;
  if (!rule || !verdict) return undefined;
  const facts = dashboard.reconciler.latest(space, task);
  const merged: MergedPr[] = (facts?.prs ?? [])
    .filter((pr) => pr.own && pr.state === "merged")
    .map((pr) => ({ label: pr.label, url: pr.url, merged_at: pr.mergedAt, sha: pr.mergeSha, branch: pr.head, by: [] }));
  return row(task, loaded, merged, verdict, rule.mode);
}

/** Each GitLab project of the spaces whose web host is not the one its forge serves, with the fix. */
export function hostProblems(dashboard: Dashboard, spaces: SpaceEntry[]): Reconcile["projects"] {
  const out: Reconcile["projects"] = [];
  for (const space of spaces) {
    const plan = space.sync.plan;
    for (const [key, project] of Object.entries(plan.space?.projects ?? {})) {
      const verdict = dashboard.webHosts.peek(plan, key, project);
      const problem = verdict ? webHostProblem(key, verdict) : "";
      if (problem) out.push({ space: space.record.key, project: key, problem });
    }
  }
  return out;
}

/** Why a task's merged work is not looked for: it has a live run, it is finished, or it has no project. */
function notFollowed(plan: Plan, task: Task): string {
  if (hasLiveRun(task)) return `${task.id} has a live run: its own PR/MR is followed by the run (task, task_result).`;
  if (task.status === "done" || task.status === "canceled") return `${task.id} is ${task.status}.`;
  if (task.status === "review") return `${task.id} is in review: its acceptance is the owner's (accept_check).`;
  if (!task.project || !plan.space?.projects[task.project]) return `${task.id} has no project of its space, so no repository to look in.`;
  return `${task.id} has no creation time to compare merges with.`;
}

export async function reconcile(ctx: ReadContext, input: RpcInput<typeof reconcileRpc>): Promise<Reconcile> {
  const fail = (error: string): Reconcile => ({ tasks: [], projects: [], note: "", error });
  const dashboard = ctx.dashboard;
  if (!dashboard.owner && dashboard.ownerReason) return fail(dashboard.ownerReason);
  if (input.task) {
    const { found } = resolveTaskForRead([...dashboard.spaces.values()], input.task);
    if (!found.ok) return fail(found.error);
    const { entity: task, loaded, space } = found.value;
    const plan = space.sync.plan;
    const projects = hostProblems(dashboard, [space]).filter((p) => p.project === task.project);
    if (dashboard.reconciler.rule(space, task)) {
      await dashboard.reconciler.factsFor(space, task, TASK_WAIT_MS);
      const watched = watchedRow(dashboard, space, task, loaded);
      if (watched) return { tasks: [watched], projects, note: "", error: "" };
    }
    if (!mergedCandidates(plan, task)) return { tasks: [], projects, note: notFollowed(plan, task), error: "" };
    const mapped = task.project ? space.record.mapping[task.project] : undefined;
    if (!mapped) return { tasks: [], projects, note: `Project ${task.project} is not mapped on this Mac: its forge cannot be asked from here.`, error: "" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), TASK_WAIT_MS);
    });
    const answered = await Promise.race([dashboard.merged.check({ sync: space.sync, mapping: space.record.mapping }, task, { search: true }).then(() => "read" as const), late]).finally(() => clearTimeout(timer));
    const merged = dashboard.merged.shown(plan, task);
    const note =
      answered === "late"
        ? "The forge did not answer in time; this is the last reading, the check goes on: read again in a minute."
        : merged.length
          ? ""
          : `No merged PR/MR of ${task.project} names ${task.id} in its title, description or branch, is on its branch or links, or closed its issue.`;
    return { tasks: merged.length ? [row(task, loaded, merged)] : [], projects, note, error: "" };
  }
  const spaces = resolveSpaces(dashboard, input.space);
  if (!spaces.ok) return fail(spaces.error);
  const rows: Row[] = [];
  // Cards only the closing rule holds, without merged work: listed after those with it, counted apart.
  const heldRows: Row[] = [];
  let total = 0;
  let held = 0;
  for (const space of spaces.value) {
    for (const loaded of space.sync.plan.entities.values()) {
      const task = loaded.entity;
      if (task.type !== "task") continue;
      const watched = watchedRow(dashboard, space, task, loaded);
      const merged = dashboard.merged.shown(space.sync.plan, task);
      if (watched?.merged.length || merged.length) {
        total += 1;
        if (rows.length < ROWS) rows.push(watched ?? row(task, loaded, merged));
      } else if (watched) {
        held += 1;
        if (heldRows.length < ROWS) heldRows.push(watched);
      }
    }
  }
  dashboard.merged.peek();
  const note = `${total ? `${total} open task${total === 1 ? "" : "s"} with merged work${total > ROWS ? `, the first ${ROWS} listed` : ""}` : "No open task has merged work"} as this Mac last read its forges; name one task to ask its forge now.`;
  return {
    tasks: [...rows, ...heldRows].slice(0, ROWS),
    projects: hostProblems(dashboard, spaces.value),
    note: held ? `${note} ${held} more open card${held === 1 ? "" : "s"} without merged work held by this Mac's closing rule.` : note,
    error: "",
  };
}
