import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_QUEUE_STARTS, QUEUE_WINDOW_HOURS, type QueuePolicy, queuePolicyShape } from "../../shared/managed-queue.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";

/**
 * This machine's queue limits (shared/managed-queue.ts), in `queue-policy.json`, and the starts the
 * queue made, in `queue-starts.json`: both in plugin-data, never in the plan repository, so nobody
 * who pushes to the plan turns a queue on or raises its limit.
 *
 * As the delegation rules (server/delegation/store.ts): read once when the plugin starts, changed only
 * by the owner's RPCs and the plugin's own pause, and a policy file that no longer reads as the
 * plugin wrote it stops every queue until the owner saves one again.
 */

export const QUEUE_POLICY_FILE = "queue-policy.json";
export const QUEUE_STARTS_FILE = "queue-starts.json";

const WINDOW_MS = QUEUE_WINDOW_HOURS * 3_600_000;

const policyFile = z.object({ version: z.literal(1), revision: z.number().int(), projects: z.array(queuePolicyShape) });
type PolicyFile = z.output<typeof policyFile>;

const startShape = z.object({ id: z.string(), space: z.string(), project: z.string(), task: z.string(), title: z.string(), at: z.string() });
export type QueueStart = z.output<typeof startShape>;
const startsFile = z.object({ version: z.literal(1), starts: z.array(startShape) });

const PAUSED = "queue-policy.json was changed outside Paseo Dash, so no queue starts anything; check the limits and save them again";
/** The ledger could not be read: the count of the window is unknown, so each queue waits for the owner. */
export const LEDGER_LOST = "paused: the record of the queue's starts could not be read, so its limit is unknown; check what runs, then resume";

export interface QueueChange {
  enabled?: boolean;
  paused?: boolean;
  max_starts?: number;
  labels?: string[];
}

