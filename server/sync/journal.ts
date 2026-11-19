import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../json-file.ts";
import type { Operation } from "./ops.ts";

/**
 * The operations of one space written locally and not yet on origin (I1). A claim is never an
 * ordinary pending entry: it is `inflight` while its own call runs, and `undecided` when that call
 * could not tell whether it landed; either way only the claim path or later fetches decide it, and
 * the ordinary write path never pushes it (I5).
 */
export interface JournalEntry {
  op: Operation;
  inflight?: true;
  undecided?: { since: string; run_id: string; task: string };
}

const journalSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({ op: z.record(z.string(), z.unknown()), inflight: z.literal(true).optional(), undecided: z.unknown().optional() }),
  ),
  /** Claims reported as not started or gone; one that shows up on origin later is an orphan. */
  abandonedClaims: z.array(z.object({ run_id: z.string(), task: z.string() })).default([]),
});

export class Journal {
  entries: JournalEntry[] = [];
  abandonedClaims: { run_id: string; task: string }[] = [];
  movedAside: string | undefined;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const read = readJsonFile(path, journalSchema, () => ({ version: 1 as const, entries: [], abandonedClaims: [] }));
    this.entries = read.value.entries as unknown as JournalEntry[];
    // A claim that was in flight when the process stopped may or may not have landed.
    for (const entry of this.entries) {
      if (entry.inflight && entry.op.kind === "claim") {
        delete entry.inflight;
        entry.undecided = { since: new Date().toISOString(), run_id: entry.op.run.run_id, task: entry.op.id };
      }
    }
    this.abandonedClaims = read.value.abandonedClaims;
    this.movedAside = read.movedAside;
  }

  save(): void {
    writeJsonFile(this.path, { version: 1, entries: this.entries, abandonedClaims: this.abandonedClaims });
  }

  add(op: Operation, inflight = false): void {
    this.entries.push(inflight ? { op, inflight: true } : { op });
    this.save();
  }

  remove(opIds: Iterable<string>): void {
    const gone = new Set(opIds);
    if (!gone.size) return;
    this.entries = this.entries.filter((entry) => !gone.has(entry.op.op_id));
    this.save();
  }

  /** What the ordinary write path may apply and push: never a claim. */
  pending(): Operation[] {
    return this.entries.filter((entry) => !entry.undecided && !entry.inflight && entry.op.kind !== "claim").map((entry) => entry.op);
  }
}
