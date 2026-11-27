import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type DelegatedAction, type DelegationEntry, delegationEntryShape, type DelegationGrant, delegationGrantShape } from "../../shared/delegation.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";
import { opaqueId } from "../plan/ids.ts";
import type { DelegatedOperation, Outcome } from "../sync/ops.ts";
import { actionsOf } from "./rules.ts";

/**
 * This machine's delegation (shared/delegation.ts): who may do what, in `delegation.json`, and what
 * they did, in `delegation-log.json`, both in plugin-data and never in the plan repository, which an
 * agent with git access can push to.
 *
 * The rules are read once, when the plugin starts, and held in memory; only the owner's RPCs change
 * them. A file that no longer reads as the plugin wrote it pauses every permission until the owner
 * saves one again, which writes the rules from memory over it. This catches an edit made while the
 * plugin runs. It is not a wall against a process of the same OS user, which could edit the file
 * and reload the plugin: the same limit as every file in plugin-data (05-architecture.md, Security).
 */

export const DELEGATION_FILE = "delegation.json";
export const DELEGATION_LOG_FILE = "delegation-log.json";

/** Entries kept; refused ones are counted apart, so a looping agent cannot push changes out. */
export const MAX_CHANGES = 500;
export const MAX_REFUSALS = 100;

const policySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  grants: z.array(delegationGrantShape),
  /** Counts the owner's changes of the rules. */
  revision: z.number().int(),
  /** The revision that last turned the pilot off, or ended a pause. */
  off_revision: z.number().int(),
});
type Policy = z.output<typeof policySchema>;

const logSchema = z.object({
  version: z.literal(1),
  entries: z.array(delegationEntryShape),
  /** The drafts each coordinator created, by `<space>/<task>`: whose text it may edit. */
  drafts: z.record(z.string(), z.string()),
});

const off = (): Policy => ({ version: 1, enabled: false, grants: [], revision: 0, off_revision: 0 });

const PAUSED = "delegation.json was changed outside Paseo Dash, so no permission counts; check the list and save a permission again";

/** Whether the file on disk could give this agent anything: asked before a session open waits for the plugin. */
export function delegationMayApply(dataDir: string, agent: string): boolean {
  try {
    const parsed = policySchema.safeParse(JSON.parse(readFileSync(join(dataDir, DELEGATION_FILE), "utf8")));
    return parsed.success && parsed.data.enabled && parsed.data.grants.some((grant) => grant.agent === agent);
  } catch {
    return false;
  }
}

