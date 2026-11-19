import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { LINE_COLOR_PATTERN, PROJECT_KEY_PATTERN, WEB_HOST_PATTERN } from "../../shared/model.ts";
import {
  lineColors,
  nextLineColor,
  suggestKey,
  type projectsAddRpc,
  type projectsCloneRpc,
  type projectsListRpc,
  type projectsMapRpc,
  type projectsMoveRpc,
  type projectsRemoveRpc,
  type projectsUpdateRpc,
} from "../../shared/projects.ts";
import { opaqueId } from "../plan/ids.ts";
import { ownProject, type ProjectFields, projectFields } from "../plan/space-file.ts";
import type { PaseoApi } from "../paseo.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { ownerError, record, refusal, type WriteContext } from "../api/writes.ts";
import { git, type GitRunner, SAFE_BRANCH } from "../sync/git.ts";
import { checkSpaceEdit, type Operation, openTasksOf } from "../sync/ops.ts";
import { localProjects } from "./local.ts";
import { type LocalProject, normalizeRemote, usableRemote } from "./mapping.ts";
import { alsoIn } from "./overlap.ts";

/**
 * The projects of a space (shared/projects.ts): what the dashboard's Projects tab lists and does.
 * Every change of the list is a journaled operation on space.yaml, pushed like any plan write; the
 * mapping to this machine's Paseo projects is runtime state and stays here.
 */

type Answer = { ok: boolean; error: string };
type ProjectOp = Extract<Operation, { kind: "project" }>;
type SpaceEdit = Extract<Operation, { kind: "project" | "project_order" }>;
const fail = (error: string): Answer => ({ ok: false, error });
const OK: Answer = { ok: true, error: "" };

/** `git ls-remote` asks the network; Paseo stops waiting for the RPC at 30 s. */
const LS_REMOTE_MS = 15_000;
/** What an add may take in all, its trunk lookups included, before it answers. */
const ADD_BUDGET_MS = 25_000;
const CLONE_MS = 10 * 60_000;

function spaceOf(ctx: WriteContext, key: string): SpaceEntry | undefined {
  const wanted = key.trim().toUpperCase();
  return ctx.dashboard.spaces.get(wanted);
}

function projectsOf(space: SpaceEntry) {
  return space.sync.plan.space?.projects ?? {};
}

/** The color each listed project draws with: its own, else the default for its place. */
function colorsOf(space: SpaceEntry): Map<string, string> {
  return lineColors(Object.entries(projectsOf(space)).map(([key, p]) => [key, p.color]));
}

/**
 * Writes the default color of every line that has none, except `skip`: adding, moving or removing a
 * line would otherwise shift the defaults of the lines after it. `write` ties them to their change.
 */
function pinColors(space: SpaceEntry, skip?: string): ProjectOp[] {
  const colors = colorsOf(space);
  return Object.entries(projectsOf(space))
    .filter(([key, p]) => !p.color && key !== skip)
    .map(([key, p]) => {
      const current = projectFields(p)!;
      return projectOp(key, { ...current, color: colors.get(key)! }, current);
    });
}

/** The branch `origin/HEAD` names in a local checkout, or empty. */
async function localTrunk(runner: GitRunner, root: string): Promise<string> {
  const result = await runner.run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 5_000);
  if (result.code !== 0 || result.timedOut) return "";
  const branch = result.stdout.trim().replace(/^origin\//, "");
  return SAFE_BRANCH.test(branch) ? branch : "";
}

/** The remote's default branch, from the remote itself; throws with git's reason when it cannot be reached. */
async function remoteTrunk(runner: GitRunner, cwd: string, remote: string): Promise<string> {
  const out = await git(runner, cwd, ["ls-remote", "--symref", "--", remote, "HEAD"], LS_REMOTE_MS);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? "";
  if (!SAFE_BRANCH.test(branch)) throw new Error(`${remote} names no usable default branch; give the base branch`);
  return branch;
}

