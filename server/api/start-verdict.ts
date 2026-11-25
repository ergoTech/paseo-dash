import { hasLiveRun, type Task, unheld } from "../../shared/model.ts";
import type { StartDecision } from "../../shared/api.ts";
import type { Dashboard } from "../dashboard.ts";
import type { Plan } from "../plan/load.ts";
import { needOf, runActivity } from "../needs.ts";
import { blockingTasks, humanWork } from "./view.ts";

/**
 * What starting a task from ChatGPT does now, for one task or a set the user named (06-god-mode.md,
 * Starting a set of tasks). One classification for start_check, start_plan and start_tasks, so the
 * read-back, the plan and the start cannot disagree. Pure: the start checks (planStart) are made by
 * the caller and passed in as `refusal`.
 */

export interface Wait {
  id: string;
  title: string;
  status: string;
  in_set: boolean;
}

export interface Verdict {
  decision: StartDecision;
  /** 1 starts first; the same order may run at once; 0 not started from this set. */
  order: number;
  reason: string;
  next: string;
  waits_for: Wait[];
  /** With a live run: what its agent does; else "". */
  activity: string;
  /** With needs_owner: draft, review, human_label or a needs_you kind; else "". */
  needs: string;
}

export interface SetItem {
  plan: Plan;
  task: Task;
  /** Why a start would be refused apart from what it waits for (planStart past every blocker); "" when it would go. */
  refusal: string;
}

export const LAUNCHING_MEANS = "launching: claimed for this Mac, its worktree and agent are being created; not working yet";

const DRAFT_NEXT =
  "an inbox draft is not a task to start; only if the user asks to start this draft itself: accept it (update_task status todo), then start it";
const REVIEW_NEXT = "the user tests and accepts the work (accept_task) or sends it back (send_back); never accept it for them";

const HUMAN_NEXT =
  "the user does this work, or removes the label; an agent starts it only if the user asks to start this one task by itself: start_task, whose read-back says the label";

const HUMAN_HELD_NEXT = "the user does this work, or removes the label; a start of it alone would be refused now too: tell the user both reasons";

/** What a start of an unheld task says it claims: the status no run of this dashboard holds. */
export const UNHELD_REASON = (status: string) => `${status} with no live run (set outside the dashboard); a start claims it for a new run`;

const verdict = (decision: StartDecision, reason: string, next: string, extra: Partial<Verdict> = {}): Verdict => ({
  decision,
  order: 0,
  reason,
  next,
  waits_for: [],
  activity: "",
  needs: "",
  ...extra,
});

/**
 * A task that is not a free todo: a run holds it, it waits for the user, or it is finished. Undefined
 * for a todo task with no live run, whose start the blockers and the start checks decide.
 */
function stateVerdict(dashboard: Dashboard, task: Task, host: string): Verdict | undefined {
  if (hasLiveRun(task)) {
    const activity = runActivity(dashboard, task, host);
    const need = needOf(dashboard, task, host);
    if (need) return verdict("needs_owner", need.why, need.next, { activity, needs: need.kind });
    if (task.status === "review") return verdict("needs_owner", "its work is in review", REVIEW_NEXT, { activity, needs: "review" });
    const where = task.run_host && task.run_host !== host ? ` on ${task.run_host}` : "";
    const doing = activity === "launching" ? LAUNCHING_MEANS : `its agent is ${activity}${where}`;
    return verdict("already_started", `already started: ${doing}`, "nothing to start; follow it in overview (running) or task", { activity });
  }
  switch (task.status) {
    case "inbox":
      return verdict("needs_owner", "an inbox draft, not accepted as a task", DRAFT_NEXT, { needs: "draft" });
    case "review":
      return verdict("needs_owner", "its work is in review", REVIEW_NEXT, { needs: "review" });
    // In progress with no live run (unheld) starts as a todo task does: the start checks decide.
    case "done":
    case "canceled":
      return verdict("finished", `it is ${task.status}`, "nothing to start");
    default:
      return undefined;
  }
}

/** A task outside the set that will be done without this set: a run holds it, or its work is in review. */
function underWay(task: Task): boolean {
  return hasLiveRun(task) || task.status === "in_progress" || task.status === "review";
}