export class DelegationStore {
  /** Files that could not be read at start and were moved aside. */
  readonly movedAside: string[] = [];
  private policy: Policy;
  /** The rules' file as the plugin last read or wrote it. */
  private written: string;
  private readonly log: z.output<typeof logSchema>;
  private readonly policyPath: string;
  private readonly logPath: string;
  private readonly now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.policyPath = join(dataDir, DELEGATION_FILE);
    this.logPath = join(dataDir, DELEGATION_LOG_FILE);
    this.now = now;
    const policy = readJsonFile(this.policyPath, policySchema, off);
    const log = readJsonFile(this.logPath, logSchema, () => ({ version: 1 as const, entries: [], drafts: {} }));
    for (const read of [policy, log]) if (read.movedAside) this.movedAside.push(read.movedAside);
    this.policy = policy.value;
    this.log = log.value;
    this.written = this.onDisk();
  }

  private onDisk(): string {
    try {
      return readFileSync(this.policyPath, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : "unreadable";
    }
  }

  /** The rules as they stand, and why none of them counts although the pilot is on. */
  state(): { enabled: boolean; revision: number; paused: string; grants: DelegationGrant[] } {
    const { enabled, revision, grants } = this.policy;
    return { enabled, revision, paused: this.onDisk() === this.written ? "" : PAUSED, grants: grants.map((grant) => ({ ...grant, actions: [...grant.actions] })) };
  }

  /** The permission that counts for this agent now; undefined while off, paused or never given. */
  grantOf(agent: string): DelegationGrant | undefined {
    const { enabled, paused, grants } = this.state();
    return enabled && !paused ? grants.find((grant) => grant.agent === agent) : undefined;
  }

  /**
   * Writes the rules as the next revision. What takes something back counts in memory even when it
   * cannot be saved; what gives counts only once saved.
   */
  private save(change: Omit<Policy, "revision">, takesBack = false): void {
    const policy = { ...change, revision: this.policy.revision + 1 };
    // A save over a changed file ends the pause, which drops what was asked before it.
    if (this.onDisk() !== this.written) policy.off_revision = policy.revision;
    if (takesBack) this.policy = policy;
    writeJsonFile(this.policyPath, policy);
    this.policy = policy;
    this.written = this.onDisk();
  }

  setEnabled(enabled: boolean): void {
    const off_revision = enabled ? this.policy.off_revision : this.policy.revision + 1;
    this.save({ ...this.policy, enabled, off_revision }, !enabled);
  }

  /**
   * Gives an agent its permission, replacing the one it had. The same project keeps the permission's
   * id, so its changes still waiting to be pushed stay under it while their actions are not taken back.
   */
  put(input: { agent: string; title: string; space: string; project: string; actions: DelegatedAction[] }): DelegationGrant {
    const earlier = this.policy.grants.find((grant) => grant.agent === input.agent);
    const kept = earlier && earlier.space === input.space && earlier.project === input.project ? earlier : undefined;
    const at = this.now().toISOString();
    const actions = [...new Set(input.actions)];
    // What the new permission takes away goes first, so it counts even if saving the new one fails.
    if (earlier) this.narrow(earlier.id, kept ? earlier.actions.filter((action) => !actions.includes(action)) : earlier.actions);
    const grant: DelegationGrant = {
      ...input,
      actions,
      id: kept?.id ?? opaqueId("grant"),
      granted_at: kept?.granted_at ?? at,
      updated_at: at,
      revoked: this.takenBack(kept, kept?.actions.filter((action) => !actions.includes(action)) ?? []),
    };
    this.save({ ...this.policy, grants: [...this.policy.grants.filter((other) => other.agent !== input.agent), grant] });
    return grant;
  }

  /** A permission's marks of what was taken back, with `actions` taken back by the next revision. */
  private takenBack(grant: DelegationGrant | undefined, actions: DelegatedAction[]): DelegationGrant["revoked"] {
    const revoked = { ...grant?.revoked };
    for (const action of actions) revoked[action] = this.policy.revision + 1;
    return revoked;
  }

  /** Takes one action, or the whole permission, back; false when there is no such permission. */
  revoke(id: string, action?: DelegatedAction): boolean {
    const found = this.policy.grants.find((grant) => grant.id === id);
    if (!found) return false;
    this.narrow(id, action ? [action] : found.actions);
    return true;
  }

  /** Takes these actions out of a permission, which goes when none is left. */
  private narrow(id: string, taken: DelegatedAction[]): void {
    const found = this.policy.grants.find((grant) => grant.id === id);
    if (!found || !taken.length) return;
    const actions = found.actions.filter((own) => !taken.includes(own));
    const grants = actions.length
      ? this.policy.grants.map((grant) =>
          grant === found ? { ...grant, actions, updated_at: this.now().toISOString(), revoked: this.takenBack(grant, taken) } : grant,
        )
      : this.policy.grants.filter((grant) => grant !== found);
    this.save({ ...this.policy, grants }, true);
  }

  /**
   * A disconnected space takes its permissions with it, so connecting it again starts without any. A
   * paused file is left as it is: only the owner's own save resumes it.
   */
  forgetSpace(space: string): void {
    const grants = this.policy.grants.filter((grant) => grant.space !== space);
    if (grants.length === this.policy.grants.length) return;
    if (this.onDisk() === this.written) this.save({ ...this.policy, grants }, true);
    else this.policy = { ...this.policy, grants, revision: this.policy.revision + 1 };
  }

  /** Why this operation's permission does not stand now (server/sync/space-sync.ts, authorize). */
  objection(space: string, op: DelegatedOperation): string | undefined {
    const { enabled, paused, grants } = this.state();
    if (paused) return `delegation is paused, so the change was dropped: ${paused}`;
    if (!enabled || this.policy.off_revision > op.via.revision) return "delegation was turned off or paused before the change reached the plan repository";
    const grant = grants.find((own) => own.agent === op.via.agent);
    if (!grant || grant.id !== op.via.grant || grant.space !== space || grant.project !== op.via.project) {
      return "the permission was revoked or replaced before the change reached the plan repository";
    }
    const needed: DelegatedAction[] = op.kind === "create" ? ["drafts"] : actionsOf(op.edit);
    const missing = needed.find((action) => !grant.actions.includes(action) || (grant.revoked?.[action] ?? 0) > op.via.revision);
    if (missing) return `${missing} was taken out of the permission before the change reached the plan repository`;
    if (op.kind === "delegated" && needed.includes("drafts") && !this.owns(space, op.id, op.via.agent)) {
      return `${op.id} is not a draft this coordinator created`;
    }
    return undefined;
  }

  owns(space: string, task: string, agent: string): boolean {
    return this.log.drafts[`${space}/${task}`] === agent;
  }

  /** The latest entry of an operation. */
  entry(opId: string): DelegationEntry | undefined {
    return this.log.entries.find((entry) => entry.op_id === opId);
  }

  /** Newest first. */
  entries(task?: string): DelegationEntry[] {
    return task ? this.log.entries.filter((entry) => entry.task === task) : [...this.log.entries];
  }

  /** Writes an entry, replacing an earlier one of the same operation; throws when it cannot be saved. */
  record(entry: DelegationEntry, creates = false): void {
    const entries = [entry, ...this.log.entries.filter((other) => other.op_id !== entry.op_id)];
    let changes = 0;
    let refusals = 0;
    this.log.entries = entries.filter((other) => (other.status === "refused" ? ++refusals <= MAX_REFUSALS : ++changes <= MAX_CHANGES));
    if (creates) this.log.drafts[`${entry.space}/${entry.task}`] = entry.agent;
    writeJsonFile(this.logPath, this.log);
  }

  /** What an apply of the operation came to; a refused create takes its claim on the draft's id back. */
  settle(op: DelegatedOperation, outcome: Outcome): void {
    const entry = this.entry(op.op_id);
    if (!entry) return;
    const status = outcome.status === "applied" || outcome.status === "already" ? "applied" : "refused";
    const reason = outcome.status === "refused" || outcome.status === "dropped" ? outcome.reason : "";
    if (entry.status === status && entry.reason === reason) return;
    entry.status = status;
    entry.reason = reason;
    if (status === "refused" && op.kind === "create") delete this.log.drafts[`${entry.space}/${entry.task}`];
    writeJsonFile(this.logPath, this.log);
  }
}