/** The directory most of this machine's Paseo projects live in. */
function commonParent(local: LocalProject[]): string {
  const counts = new Map<string, number>();
  for (const project of local) if (project.rootPath) counts.set(dirname(project.rootPath), (counts.get(dirname(project.rootPath)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

type ListOutput = RpcOutput<typeof projectsListRpc>;

export async function listProjects(ctx: WriteContext, paseo: PaseoApi, input: RpcInput<typeof projectsListRpc>): Promise<ListOutput> {
  const empty: ListOutput = { projects: [], candidates: [], no_remote: [], local: [], clone_parent: "", groups: [], error: "" };
  const owner = ownerError(ctx);
  if (owner) return { ...empty, error: owner };
  const space = spaceOf(ctx, input.space);
  if (!space) return { ...empty, error: `No space ${input.space}.` };
  const runner = ctx.dashboard.git;
  let local: LocalProject[] = [];
  let error = "";
  try {
    local = await localProjects(paseo, runner);
    ctx.dashboard.updateMapping(local);
  } catch (e) {
    error = `Paseo's projects could not be read: ${(e as Error).message}`;
  }
  const projects = projectsOf(space);
  const colors = colorsOf(space);
  const byId = new Map(local.map((p) => [p.projectId, p]));
  const listed = new Set(Object.values(projects).map((p) => normalizeRemote(p.remote)));
  const keys = Object.keys(projects);
  // Two checkouts of one repository are one candidate: the first one Paseo lists.
  const offered = new Set<string>();
  const fresh = local.filter((p) => {
    if (!p.remote || !usableRemote(p.remote) || listed.has(normalizeRemote(p.remote)) || offered.has(normalizeRemote(p.remote))) return false;
    offered.add(normalizeRemote(p.remote));
    return true;
  });
  // Suggested keys must not collide with each other either.
  const taken = new Set(keys);
  const candidates = await Promise.all(fresh.map(async (p) => ({ project: p, trunk: p.rootPath ? await localTrunk(runner, p.rootPath) : "" })));
  return {
    projects: Object.entries(projects).map(([key, p]) => {
      const mapped = space.record.mapping[key];
      const found = mapped ? byId.get(mapped) : undefined;
      return {
        key,
        remote: p.remote,
        trunk: p.trunk ?? "",
        color: colors.get(key)!,
        color_set: Boolean(p.color),
        group: p.group ?? "",
        web_host: p.web_host ?? "",
        local: found ? { project_id: found.projectId, name: found.name, root: found.rootPath ?? "" } : null,
        override: Boolean(space.record.overrides[key]) && space.record.overrides[key] === mapped,
        open_tasks: openTasksOf(space.sync.plan, key).length,
        shared_with: alsoIn(ctx.dashboard.spaces.values(), space.record.key, p.remote),
      };
    }),
    candidates: candidates
      .sort((a, b) => a.project.name.localeCompare(b.project.name))
      .map(({ project, trunk }) => {
        const key = suggestKey(project.remote!, taken);
        taken.add(key);
        return { project_id: project.projectId, name: project.name, root: project.rootPath ?? "", remote: project.remote!, trunk, key };
      }),
    no_remote: local
      .filter((p) => p.git && !(p.remote && usableRemote(p.remote)) && !Object.values(space.record.mapping).includes(p.projectId))
      .map((p) => ({ name: p.name, root: p.rootPath ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    local: local
      .map((p) => ({ project_id: p.projectId, name: p.name, root: p.rootPath ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    clone_parent: commonParent(local),
    groups: [...new Set(Object.values(projects).map((p) => p.group ?? "").filter(Boolean))],
    error,
  };
}

function projectOp(key: string, value: ProjectFields | null, expect: ProjectFields | null): ProjectOp {
  return { op_id: opaqueId("op"), kind: "project", key, value, expect };
}

/**
 * Records `op` and then its pinned colors in one commit; the answer is `op`'s. A change that would be
 * refused records nothing, pins included; a pin applies only after its change applied in the same
 * pass, so a change found already there, or refused by a later replay, writes no pin either.
 */
async function write(ctx: WriteContext, space: SpaceEntry, op: SpaceEdit, pins: ProjectOp[] = []): Promise<Answer> {
  const refused = checkSpaceEdit(space.sync.plan, op);
  if (refused?.status === "refused") return fail(refused.reason);
  let outcomes;
  try {
    outcomes = await record(ctx, space, [op, ...pins.map((pin) => ({ ...pin, pin: op.op_id }))]);
  } catch (error) {
    // Busy past the wait: the operations stay queued, and the next read shows whether they applied.
    return fail((error as Error).message);
  }
  const reason = refusal(outcomes.get(op.op_id));
  if (reason) return fail(reason);
  ctx.dashboard.updateMapping();
  return OK;
}

function checkColor(color: string | undefined): string | undefined {
  return color && !LINE_COLOR_PATTERN.test(color) ? `${JSON.stringify(color)} is not a color like #3e8eed` : undefined;
}

function checkWebHost(host: string | undefined): string | undefined {
  return host && !WEB_HOST_PATTERN.test(host) ? `${JSON.stringify(host)} is not a host name such as git.example.com` : undefined;
}

function checkTrunk(trunk: string | undefined): string | undefined {
  return trunk && !SAFE_BRANCH.test(trunk) ? `${JSON.stringify(trunk)} is not a usable branch name` : undefined;
}

export async function addProject(ctx: WriteContext, input: RpcInput<typeof projectsAddRpc>): Promise<RpcOutput<typeof projectsAddRpc>> {
  const no = (error: string) => ({ ok: false, key: "", error });
  const owner = ownerError(ctx);
  if (owner) return no(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) return no(`No space ${input.space}.`);
  const key = input.key.trim();
  if (!PROJECT_KEY_PATTERN.test(key)) return no(`${JSON.stringify(key)} is not a project key: lower-case letters, digits, - and _, starting with a letter`);
  const projects = projectsOf(space);
  if (ownProject(projects, key)) return no(`${space.record.name} already lists ${key}`);
  const remote = input.remote.trim();
  if (!usableRemote(remote)) return no(`${JSON.stringify(remote)} is not a clone URL (https://…, ssh://… or git@host:path)`);
  const twin = Object.entries(projects).find(([, p]) => normalizeRemote(p.remote) === normalizeRemote(remote));
  if (twin) return no(`${remote} is already listed as ${twin[0]}`);
  const problem = checkColor(input.color) ?? checkTrunk(input.trunk);
  if (problem) return no(problem);

  const began = Date.now();
  let trunk = input.trunk?.trim() ?? "";
  if (!trunk) {
    // A local checkout knows its default branch without the network; else ask the remote, which
    // also proves this machine can reach it.
    const checkout = ctx.dashboard.localProjectByRemote(remote);
    if (checkout?.rootPath) trunk = await localTrunk(ctx.dashboard.git, checkout.rootPath);
    if (!trunk) {
      try {
        trunk = await remoteTrunk(ctx.dashboard.git, ctx.dashboard.dataDir, remote);
      } catch (error) {
        return no(`${remote} could not be read: ${(error as Error).message}`);
      }
    }
  }
  const color = input.color?.toLowerCase() || nextLineColor([...colorsOf(space).values()]);
  const group = input.group?.trim() || undefined;
  // The write waits only for what is left of the budget, so the answer comes before Paseo gives up.
  const left = Math.max(1_000, ADD_BUDGET_MS - (Date.now() - began));
  const budget: WriteContext = { ...ctx, writeWaitMs: Math.min(ctx.writeWaitMs ?? left, left) };
  const answer = await write(budget, space, projectOp(key, { remote, trunk, color, ...(group ? { group } : {}) }, null), pinColors(space));
  return { ...answer, key: answer.ok ? key : "" };
}

export async function updateProject(ctx: WriteContext, input: RpcInput<typeof projectsUpdateRpc>): Promise<Answer> {
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) return fail(`No space ${input.space}.`);
  const current = projectFields(ownProject(projectsOf(space), input.project));
  if (!current) return fail(`${space.record.name} lists no project ${input.project}`);
  const problem = checkColor(input.color) ?? checkTrunk(input.trunk) ?? checkWebHost(input.web_host);
  if (problem) return fail(problem);
  const next: ProjectFields = { ...current };
  for (const field of ["color", "group", "trunk", "web_host"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === "") delete next[field];
    else next[field] = field === "color" || field === "web_host" ? value.toLowerCase() : value;
  }
  // Naming or clearing one line's color changes the pool the other defaults come from.
  return write(ctx, space, projectOp(input.project, next, current), pinColors(space, input.project));
}

export async function moveProject(ctx: WriteContext, input: RpcInput<typeof projectsMoveRpc>): Promise<Answer> {
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) return fail(`No space ${input.space}.`);
  const keys = Object.keys(projectsOf(space));
  const from = keys.indexOf(input.project);
  if (from === -1) return fail(`${space.record.name} lists no project ${input.project}`);
  const to = from + input.offset;
  if (to < 0 || to >= keys.length) return OK;
  const order = [...keys];
  [order[from], order[to]] = [order[to]!, order[from]!];
  return write(ctx, space, { op_id: opaqueId("op"), kind: "project_order", order, expect: keys }, pinColors(space));
}

export async function removeProject(ctx: WriteContext, input: RpcInput<typeof projectsRemoveRpc>): Promise<Answer> {
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) return fail(`No space ${input.space}.`);
  const current = projectFields(ownProject(projectsOf(space), input.project));
  if (!current) return fail(`${space.record.name} lists no project ${input.project}`);
  const answer = await write(ctx, space, projectOp(input.project, null, current), pinColors(space, input.project));
  if (answer.ok) ctx.dashboard.setOverride(space.record.key, input.project, undefined);
  return answer;
}

export async function mapProject(ctx: WriteContext, paseo: PaseoApi, input: RpcInput<typeof projectsMapRpc>): Promise<Answer> {
  const owner = ownerError(ctx);
  if (owner) return fail(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) return fail(`No space ${input.space}.`);
  if (!ownProject(projectsOf(space), input.project)) return fail(`${space.record.name} lists no project ${input.project}`);
  const local = await localProjects(paseo, ctx.dashboard.git);
  ctx.dashboard.updateMapping(local);
  if (input.local_project && !local.some((p) => p.projectId === input.local_project)) {
    return fail(`Paseo on this machine has no project ${input.local_project}`);
  }
  ctx.dashboard.setOverride(space.record.key, input.project, input.local_project || undefined);
  return OK;
}

/**
 * Checks a clone before it starts; the clone itself (`cloneProject`) can outlive the RPC. Throws the
 * reason it cannot go ahead.
 */
export function cloneTarget(ctx: WriteContext, input: RpcInput<typeof projectsCloneRpc>): { space: SpaceEntry; remote: string; directory: string } {
  const owner = ownerError(ctx);
  if (owner) throw new Error(owner);
  const space = spaceOf(ctx, input.space);
  if (!space) throw new Error(`No space ${input.space}.`);
  const project = ownProject(projectsOf(space), input.project);
  if (!project) throw new Error(`${space.record.name} lists no project ${input.project}`);
  if (!usableRemote(project.remote)) throw new Error(`${JSON.stringify(project.remote)} in space.yaml is not a clone URL this plugin uses`);
  const directory = input.directory.trim();
  if (!isAbsolute(directory)) throw new Error("give an absolute path for the checkout");
  if (existsSync(directory)) throw new Error(`${directory} already exists`);
  const parent = dirname(directory);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${parent} is not a directory`);
  return { space, remote: project.remote, directory };
}

/** Clones the project's repository, opens it as a Paseo project and maps it. */
export async function cloneProject(ctx: WriteContext, paseo: PaseoApi, target: { remote: string; directory: string }): Promise<void> {
  await git(ctx.dashboard.git, dirname(target.directory), ["clone", "--quiet", "--", target.remote, target.directory], CLONE_MS);
  await paseo.workspaces.open({ cwd: target.directory });
  ctx.dashboard.updateMapping(await localProjects(paseo, ctx.dashboard.git));
}
