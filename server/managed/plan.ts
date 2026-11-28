import type { QueueAction, QueueNeed } from "../../shared/managed-queue.ts";
import { sameLabel } from "../../shared/labels.ts";
import { closed, hasLiveRun, type Task, unheld } from "../../shared/model.ts";
import { classify } from "../api/candidates.ts";
import { instructionTexts, type ReadContext } from "../api/reads.ts";
import { reviewCards } from "../api/ready-review.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { blockingTasks, cut, plannedBranch, sortTasks, tasksOf } from "../api/view.ts";
import { chainsOf } from "../api/chains.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import { hashText } from "../runner/seen.ts";
import { confirmedDuplicates } from "./duplicates.ts";

/**
 * What the managed queue would do with each open card of its project, and why. It reads the plan,
 * this Mac's readings and the record of what the owner has seen; it writes nothing and asks no forge.
 * It builds on what the other reads say: start_candidates' groups (server/api/candidates.ts) for what
 * holds a card, and the ready review (server/api/ready-review.ts) for work done already, cards that
 * read alike and data that could not be read. A card is the queue's only when none of that holds it.
 *
 * Nothing a card says gives it permission: a brief, a label or an imported text can only hold a card
 * back. What lets a card through is the owner's queue (server/managed/store.ts) and the owner having
 * seen its instructions as they are now (server/runner/seen.ts). A person's readiness check
 * (readiness_note) settles what is only a signal: alike cards, earlier work, unread data and a label
 * that reads like a person's; never a mark, a requirement, a merge, a question or unseen text.
 */

export interface Planned {
  id: string;
  title: string;
  status: string;
  action: QueueAction;
  needs: QueueNeed;
  reason: string;
  step: string;
  waits_for: string[];
  /** For a card the queue may start (next, queued, read_first) but waiting on work under way on its branch. */
  busy?: string;
}

/** What the last attempt to start a card found, kept while the card reads the same. */
export interface Note {
  revision: string;
  at: number;
  needs: QueueNeed;
  reason: string;
}

export interface Scope {
  project: string;
  labels: string[];
}

export const startable = (card: Planned): boolean => card.action === "next" || card.action === "queued" || card.action === "read_first";

export function inScope(task: Task, scope: Scope): boolean {
  return task.project === scope.project && (!scope.labels.length || task.labels.some((label) => scope.labels.some((wanted) => sameLabel(wanted, label))));
}

interface Hold {
  action: QueueAction;
  needs: QueueNeed;
  reason: string;
  step: string;
  waits_for?: string[];
}

const owner = (needs: QueueNeed, reason: string, step: string): Hold => ({ action: "needs_owner", needs, reason, step });

const OWN_START = "start it from its own screen if an agent should do it";

/**
 * What the plan alone holds a todo card for: what the claim asks again on the plan it fetched
 * (queueObjection), so a change that arrived meanwhile stops the start.
 */
function planHold(ctx: ReadContext, plan: Plan, loaded: LoadedEntity, mapped: boolean, duplicates: ReturnType<typeof confirmedDuplicates>, cycle: boolean): Hold | undefined {
  const task = loaded.entity as Task;
  const checked = Boolean(task.readiness_checked);
  const twin = duplicates.get(task.id);
  if (twin) {
    return {
      action: "duplicate",
      needs: "",
      reason: `the same work as ${twin.of}: ${twin.why}`,
      step: `cancel it as a duplicate (update_task status canceled, duplicate_of ${twin.of}); the queue starts only ${twin.of}`,
    };
  }
  if (task.status === "inbox") return owner("draft", "an Inbox draft, not accepted as a task", "read it and move it to To Do if it should be done");
  if (unheld(task)) return owner("unheld", `${task.status} with no live run`, "decide what became of it: start it yourself, or set todo, done or canceled");
  if (cycle) return owner("dependency", "it waits on a loop of dependencies that finishing no task ends", "fix depends_on");
  const waits = blockingTasks(plan, task);
  const missing = waits.filter((w) => !plan.entities.has(w.id));
  if (missing.length) return owner("dependency", `it waits for ${missing.map((w) => w.text).join("; ")}`, "fix or remove the reference (depends_on)");
  if (waits.length) {
    return {
      action: "after_dependency",
      needs: "",
      reason: cut(`waits for ${waits.map((w) => w.text).join("; ")}`, 300),
      step: "enters the queue by itself once that is done",
      waits_for: waits.map((w) => w.id),
    };
  }
  // A card that ran once is never started again by itself, whatever the plan or another Mac made of that run.
  if (task.run_id) return owner("ran_before", "it ran before and was released: the queue starts a card once", `check what that run left, then ${OWN_START}`);
  const { group, reason, next } = classify(ctx, plan, task, mapped, loaded.brief);
  switch (group) {
    case "person":
      return owner("person_work", reason, next);
    case "merged":
      return owner("merged", reason, next);
    case "decision":
      return owner(task.requires.length ? "decision" : "question", reason, next);
    case "qa_environment":
      return owner("access_qa", reason, next);
    case "not_here":
      return owner("not_here", reason, next);
    case "check":
      if (!checked) return owner("person_work", reason, next);
      break;
    default:
      break;
  }
  const delivery = task.delivery;
  if (delivery?.qa === "failed") return owner("access_qa", cut(`QA failed${delivery.qa_note ? `: ${delivery.qa_note}` : ""}`, 200), "settle what failed, then start it yourself or record the new QA state");
  const lacking = [delivery?.access_ready === false ? "access" : "", delivery?.device_ready === false ? `a device${delivery.device ? ` (${delivery.device})` : ""}` : ""].filter(Boolean);
  if (lacking.length) return owner("access_qa", `not ready: ${lacking.join(" and ")}`, "provide it and record it as ready (update_task delivery)");
  return undefined;
}