/**
 * The verdict of every task of a set, in starting order: what waits for what inside the set, which
 * prerequisites first, which may run at once. A task waiting for one outside the set starts after it
 * only when that one is under way; otherwise nothing in the set finishes it and it is blocked.
 */
export function decideSet(dashboard: Dashboard, host: string, items: SetItem[]): Map<string, Verdict> {
  const byId = new Map(items.map((item) => [item.task.id, item]));
  const out = new Map<string, Verdict>();
  const visiting = new Set<string>();

  const decide = (item: SetItem): Verdict => {
    const done = out.get(item.task.id);
    if (done) return done;
    const { plan, task } = item;
    const state = stateVerdict(dashboard, task, host);
    if (state) {
      out.set(task.id, state);
      return state;
    }
    // Before the start checks: a person's work waits for the person whatever an agent's start would meet.
    const human = humanWork(plan, task);
    if (human) {
      // A start of it alone would meet the same objections: say them rather than point to start_task.
      const blockers = blockingTasks(plan, task);
      const also = item.refusal || (blockers.length ? `it waits for ${blockers.map((b) => b.text).join("; ")}` : "");
      const owners = verdict("needs_owner", also ? `${human}; also ${also}` : human, also ? HUMAN_HELD_NEXT : HUMAN_NEXT, { needs: "human_label" });
      out.set(task.id, owners);
      return owners;
    }
    if (item.refusal) {
      const refused = verdict("refused", item.refusal, "nothing starts until this is fixed: tell the user the reason");
      out.set(task.id, refused);
      return refused;
    }
    visiting.add(task.id);
    const waits: Wait[] = [];
    const stuck: string[] = [];
    let order = 1;
    for (const blocker of blockingTasks(plan, task)) {
      const other = plan.entities.get(blocker.id)?.entity;
      const inSet = byId.get(blocker.id);
      waits.push({ id: blocker.id, title: other?.title ?? "(not found)", status: other?.status ?? "missing", in_set: Boolean(inSet) });
      if (inSet) {
        if (visiting.has(blocker.id)) {
          stuck.push(`${blocker.text}, which waits for it in turn`);
          continue;
        }
        const theirs = decide(inSet);
        if (theirs.decision === "can_start" || theirs.decision === "after_prerequisites") order = Math.max(order, theirs.order + 1);
        // Under way and waiting for the user (in review, its agent asking): it gets done as it would outside the set.
        else if (theirs.decision === "already_started" || (theirs.decision === "needs_owner" && underWay(inSet.task))) order = Math.max(order, 2);
        else stuck.push(`${blocker.text}, which ${theirs.decision === "needs_owner" ? "waits for the user" : `is ${theirs.decision.replace(/_/g, " ")}`}`);
      } else if (other?.type === "task" && underWay(other)) {
        order = Math.max(order, 2);
      } else {
        stuck.push(other?.type === "task" ? `${blocker.text}, not started and not in this set` : blocker.text);
      }
    }
    visiting.delete(task.id);
    let result: Verdict;
    if (stuck.length) {
      result = verdict("blocked", `waits for ${stuck.join("; ")}`, "start what it waits for first, or name it in the same set; or the user decides it", { waits_for: waits });
    } else if (waits.length) {
      const names = waits.map((w) => w.id).join(", ");
      result = verdict(
        "after_prerequisites",
        `waits for ${names} to be done`,
        `starts once ${names} ${waits.length === 1 ? "is" : "are"} done, only as part of a set the user confirmed (start_tasks queues it); start_task alone refuses it now`,
        { order, waits_for: waits },
      );
    } else {
      result = verdict("can_start", unheld(task) ? `${UNHELD_REASON(task.status)}, nothing to wait for, its project mapped here` : "todo, nothing to wait for, its project mapped here", "", { order: 1 });
    }
    out.set(task.id, result);
    return result;
  };

  for (const item of items) decide(item);
  return out;
}

/** The waits as start_check says them: "LAC-5RT2M «TOTP contract» (in_progress)". */
export function waitsText(waits: Wait[]): string {
  return waits.map((w) => `${w.id} «${w.title}» (${w.status})`).join("; ");
}