export class QueueStore {
  /** Files that could not be read at start and were moved aside. */
  readonly movedAside: string[] = [];
  private file: PolicyFile;
  /** The policy file as the plugin last read or wrote it. */
  private written: string;
  private starts: QueueStart[];
  private readonly policyPath: string;
  private readonly startsPath: string;
  now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.policyPath = join(dataDir, QUEUE_POLICY_FILE);
    this.startsPath = join(dataDir, QUEUE_STARTS_FILE);
    this.now = now;
    const policy = readJsonFile(this.policyPath, policyFile, () => ({ version: 1 as const, revision: 0, projects: [] }));
    const ledger = readJsonFile(this.startsPath, startsFile, () => ({ version: 1 as const, starts: [] }));
    for (const read of [policy, ledger]) if (read.movedAside) this.movedAside.push(read.movedAside);
    this.file = policy.value;
    this.starts = ledger.value.starts;
    this.written = this.onDisk();
    if (ledger.movedAside) {
      for (const own of this.file.projects) if (own.enabled) this.pause(own.space, own.project, LEDGER_LOST);
    }
  }

  private onDisk(): string {
    try {
      return readFileSync(this.policyPath, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : "unreadable";
    }
  }

  state(): { revision: number; paused: string; projects: QueuePolicy[] } {
    return {
      revision: this.file.revision,
      paused: this.onDisk() === this.written ? "" : PAUSED,
      projects: this.file.projects.map((own) => ({ ...own, labels: [...own.labels] })),
    };
  }

  policy(space: string, project: string): QueuePolicy | undefined {
    return this.state().projects.find((own) => own.space === space && own.project === project);
  }

  /** The queues that may start now. */
  active(): QueuePolicy[] {
    const { paused, projects } = this.state();
    return paused ? [] : projects.filter((own) => own.enabled && !own.paused);
  }

  /** Why this queue starts nothing now, as its policy stands; undefined when it may. */
  objection(space: string, project: string): string | undefined {
    const { paused, projects } = this.state();
    if (paused) return paused;
    const own = projects.find((p) => p.space === space && p.project === project);
    if (!own?.enabled) return "the queue of this project is off";
    return own.paused || undefined;
  }

  /** What takes something back counts in memory even when it cannot be saved; what gives counts only once saved. */
  private save(projects: QueuePolicy[], takesBack: boolean): void {
    const next: PolicyFile = { version: 1, revision: this.file.revision + 1, projects };
    if (takesBack) this.file = next;
    writeJsonFile(this.policyPath, next);
    this.file = next;
    this.written = this.onDisk();
  }

  /**
   * Changes one project's queue; returns why not. A change that gives something (on, resume, a higher
   * limit, other labels) counts only from the revision the screen showed.
   */
  set(space: string, project: string, change: QueueChange, revision: number): string | undefined {
    const earlier = this.file.projects.find((own) => own.space === space && own.project === project);
    const base: QueuePolicy = earlier ?? { space, project, enabled: false, paused: "", max_starts: DEFAULT_QUEUE_STARTS, labels: [], updated_at: "" };
    const labels = change.labels && [...new Set(change.labels)];
    const gives =
      (change.enabled === true && !base.enabled) ||
      (change.paused === false && Boolean(base.paused)) ||
      (change.max_starts !== undefined && change.max_starts > base.max_starts) ||
      (labels !== undefined && JSON.stringify(labels) !== JSON.stringify(base.labels));
    if (gives && revision !== this.file.revision) return "the queue changed meanwhile; look at it and save again";
    const next: QueuePolicy = {
      ...base,
      enabled: change.enabled ?? base.enabled,
      paused: change.paused === undefined ? base.paused : change.paused ? base.paused || "paused by you" : "",
      max_starts: change.max_starts ?? base.max_starts,
      labels: labels ?? base.labels,
      updated_at: this.now().toISOString(),
    };
    // Turned on again, a queue starts without the pause it had.
    if (change.enabled === true && !base.enabled && change.paused === undefined) next.paused = "";
    const other = this.file.projects.find((own) => own.enabled && own !== earlier);
    if (next.enabled && !base.enabled && other) return `the pilot runs one project's queue at a time: turn off ${other.space}/${other.project} first`;
    this.save([...this.file.projects.filter((own) => own !== earlier), next], !gives);
    return undefined;
  }

  /** The queue pauses itself with the reason; it counts at once, saved or not. */
  pause(space: string, project: string, reason: string): void {
    const found = this.file.projects.find((own) => own.space === space && own.project === project);
    if (!found || !found.enabled || found.paused) return;
    const projects = this.file.projects.map((own) => (own === found ? { ...own, paused: reason, updated_at: this.now().toISOString() } : own));
    // A file changed outside Paseo Dash is left as it is: only the owner's own save writes over it.
    if (this.onDisk() !== this.written) this.file = { ...this.file, revision: this.file.revision + 1, projects };
    else {
      try {
        this.save(projects, true);
      } catch (error) {
        console.error(`dashboard: the queue's pause could not be saved: ${String((error as Error)?.message ?? error)}`);
      }
    }
    console.error(`dashboard: queue of ${space}/${project} ${reason}`);
  }

  forgetSpace(space: string): void {
    const projects = this.file.projects.filter((own) => own.space !== space);
    if (projects.length === this.file.projects.length) return;
    if (this.onDisk() === this.written) this.save(projects, true);
    else this.file = { ...this.file, revision: this.file.revision + 1, projects };
  }

  /** The starts of this queue inside the window, newest first. */
  used(space: string, project: string): QueueStart[] {
    const from = this.now().getTime() - WINDOW_MS;
    return this.starts.filter((s) => s.space === space && s.project === project && Date.parse(s.at) > from).reverse();
  }

  /**
   * Counts a start before it is made, so a restart in between never gives the queue one more; throws
   * when it cannot be saved, and then nothing starts.
   */
  reserve(start: Omit<QueueStart, "at">): void {
    const from = this.now().getTime() - WINDOW_MS;
    const starts = [...this.starts.filter((s) => Date.parse(s.at) > from), { ...start, at: this.now().toISOString() }];
    writeJsonFile(this.startsPath, { version: 1, starts });
    this.starts = starts;
  }

  /** Gives back a counted start that was not made. */
  release(id: string): void {
    const starts = this.starts.filter((s) => s.id !== id);
    try {
      writeJsonFile(this.startsPath, { version: 1, starts });
      this.starts = starts;
    } catch (error) {
      // It stays counted: one start fewer, never one more.
      console.error(`dashboard: the queue's record of starts not updated: ${String((error as Error)?.message ?? error)}`);
    }
  }
}
