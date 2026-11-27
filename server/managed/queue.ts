import type { Plan } from "../plan/load.ts";
import { hasLiveRun, type Task } from "../../shared/model.ts";
import type { QueueNeed } from "../../shared/managed-queue.ts";
import { readyReview } from "../api/ready-review.ts";
import type { ReadContext } from "../api/reads.ts";
import type { Dashboard } from "../dashboard.ts";
import { revisionOf } from "../delegation/rules.ts";
import { opaqueId } from "../plan/ids.ts";
import { instructionHash, type Note, planQueue, queueObjection, type Scope, startable, startHold } from "./plan.ts";
import { QueueStore } from "./store.ts";

/**
 * The managed queue's pass (shared/managed-queue.ts), run by the autopilot after its own flags
 * (server/autopilot.ts), so it keeps every limit the autopilot keeps: this Mac's places, a provider's
 * usage limit, one start per check. On top of those the owner's queue gives it a limit of starts in a
 * window, a pause and a switch that take effect also on a start already waiting for its turn.
 *
 * A start is decided in steps, each asked again after the slow one before it:
 * - the plan says which cards the queue may take (planQueue);
 * - the forge is asked about the first one now (the ready review of that card);
 * - the start's own checks run (start_check): instructions seen as they are, a mapped project, a branch;
 * - the claim asks the owner's queue and the card again on the plan it just fetched (queueObjection),
 *   so a pause, a revocation, an edit or a requirement that reached the plan meanwhile stops it, and
 *   the claim itself lets one machine of several start the card.
 */

/** Cards one pass tries before it stops; a card that is held is noted, not retried at once. */
const ATTEMPTS = 3;
/** How long a finding about a card stands while the card reads the same. */
const NOTE_MS = 10 * 60_000;

/** `skip` with `note`: the start would be refused for a reason the plan does not show; the preview says it for a while. */
export type StartResult = { ok: true } | { ok: false; kind: "skip"; reason: string; note?: boolean } | { ok: false; kind: "fail" | "unknown"; reason: string };

/** What the autopilot lends the queue: its limits and its own way of starting a task. */
export interface Starter {
  /** Why no start may be made now (a usage limit, every place at work); "" when one may. */
  hold(): Promise<string>;
  start(ctx: ReadContext & { dashboard: Dashboard }, space: string, task: Task, guard: (fresh: Plan) => string | undefined): Promise<StartResult>;
}

export class ManagedQueue {
  readonly store: QueueStore;
  private readonly dashboard: Dashboard;
  private readonly notes = new Map<string, Note & { space: string }>();

  constructor(dashboard: Dashboard, dataDir: string, now?: () => Date) {
    this.dashboard = dashboard;
    this.store = new QueueStore(dataDir, now);
  }

  /** What the last attempts found about cards that still read the same: the preview shows them. */
  notesOf(space: string): (task: string) => Note | undefined {
    const space_ = this.dashboard.spaces.get(space);
    return (task) => {
      const note = this.notes.get(`${space}/${task}`);
      if (!note) return undefined;
      const loaded = space_?.sync.plan.entities.get(task);
      const fresh = loaded && revisionOf(loaded) === note.revision && this.store.now().getTime() - note.at < NOTE_MS;
      if (!fresh) this.notes.delete(`${space}/${task}`);
      return fresh ? note : undefined;
    };
  }

  private note(space: string, task: Task, needs: QueueNeed, reason: string): void {
    const loaded = this.dashboard.spaces.get(space)?.sync.plan.entities.get(task.id);
    if (loaded) this.notes.set(`${space}/${task.id}`, { space, revision: revisionOf(loaded), at: this.store.now().getTime(), needs, reason });
  }