/** Where a card's text came from, as the owner is told when asked to see it. */
function source(ctx: ReadContext, task: Task): string {
  const wrote = ctx.dashboard.delegation?.entries(task.id).find((entry) => entry.status === "applied" && entry.changes.some((c) => c.field === "brief" || c.field === "acceptance"));
  if (wrote) return `a coordinator wrote its text under delegation (${wrote.title || wrote.agent})`;
  if (task.meeting) return "its text came from a meeting import";
  if (task.issue) return "it stands for a forge issue, whose text others write";
  return "";
}

/** The owner has seen what a start would send as it is now: else the card waits for that. */
function unseen(ctx: ReadContext, space: SpaceEntry, loaded: LoadedEntity): Hold | undefined {
  const parts = instructionTexts(space.sync.root, loaded).map((part) => ({ ...part, author: "" }));
  const facts = ctx.dashboard.seen?.facts(space.record.key, parts);
  if (!facts) return owner("unseen", "this Mac has no record of what you have seen", "open the card once");
  const stale = facts.filter((fact) => fact.state !== "unchanged");
  if (!stale.length) return undefined;
  const changed = stale.filter((fact) => fact.state === "changed");
  const names = stale.map((fact) => fact.name).join(", ");
  const from = source(ctx, loaded.entity as Task);
  if (changed.length) {
    return owner("changed", cut([`${changed.map((fact) => fact.name).join(", ")} changed since you saw them: the new scope is not agreed`, from].filter(Boolean).join("; "), 300), "open the card and read what changed; it enters the queue once you have seen it");
  }
  return owner("unseen", cut([`you have not seen ${names} as they are now`, from].filter(Boolean).join("; "), 300), "open the card once to read it; it enters the queue then");
}

type Review = ReturnType<typeof reviewCards>["cards"] extends Map<string, infer C> ? C : never;

/** What the ready review leaves open about a card nothing else holds. */
function reviewHold(card: Review, checked: boolean, proven: ReadonlySet<string>, mentions: ReadonlySet<string>): Hold | undefined {
  // The review lists a PR/MR that only mentions the card as a signal; it holds nothing (tracker/merged.ts).
  const prs = card.prs.filter((pr) => !mentions.has(pr.url));
  if (card.coverage === "confirmed" || (card.basis === "own" && prs.length)) return owner("merged", card.evidence.join("; "), card.next);
  if (checked) return undefined;
  const earlier = card.coverage === "partial" || prs.length > 0 || card.evidence.some((line) => line.startsWith("an earlier run left a handoff"));
  if (earlier) return owner("covered", cut(card.evidence.join("; "), 300), `${card.next}. Record that you checked it (update_task readiness_note) to let the queue start it`);
  // A card proven to be the same work is no mere signal: it is dealt with as a duplicate.
  const related = card.related.filter((row) => !proven.has(row.id));
  if (related.length) {
    const like = related.map((row) => `${row.id} (${row.signals.join(", ")})`).join("; ");
    return owner("similar", cut(`reads like ${like}: a signal to compare, not a proven duplicate`, 300), "compare them: cancel one as a duplicate, or record that this one is its own work (update_task readiness_note)");
  }
  return undefined;
}

const incompleteReason = (card: Review): string => cut(`data incomplete: ${card.incomplete.join("; ")}`, 300);
const SETTLE_DATA = "settle what is missing, or record that you checked it (update_task readiness_note) to let the queue start it";

/**
 * Every open card of the queue's project, in the order the queue takes them (the board's order), each
 * with what the queue proposes. `notes`: what the last attempts to start found.
 */
