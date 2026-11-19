import { existsSync } from "node:fs";
import type { PaseoApi } from "../paseo.ts";
import type { Adopted, RunRecord } from "../runner/runs.ts";
import { type GitRunner, SAFE_BRANCH } from "../sync/git.ts";

/**
 * Whether a tracked checkout on the trunk has landed (05-architecture.md, Tracking a Paseo workspace
 * as a task): its HEAD is contained in origin/<trunk>, as the local remote-tracking ref has it (the
 * person's own push updates it; nothing here fetches), and its tree is clean. Once Paseo removed the
 * directory, the last HEAD read is checked in the project's checkout and the last clean reading
 * stands; after the first reading that saw the workspace archived, that reading's HEAD stands too.
 * Read-only: only `rev-parse`, `status` and `merge-base` run, never anything that writes.
 */

const GIT_MS = 5_000;

export type Landed = NonNullable<Adopted["landed"]>;

export async function readLanded(git: GitRunner, paseo: PaseoApi | undefined, run: RunRecord, projectRoot: string | undefined, now: Date): Promise<Landed | undefined> {
  const adopted = run.adopted;
  const trunk = adopted?.trunk;
  if (!adopted || !trunk || !SAFE_BRANCH.test(trunk)) return undefined;
  const last = adopted.landed;
  const at = now.toISOString();
  const fail = (error: string): Landed => ({ head: last?.head ?? "", clean: last?.clean ?? false, landed: false, archived: last?.archived ?? false, at, error });

  // A failed refresh cannot tell; the last reading of "archived" stands then.
  let archived = last?.archived ?? false;
  if (paseo && run.workspaceId) {
    const descriptor = await paseo.workspaces
      .ref(run.workspaceId)
      .refresh()
      .then((d) => d as { archivingAt?: string | null } | null)
      .catch(() => "unknown" as const);
    if (descriptor !== "unknown") archived = descriptor === null || Boolean(descriptor.archivingAt);
  }

  let head = last?.head ?? "";
  let clean = last?.clean ?? false;
  let where = adopted.directory;
  // The first reading after the archive reads the checkout once more; from then on its HEAD stands: a
  // person's checkout outlives the archive and may move on to other work, which is not this run's.
  if (archived && last?.archived && last.head) {
    if (!existsSync(where)) where = projectRoot ?? "";
    if (!where) return { ...fail("the checkout is gone and the project's checkout is not known"), archived };
  } else if (existsSync(adopted.directory)) {
    const rev = await git.run(adopted.directory, ["rev-parse", "--verify", "HEAD"], GIT_MS);
    if (rev.code !== 0 || rev.timedOut) return { ...fail("git could not read the checkout's HEAD"), archived };
    head = rev.stdout.trim();
    // Untracked files count: work not committed has not landed.
    // --no-optional-locks: the person's own checkout, where an agent may be committing, is not locked.
    const status = await git.run(adopted.directory, ["--no-optional-locks", "status", "--porcelain"], GIT_MS);
    if (status.code !== 0 || status.timedOut) return { ...fail("git could not read the checkout's status"), head, archived };
    clean = status.stdout.trim() === "";
  } else {
    if (!head || !projectRoot) return { ...fail("the checkout is gone and its last HEAD is not known"), archived };
    where = projectRoot;
  }
  if (!/^[0-9a-f]{40,64}$/.test(head)) return { ...fail("the checkout's HEAD is not a commit"), archived };
  const contained = await git.run(where, ["merge-base", "--is-ancestor", head, `refs/remotes/origin/${trunk}`], GIT_MS);
  // Exit 1 is git's "not an ancestor"; anything else means it could not tell.
  if (contained.timedOut || (contained.code !== 0 && contained.code !== 1)) return { ...fail(`git could not compare HEAD with origin/${trunk}`), head, clean, archived };
  return { head, clean, landed: contained.code === 0 && clean, archived, at };
}

/** How a person reads the landed fact: "landed on origin/main", or why not yet. */
export function landedText(run: RunRecord): string {
  const trunk = run.adopted?.trunk;
  const landed = run.adopted?.landed;
  if (!trunk) return "";
  if (!landed) return `not checked yet whether it landed on origin/${trunk}`;
  if (landed.error) return `cannot tell whether it landed on origin/${trunk}: ${landed.error}`;
  if (landed.landed) return `landed on origin/${trunk}`;
  if (!landed.clean) return `not landed: the checkout has uncommitted changes`;
  return `not landed: HEAD is not on origin/${trunk} yet (push it)`;
}