  /** One pass over the queues that are on; true when it started or tried to start a card. */
  async pass(ctx: ReadContext & { dashboard: Dashboard }, host: Starter): Promise<boolean> {
    for (const policy of this.store.active()) {
      const space = this.dashboard.spaces.get(policy.space);
      if (!space?.sync.plan.space?.projects[policy.project]) continue;
      const scope: Scope = { project: policy.project, labels: policy.labels };
      if (this.store.used(policy.space, policy.project).length >= policy.max_starts) continue;
      if (await host.hold()) return false;
      this.dashboard.merged.peek();
      let tried = 0;
      for (const card of planQueue(ctx, space, scope, this.notesOf(policy.space)).filter((c) => startable(c) && !c.busy)) {
        if (tried >= ATTEMPTS) break;
        tried += 1;
        const task = space.sync.plan.entities.get(card.id)?.entity as Task | undefined;
        if (task?.type !== "task" || hasLiveRun(task)) continue;
        // The forge is asked about this card now, so merged work the last reading missed counts.
        await readyReview(ctx, { task: card.id, limit: 1 }).catch(() => undefined);
        const held = startHold(ctx, space, scope, card.id);
        if (held) {
          // Data that stayed incomplete after the forge was asked: only a person's check settles it.
          if (held.needs === "incomplete") this.note(policy.space, task, held.needs, held.reason);
          continue;
        }
        const result = await this.begin(ctx, host, policy.space, policy.project, task);
        if (result === "tried") return true;
        if (result === "stop") return false;
      }
    }
    return false;
  }

  /** The owner's queue as it stands now: its scope and limit, or why it may start nothing. */
  private current(space: string, project: string): { scope: Scope; max: number } | string {
    const why = this.store.objection(space, project);
    const policy = this.store.policy(space, project);
    return why || !policy ? why || "the queue of this project is off" : { scope: { project, labels: policy.labels }, max: policy.max_starts };
  }

  /** "tried": a start was made or failed; "skip": this card is held, try the next; "stop": the queue may start nothing now. */
  private async begin(ctx: ReadContext & { dashboard: Dashboard }, host: Starter, spaceKey: string, project: string, task: Task): Promise<"tried" | "skip" | "stop"> {
    const space = this.dashboard.spaces.get(spaceKey)!;
    const loaded = space.sync.plan.entities.get(task.id);
    if (!loaded) return "skip";
    // Everything above was slow: the owner's queue and the limits are asked once more before a start is counted.
    const before = this.current(spaceKey, project);
    if (typeof before === "string" || (await host.hold())) return "stop";
    if (this.store.used(spaceKey, project).length >= before.max) return "stop";
    const expected = instructionHash(space.sync.root, loaded);
    const guard = (fresh: Plan): string | undefined => {
      // The owner's queue is read again on the plan the claim fetched: its switch, pause, limit and
      // scope as they are now, not as they were when this pass began. This is the last word before the start.
      const now = this.current(spaceKey, project);
      if (typeof now === "string") return now;
      if (this.store.used(spaceKey, project).length > now.max) return "the queue's limit of starts is reached";
      return queueObjection(ctx, space, fresh, now.scope, task.id, expected);
    };
    const id = opaqueId("q");
    this.store.reserve({ id, space: spaceKey, project, task: task.id, title: task.title });
    let result: StartResult;
    try {
      result = await host.start(ctx, spaceKey, task, guard);
    } catch (error) {
      // Not known how far it got: the count stays, and the queue waits for the owner to look.
      this.store.pause(spaceKey, project, `paused: starting ${task.id} stopped midway: ${String((error as Error)?.message ?? error)}`);
      return "tried";
    }
    if (result.ok) {
      this.notes.delete(`${spaceKey}/${task.id}`);
      return "tried";
    }
    if (result.kind !== "unknown") this.store.release(id);
    if (result.kind === "skip") {
      if (result.note) this.note(spaceKey, task, "refused", result.reason);
      return typeof this.current(spaceKey, project) === "string" ? "stop" : "skip";
    }
    // A start that failed, or whose outcome is not known, stops the queue until the owner looks.
    this.store.pause(spaceKey, project, `paused: starting ${task.id} ${result.kind === "unknown" ? "may or may not have gone through" : "failed"}: ${result.reason}`);
    return "tried";
  }
}
