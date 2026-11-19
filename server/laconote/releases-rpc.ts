import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { laconoteProjectsRpc, laconoteReleasesReadRpc, laconoteReleasesSetRpc } from "../../shared/laconote.ts";
import { resolveCreateSpace } from "../api/resolve.ts";
import { ownerError } from "../api/writes.ts";
import { LaconoteClient } from "./client.ts";
import type { LaconoteContext } from "./importer.ts";
import { LACONOTE_PROJECT } from "./releases.ts";

/**
 * Settings → a space → "Release context" (05-architecture.md, Release context): which Laconote project
 * each of the space's projects feeds on this machine, and what was sent. No answer carries the key.
 */

type Projects = RpcOutput<typeof laconoteProjectsRpc>;

export async function laconoteProjects(ctx: LaconoteContext): Promise<Projects> {
  const owner = ownerError(ctx);
  if (owner) return { projects: [], error: owner };
  const laconote = ctx.dashboard.laconote;
  const key = laconote?.key();
  if (!laconote || !key) return { projects: [], error: "no Laconote API key is set; add one in Settings → Paseo Dash → Laconote" };
  try {
    const projects = await new LaconoteClient(laconote.apiUrl, key, ctx.fetch).listProjects();
    return { projects, error: "" };
  } catch (error) {
    const text = String((error as Error)?.message ?? error);
    return { projects: [], error: text.split(key).join("[key]") };
  }
}

type Read = RpcOutput<typeof laconoteReleasesReadRpc>;

export function readReleases(ctx: LaconoteContext, input: RpcInput<typeof laconoteReleasesReadRpc>): Read {
  const empty: Read = { key_set: false, mapping: [], sets: [], error: "" };
  const owner = ownerError(ctx);
  if (owner) return { ...empty, error: owner };
  const found = resolveCreateSpace(ctx.dashboard, input.space);
  if (!found.ok) return { ...empty, error: found.error };
  const space = found.value;
  const store = ctx.dashboard.releaseStore;
  if (!store) return { ...empty, error: "Paseo Dash has not started" };
  const mapping = store.mapping(space.record.key);
  const projects = Object.keys(space.sync.plan.space?.projects ?? {}).sort();
  return {
    key_set: ctx.dashboard.laconote?.hasKey ?? false,
    mapping: projects.map((project) => ({ project, laconote: mapping[project] ?? "" })),
    sets: ctx.dashboard.releases.status({ key: space.record.key, sync: space.sync }).map((s) => ({
      ...s,
      releases: s.releases.map((r) => ({ ...r, progress: r.progress ?? null })),
    })),
    error: "",
  };
}

type Set = RpcOutput<typeof laconoteReleasesSetRpc>;

export function setRelease(ctx: LaconoteContext, input: RpcInput<typeof laconoteReleasesSetRpc>): Set {
  const owner = ownerError(ctx);
  if (owner) return { ok: false, error: owner };
  const found = resolveCreateSpace(ctx.dashboard, input.space);
  if (!found.ok) return { ok: false, error: found.error };
  const space = found.value;
  const store = ctx.dashboard.releaseStore;
  if (!store) return { ok: false, error: "Paseo Dash has not started" };
  const key = space.record.key;
  const mapped = Object.hasOwn(store.mapping(key), input.project);
  if (!Object.hasOwn(space.sync.plan.space?.projects ?? {}, input.project) && !mapped) return { ok: false, error: `${key} has no project ${input.project}` };
  if (input.laconote) {
    if (!LACONOTE_PROJECT.test(input.laconote)) return { ok: false, error: "not a Laconote project id" };
    // Two spaces would each send their own whole set into the project and retire each other's releases.
    const other = store.spaceOf(input.laconote);
    if (other && other !== key) return { ok: false, error: `that Laconote project already gets the releases of ${other} on this machine; a project takes one space's releases` };
  }
  try {
    store.setMapping(key, input.project, input.laconote);
  } catch (error) {
    return { ok: false, error: `not saved: ${String((error as Error)?.message ?? error)}` };
  }
  void ctx.dashboard.releases.pass().catch(() => undefined);
  return { ok: true, error: "" };
}
