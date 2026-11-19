import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { issuesMirrorReadRpc, issuesMirrorSetRpc } from "../../shared/issues.ts";
import { resolveCreateSpace } from "../api/resolve.ts";
import { ownerError, type WriteContext } from "../api/writes.ts";
import { IssueWriter } from "./forge-write.ts";
import { projectRepo } from "./link.ts";

/**
 * Settings → a space → "Mirror issues" (09-forge-issues.md, the mirror): this machine's switch and
 * what the mirror did. Not described to God Mode: it is a setting, and turning it on makes every
 * accepted task an issue other people see.
 */

/** A repository's visibility is asked again after this long. */
const VISIBILITY_FRESH_MS = 10 * 60_000;
const visibilities = new Map<string, { at: number; visibility: string; note: string; write: boolean }>();

type Read = RpcOutput<typeof issuesMirrorReadRpc>;

export async function readMirror(ctx: WriteContext, input: RpcInput<typeof issuesMirrorReadRpc>): Promise<Read> {
  const empty: Read = { on: false, mirrored: 0, waiting: 0, problems: [], paused: [], read_only: [], repositories: [], error: "" };
  const owner = ownerError(ctx);
  if (owner) return { ...empty, error: owner };
  const found = resolveCreateSpace(ctx.dashboard, input.space);
  if (!found.ok) return { ...empty, error: found.error };
  const space = found.value;
  const store = ctx.dashboard.mirrorStore;
  // A repository found read-only shows as such at once, not when its records are next tried. Read
  // beside the visibility reads below, so the two never add up against Paseo's 30 seconds.
  const learning = store?.on(space.record.key) ? ctx.dashboard.mirror.learnAccess({ key: space.record.key, sync: space.sync }) : Promise.resolve();
  if (!input.visibility) await learning;
  const status = ctx.dashboard.mirror.status({ key: space.record.key, sync: space.sync });
  const answer: Read = { ...empty, on: store?.on(space.record.key) ?? false, ...status };
  if (!input.visibility) return answer;
  const writer = new IssueWriter(ctx.dashboard.forge, ctx.dashboard.dataDir);
  const now = Date.now();
  // In parallel, so a few slow forges still answer within Paseo's 30 seconds.
  const projects = Object.entries(space.sync.plan.space?.projects ?? {});
  const [repositories] = await Promise.all([
    Promise.all(
    projects.map(async ([key, project]) => {
      const repo = projectRepo(project);
      if (!repo) return { project: key, repository: project.remote, visibility: "unknown", note: "the remote does not name a repository", write: false };
      const name = `${repo.host}/${repo.repo}`;
      let known = visibilities.get(name);
      if (!known || now - known.at >= VISIBILITY_FRESH_MS) {
        const read = await writer.access(repo);
        known = read.ok
          ? { at: now, visibility: read.value.visibility || "unknown", note: read.value.visibility ? "" : "the forge did not say whether the repository is public", write: read.value.write }
          : { at: now, visibility: "unknown", note: read.error, write: false };
        visibilities.set(name, known);
      }
      return { project: key, repository: name, visibility: known.visibility, note: known.note, write: known.write };
    }),
    ),
    learning,
  ]);
  // The status again: what the access reads beside these learned.
  return { ...answer, ...ctx.dashboard.mirror.status({ key: space.record.key, sync: space.sync }), repositories };
}

type Switch = RpcOutput<typeof issuesMirrorSetRpc>;

export function setMirror(ctx: WriteContext, input: RpcInput<typeof issuesMirrorSetRpc>): Switch {
  const owner = ownerError(ctx);
  if (owner) return { ok: false, on: false, error: owner };
  const found = resolveCreateSpace(ctx.dashboard, input.space);
  if (!found.ok) return { ok: false, on: false, error: found.error };
  const key = found.value.record.key;
  const store = ctx.dashboard.mirrorStore;
  if (!store) return { ok: false, on: false, error: "Paseo Dash has not started" };
  if (input.on && !input.confirmed) {
    return {
      ok: false,
      on: store.on(key),
      error:
        "Not turned on: confirm first. Every accepted task of the space becomes an issue in its project's repository, with its brief as the issue's text (public in a public repository), and only one machine should mirror a space.",
    };
  }
  try {
    store.setOn(key, input.on, (ctx.now ?? (() => new Date()))().toISOString());
  } catch (error) {
    return { ok: false, on: store.on(key), error: `not saved: ${String((error as Error)?.message ?? error)}` };
  }
  if (input.on) void ctx.dashboard.mirror.pass().catch(() => undefined);
  return { ok: true, on: input.on, error: "" };
}