export function planQueue(ctx: ReadContext, space: SpaceEntry, scope: Scope, notes: (task: string) => Note | undefined = () => undefined): Planned[] {
  const plan = space.sync.plan;
  const cards = sortTasks(
    tasksOf(plan)
      .filter((task) => inScope(task, scope) && !closed(task) && task.status !== "review" && !hasLiveRun(task))
      .map((task) => ({ plan, task })),
  ).map((item) => item.task);
  const duplicates = confirmedDuplicates(plan, scope.project);
  const mapped = Boolean(space.record.mapping[scope.project]);
  const { cards: reviews, cycles } = reviewCards(
    ctx,
    space,
    cards.filter((task) => task.status === "todo"),
  );
  // Branches of work under way: a card sharing one waits for it, as two agents would write one branch.
  const underWay = new Map(
    tasksOf(plan)
      .filter((task) => task.project === scope.project && hasLiveRun(task) && task.run_branch)
      .map((task) => [task.run_branch!, task.id]),
  );
  let next = true;
  // Drafts come last in the board's order already; every list keeps that order.
  return cards.map((task): Planned => {
    const loaded = plan.entities.get(task.id)!;
    const base = { id: task.id, title: task.title, status: task.status, waits_for: [] as string[] };
    let hold = planHold(ctx, plan, loaded, mapped, duplicates, cycles.has(task.id));
    const review = reviews.get(task.id);
    const checked = Boolean(task.readiness_checked);
    const proven = new Set([...duplicates].flatMap(([id, twin]) => (id === task.id ? [twin.of] : twin.of === task.id ? [id] : [])));
    const mentions = new Set(ctx.dashboard.merged.mentioned(plan, task).map((pr) => pr.url));
    if (!hold && review) hold = reviewHold(review, checked, proven, mentions) ?? unseen(ctx, space, loaded);
    if (hold) return { ...base, ...hold, waits_for: hold.waits_for ?? [] };
    const note = notes(task.id);
    if (note) return { ...base, ...owner(note.needs, note.reason, note.needs === "incomplete" ? SETTLE_DATA : "settle that; the queue tries it again later") };
    const sharing = underWay.get(plannedBranch(plan, task));
    const busy = sharing ? `shares its branch with ${sharing}, which is under way` : "";
    if (review!.incomplete.length && !checked) {
      return { ...base, action: "read_first", needs: "", reason: incompleteReason(review!), step: "the queue asks the forge before any start; it starts only if that read is complete and finds nothing", ...(busy ? { busy } : {}) };
    }
    if (busy) return { ...base, action: "queued", needs: "", reason: busy, step: "starts after that work is done", busy };
    const first = next;
    next = false;
    return {
      ...base,
      action: first ? "next" : "queued",
      needs: "",
      reason: checked ? `ready; a person checked it ${task.readiness_checked!.slice(0, 10)}` : "ready: nothing it waits for, its instructions seen, nothing found that covers it",
      step: first ? "the queue starts it at its next check" : "starts after the cards before it, as places and the limit allow",
    };
  });
}

/**
 * The card right before its start, after a fresh read of its forge: what the queue still holds it
 * for, with data that stayed incomplete counted against it; undefined when it may start.
 */
export function startHold(ctx: ReadContext, space: SpaceEntry, scope: Scope, id: string): { needs: QueueNeed; reason: string } | undefined {
  const card = planQueue(ctx, space, scope).find((c) => c.id === id);
  if (!card) return { needs: "refused", reason: "it is no longer an open card of the queue" };
  if (card.busy) return { needs: "", reason: card.busy };
  if (card.action === "read_first") return { needs: "incomplete", reason: card.reason };
  return startable(card) ? undefined : { needs: card.needs, reason: card.reason };
}

/** The task part of its instructions, as the hash planning compares. */
export function instructionHash(root: string, loaded: LoadedEntity): string {
  return hashText(JSON.stringify(instructionTexts(root, loaded).map((part) => part.text)));
}

/**
 * Asked by the claim on the plan it just fetched: why the card is not what the queue planned any
 * more. `expected`: instructionHash as planned. A live run is the claim's own refusal.
 */
export function queueObjection(ctx: ReadContext, space: SpaceEntry, fresh: Plan, scope: Scope, id: string, expected: string): string | undefined {
  const loaded = fresh.entities.get(id);
  const task = loaded?.entity;
  if (!loaded || task?.type !== "task") return `${id} is no longer a task`;
  if (hasLiveRun(task)) return undefined;
  if (task.status !== "todo") return `${id} is ${task.status} now`;
  if (!inScope(task, scope)) return `${id} left the queue's scope`;
  if (instructionHash(space.sync.root, loaded) !== expected) return `${id}'s instructions changed after planning; open it to agree to them`;
  const cycle = chainsOf(fresh, (t) => t.id === id).cycles.includes(id);
  const hold = planHold(ctx, fresh, loaded, true, confirmedDuplicates(fresh, scope.project), cycle);
  return hold ? `${id}: ${hold.reason}` : undefined;
}
