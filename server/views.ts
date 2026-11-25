import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { runSettingsText } from "./runner/run-settings.ts";
import { closed, hasLiveRun, isArchived, lineLocked, refId, startable, type Task, unheld } from "../shared/model.ts";
import type { uiOptionsRpc, uiRoadmapRpc, uiRunsRpc } from "../shared/ui.ts";
import { renderRoadmap } from "./plan/roadmap.ts";
import type { featureViewRpc, taskCodeMapRpc, taskRunsRpc, taskViewRpc } from "../shared/views.ts";
import { activityText, blockers, featuresOf, humanWork, localHost, localRun, milestoneOf, milestonesOf, overlapsByTask, prText, progressText, sortTasks, spokenTime, tasksOf } from "./api/view.ts";
import { elsewhereText, historyWithin, localRecord, runProgress, runResult } from "./api/runs.ts";
import { hashText, taskInstructions } from "./runner/seen.ts";
import type { Dashboard } from "./dashboard.ts";
import type { RunRecord } from "./runner/runs.ts";
import { buildCodeMap } from "./tracker/codemap.ts";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { glyphFor } from "./map/read.ts";
import type { Plan } from "./plan/load.ts";
import { findLabel, personByEmail, shownLabel } from "../shared/labels.ts";
import { landedText } from "./tracker/landed.ts";
import { claiming } from "./needs.ts";
import { issueFacts, readableIssue } from "./tracker/issues.ts";
import { issueLabel, parseIssueUrl } from "../shared/issues.ts";

/**
 * Workspaces this Mac's ended runs of a task made and left unarchived, one entry per workspace (a
 * later run may reuse an earlier one's). Never a tracked workspace (the person's own), and never one
 * another run holds: a live run, or a tracked one of any task.
 */
export function leftWorkspaces(dashboard: Dashboard, task: string): { runs: RunRecord[]; workspaceId: string }[] {
  const all = [...(dashboard.runs?.runs.values() ?? [])];
  const held = new Set(all.filter((run) => run.workspaceId && (run.adopted || dashboard.isLive(run) !== false)).map((run) => run.workspaceId!));
  const left = new Map<string, RunRecord[]>();
  for (const run of all) {
    if (run.task !== task || !run.workspaceId || run.adopted || run.workspaceArchivedAt || held.has(run.workspaceId)) continue;
    left.set(run.workspaceId, [...(left.get(run.workspaceId) ?? []), run]);
  }
  return [...left].map(([workspaceId, runs]) => ({ runs, workspaceId }));
}

/** The dashboard screens' reads: one task or one feature in full, found by id in any space. */

function locate(dashboard: Dashboard, id: string) {
  for (const entry of dashboard.spaces.values()) {
    const loaded = entry.sync.plan.entities.get(id.trim().toUpperCase());
    if (loaded) return { entry, loaded };
  }
  return undefined;
}

type TaskView = RpcOutput<typeof taskViewRpc>;

export function taskView(dashboard: Dashboard, input: RpcInput<typeof taskViewRpc>, now = new Date()): TaskView {
  const empty: TaskView = {
    found: false,
    space: "",
    id: input.task,
    title: "",
    status: "",
    glyph: "todo",
    project: "",
    feature: null,
    milestone: null,
    own_milestone: "",
    own_feature: "",
    priority: "",
    assignee: "",
    labels: [],
    brief: "",
    acceptance: [],
    dependencies: [],
    links: [],
    meeting: "",
    meeting_title: "",
    issue: null,
    progress: "",
    run: null,
    pr: null,
    handoff: null,
    clarifications: "",
    instructions_hash: "",
    merged: [],
    archived: "",
    actions: {
      start: "",
      blocked_by: [],
      release: false,
      continue: false,
      landed_done: false,
      close: false,
      unheld: false,
      reopen: false,
      triage: false,
      line: "",
      archive: false,
      archive_task: false,
      unarchive: false,
    },
    error: "",
  };
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const found = locate(dashboard, input.task);
  if (!found || found.loaded.entity.type !== "task") return { ...empty, error: `No task ${input.task}.` };
  const { entry, loaded } = found;
  const plan = entry.sync.plan;
  const task = loaded.entity as Task;
  const named = (id: string | undefined) => {
    const entity = id ? plan.entities.get(id)?.entity : undefined;
    return entity ? { id: entity.id, title: entity.title } : null;
  };
  const run = localRun(dashboard.runs, task);
  const live = hasLiveRun(task);
  // A screen on view keeps a tracked trunk checkout's landed reading fresh, without waiting for it.
  if (run?.adopted?.trunk) dashboard.peekLanded(run);
  const landed = run?.adopted?.trunk ? run.adopted.landed : undefined;
  const seen = dashboard.prs.seen.get(task.id);
  const pr = live ? prText(seen, task) : (task.run_pr ?? "");
  // The link must be the PR the text names: a view seen for an earlier run is not this run's.
  // Without a live run the text is run_pr, and so is the link.
  const ownSeen = live && seen && seen.run_id === task.run_id ? seen : undefined;
  const prUrl = ownSeen ? ownSeen.url : (task.run_pr ?? "");
  const issueRef = parseIssueUrl(task.issue);
  const issue = task.issue ? issueFacts(task, dashboard.issues.peek(task, plan), readableIssue(plan, task.issue)) : undefined;
  return {
    found: true,
    space: entry.record.key,
    id: task.id,
    title: task.title,
    status: task.status,
    glyph: glyphFor(dashboard, plan, task),
    project: task.project ?? "",
    feature: named(refId(task.feature)),
    milestone: named(milestoneOf(plan, task)),
    own_milestone: refId(task.milestone) ?? "",
    own_feature: refId(task.feature) ?? "",
    priority: task.priority ?? "",
    assignee: task.assignee ?? "",
    labels: task.labels.map((name) => shownLabel(plan.space?.labels ?? {}, name)),
    brief: loaded.brief,
    acceptance: loaded.acceptance.map(({ text, done }) => ({ text, done })),
    dependencies: task.depends_on.map((ref) => {
      const other = plan.entities.get(refId(ref) ?? "")?.entity;
      return other ? { id: other.id, title: other.title, status: other.status } : { id: refId(ref) ?? ref, title: "(not found)", status: "missing" };
    }),
    links: task.links,
    meeting: task.meeting ?? "",
    meeting_title: task.meeting_title ?? "",
    issue: issue
      ? { url: issueRef?.url ?? task.issue!, label: issueRef ? issueLabel(issueRef) : task.issue!, state: issue.state, note: issue.note }
      : null,
    progress: progressText(task, loaded.acceptance),
    run: live
      ? {
          id: task.run_id ?? "",
          by: task.run_by ?? "",
          host: task.run_host ?? "",
          since: spokenTime(task.run_started, now),
          branch: task.run_branch ?? "",
          local: Boolean(run),
          activity: activityText(task, undefined, run, claiming(dashboard, task)),
          agentId: run?.agentId ?? "",
          workspaceId: run?.workspaceId ?? "",
          lastMessage: run?.lastMessage ?? "",
          settings: run ? runSettingsText(run) : "",
          live: liveView(dashboard, run),
          tracked: run?.adopted
            ? {
                kind: run.adopted.trunk ? "trunk" : "branch",
                note: run.adopted.trunk
                  ? `Tracked from a Paseo checkout on the trunk ${run.adopted.trunk}: there is no PR/MR. Its agent has no Paseo Dash tools, so progress comes from the agent's state; mark the task done once its work landed.`
                  : "Tracked from a Paseo workspace: its agent has no Paseo Dash tools, so progress comes from the agent's state and its PR/MR.",
                landed: landedText(run),
                archived: Boolean(landed?.archived),
              }
            : null,
        }
      : null,
    pr: pr ? { text: pr, url: prUrl, note: ownSeen?.note ?? "" } : null,
    handoff: loaded.handoff ? { run: loaded.handoff.run_id, at: loaded.handoff.at, text: loaded.handoff.text } : null,
    clarifications: loaded.clarifications ?? "",
    instructions_hash: hashText(taskInstructions(loaded.brief, loaded.acceptance.map((a) => a.text), loaded.handoff?.text, loaded.clarifications)),
    merged: dashboard.owner ? dashboard.merged.peekTask({ sync: entry.sync, mapping: entry.record.mapping }, task) : [],
    archived: isArchived(task) ? spokenTime(task.archived, now) : "",
    actions: {
      start: startReason(task, entry.record.mapping, now),
      blocked_by: startable(task) ? blockers(plan, task) : [],
      release: live,
      continue: live && task.status === "review" && Boolean(run),
      landed_done: live && Boolean(landed?.landed && landed.archived && !landed.error),
      close: !live && (task.status === "todo" || unheld(task)),
      unheld: unheld(task),
      reopen: !live && closed(task),
      triage: task.status === "inbox",
      line: lineLocked(task),
      archive: !live && closed(task) && leftWorkspaces(dashboard, task.id).length > 0,
      archive_task: closed(task) && !isArchived(task),
      unarchive: isArchived(task),
    },
    error: "",
  };
}

type TaskRuns = RpcOutput<typeof taskRunsRpc>;

/**
 * The task's runs from the plan's history, with what this machine's runs.json adds: its agent and
 * workspace, and the agent's latest reply. A run of another machine says where its agent is.
 */
export async function taskRuns(dashboard: Dashboard, input: RpcInput<typeof taskRunsRpc>, now = new Date(), host = localHost()): Promise<TaskRuns> {
  if (!dashboard.owner && dashboard.ownerReason) return { found: false, runs: [], error: dashboard.ownerReason };
  const found = locate(dashboard, input.task);
  if (!found || found.loaded.entity.type !== "task") return { found: false, runs: [], error: `No task ${input.task}.` };
  const history = await historyWithin(dashboard, found.entry.sync, found.loaded);
  if (history.error) return { found: true, runs: [], error: history.error };
  return {
    found: true,
    runs: history.runs.map((run) => {
      const record = localRecord(dashboard, run, found.loaded.entity.id);
      return {
        id: run.run_id,
        by: run.by,
        host: run.host,
        branch: run.branch,
        started: spokenTime(run.started, now),
        ended: spokenTime(run.ended, now),
        live: run.result === "live",
        result: runResult(run, record),
        pr: run.pr,
        progress: runProgress(run),
        handoff: run.handoff ? { at: spokenTime(run.handoff.at, now), text: run.handoff.text } : null,
        local: record
          ? { agentId: record.agentId ?? "", workspaceId: record.workspaceId ?? "", activity: record.activity, lastMessage: record.lastMessage ?? "" }
          : null,
        elsewhere: record ? "" : elsewhereText(run, host),
      };
    }),
    error: "",
  };
}

/** Why the task cannot start from this machine, from the index alone; the start check says the rest. */
function startReason(task: Task, mapping: Record<string, string | null>, now: Date): string {
  if (hasLiveRun(task)) return `started by ${task.run_by ?? "someone"} on ${task.run_host ?? "another machine"} since ${spokenTime(task.run_started, now)}`;
  if (!startable(task)) return `it is ${task.status}; only a todo task starts`;
  if (!task.project) return "it has no project";
  if (!mapping[task.project]) return `project ${task.project} is not mapped on this Mac`;
  return "";
}

type FeatureView = RpcOutput<typeof featureViewRpc>;

/**
 * Tasks of a feature in dependency layers (04-ux.md, The feature view), each layer in start order
 * (sortTasks). Only dependencies inside the feature make layers; a cycle (which the plan should
 * not have) puts what is left in a last phase.
 */
export function featureView(dashboard: Dashboard, input: RpcInput<typeof featureViewRpc>): FeatureView {
  const empty: FeatureView = { found: false, space: "", id: input.feature, title: "", status: "", branch: "", milestone: "", done: 0, total: 0, finished: 0, phases: [], missing: [], error: "" };
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const found = locate(dashboard, input.feature);
  if (!found || found.loaded.entity.type !== "feature") return { ...empty, error: `No feature ${input.feature}.` };
  const { entry, loaded } = found;
  const plan = entry.sync.plan;
  const feature = loaded.entity;
  const own = tasksOf(plan).filter((t) => refId(t.feature) === feature.id && t.status !== "canceled" && t.status !== "inbox");
  const ids = new Set(own.map((t) => t.id));
  const inside = (t: Task) => t.depends_on.map((d) => refId(d) ?? "").filter((d) => ids.has(d));

  const layer = new Map<string, number>();
  for (let round = 0; round < own.length && layer.size < own.length; round += 1) {
    for (const task of own) {
      if (layer.has(task.id)) continue;
      const deps = inside(task);
      if (deps.every((d) => layer.has(d))) layer.set(task.id, deps.length ? Math.max(...deps.map((d) => layer.get(d)!)) + 1 : 0);
    }
  }
  const last = layer.size ? Math.max(...layer.values()) + 1 : 0;
  const phases: FeatureView["phases"] = [];
  for (const { task } of sortTasks(own.map((task) => ({ plan, task })), { activity: (t) => localRun(dashboard.runs, t)?.activity })) {
    const index = layer.get(task.id) ?? last;
    const run = localRun(dashboard.runs, task);
    const waits = inside(task)
      .map((d) => plan.entities.get(d)?.entity as Task)
      .filter((d) => d.status !== "done")
      .map((d) => d.project ?? d.id);
    const note = waits.length ? `waits for ${[...new Set(waits)].join(", ")}` : [progressText(task, plan.entities.get(task.id)!.acceptance), activityText(task, undefined, run, claiming(dashboard, task))].filter(Boolean).join(" · ");
    (phases[index] ??= []).push({
      id: task.id,
      title: task.title,
      project: task.project ?? "",
      status: task.status,
      glyph: glyphFor(dashboard, plan, task),
      note,
      human: humanWork(plan, task),
      after: inside(task),
    });
  }
  const planned = feature.type === "feature" ? feature.projects : [];
  return {
    found: true,
    space: entry.record.key,
    id: feature.id,
    title: feature.title,
    status: feature.status,
    branch: feature.type === "feature" ? (feature.branch ?? "") : "",
    milestone: feature.type === "feature" ? (plan.entities.get(refId(feature.milestone) ?? "")?.entity.title ?? "") : "",
    done: own.filter((t) => t.status === "done").length,
    total: own.length,
    finished: tasksOf(plan).filter((t) => refId(t.feature) === feature.id && closed(t) && !isArchived(t)).length,
    phases: phases.filter(Boolean),
    missing: planned.filter((p) => !own.some((t) => t.project === p)),
    error: "",
  };
}

type PlanOptions = RpcOutput<typeof uiOptionsRpc>;

/** What the dashboard's forms offer to pick in one space (shared/ui.ts). */
export async function planOptions(dashboard: Dashboard, input: RpcInput<typeof uiOptionsRpc>): Promise<PlanOptions> {
  const empty: PlanOptions = { projects: [], milestones: [], features: [], labels: [], people: [], me: { key: "", email: "" }, error: "" };
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const entry = dashboard.spaces.get(input.space.trim().toUpperCase());
  if (!entry) return { ...empty, error: `No space ${input.space}.` };
  const email = await entry.sync.gitEmail();
  const plan = entry.sync.plan;
  const people = plan.space?.people ?? {};
  const tasks = tasksOf(plan);
  const open = (status: string) => status === "planned" || status === "active";
  return {
    projects: Object.keys(plan.space?.projects ?? {}).map((key) => ({ key, mapped: Boolean(entry.record.mapping[key]) })),
    milestones: milestonesOf(plan)
      .filter((m) => open(m.status))
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, title: m.title, due: m.due?.slice(0, 10) ?? "", status: m.status })),
    features: featuresOf(plan)
      .filter((f) => open(f.status))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title))
      .map((f) => ({ id: f.id, title: f.title, milestone: refId(f.milestone) ?? "", projects: f.projects })),
    labels: labelOptions(plan),
    people: Object.entries(people).map(([key, p]) => ({
      key,
      name: p.name ?? "",
      emails: p.emails,
      github: p.github ?? "",
      gitlab: Object.entries(p.gitlab).map(([host, login]) => ({ host, login })),
      open_tasks: tasks.filter((t) => t.status !== "done" && t.status !== "canceled" && t.assignee === key).length,
    })),
    me: { key: personByEmail(people, email) ?? "", email },
    error: "",
  };
}

/** The palette, then the labels in use it does not define, each with how many tasks carry it. */
function labelOptions(plan: Plan): PlanOptions["labels"] {
  const palette = plan.space?.labels ?? {};
  const counts = new Map<string, { name: string; tasks: number }>();
  for (const task of tasksOf(plan)) {
    for (const label of task.labels) {
      const key = label.toLowerCase();
      const seen = counts.get(key) ?? { name: label, tasks: 0 };
      seen.tasks += 1;
      counts.set(key, seen);
    }
  }
  const defined = Object.entries(palette).map(([name, def]) => ({
    name,
    color: def.color ?? "",
    description: def.description ?? "",
    defined: true,
    tasks: counts.get(name.toLowerCase())?.tasks ?? 0,
  }));
  const undefinedOnes = [...counts.values()]
    .filter(({ name }) => !findLabel(palette, name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, tasks }) => ({ name, color: "", description: "", defined: false, tasks }));
  return [...defined, ...undefinedOnes];
}

type LiveRuns = RpcOutput<typeof uiRunsRpc>;

/** The live runs started on this machine whose plan still holds them (shared/ui.ts). */
export function liveRuns(dashboard: Dashboard): LiveRuns {
  if (!dashboard.owner && dashboard.ownerReason) return { runs: [], error: dashboard.ownerReason };
  const runs: LiveRuns["runs"] = [];
  for (const run of dashboard.runs?.runs.values() ?? []) {
    const loaded = dashboard.spaces.get(run.space)?.sync.plan.entities.get(run.task);
    const task = loaded?.entity;
    if (!loaded || task?.type !== "task" || task.run_id !== run.run_id || !hasLiveRun(task)) continue;
    const ticks = loaded.acceptance;
    const progress = task.progress_total
      ? `${task.progress_done ?? 0}/${task.progress_total}`
      : ticks.length
        ? `${ticks.filter((a) => a.done).length}/${ticks.length}`
        : "";
    runs.push({ task: task.id, title: task.title, space: run.space, status: task.status, workspaceId: run.workspaceId ?? "", agentId: run.agentId ?? "", progress });
  }
  return { runs: runs.sort((a, b) => a.task.localeCompare(b.task)), error: "" };
}

/** The ROADMAP.md text of one space, rendered from the plan as its commits would carry it. */
export function roadmapText(dashboard: Dashboard, input: RpcInput<typeof uiRoadmapRpc>): RpcOutput<typeof uiRoadmapRpc> {
  if (!dashboard.owner && dashboard.ownerReason) return { text: "", error: dashboard.ownerReason };
  const entry = dashboard.spaces.get(input.space.trim().toUpperCase());
  if (!entry) return { text: "", error: `No space ${input.space}.` };
  return { text: renderRoadmap(entry.sync.plan) ?? "", error: "" };
}

/** What the run's agent does, what the run changed, and which other runs here change the same files. */
function liveView(dashboard: Dashboard, run: RunRecord | undefined): NonNullable<TaskView["run"]>["live"] {
  const view = run && dashboard.follower.view(run.run_id);
  if (!run || !view) return null;
  return { ...view, overlaps: overlapsByTask(dashboard).get(run.task) ?? [] };
}

/** A file of a code map is read only below this size; a map stops reading past MAP_BYTES in all. */
const FILE_BYTES = 256 * 1024;
const MAP_BYTES = 4 * 1024 * 1024;

/** The task's code map, while this machine follows its run (shared/views.ts `task.codemap`). */
export function taskCodeMap(dashboard: Dashboard, input: RpcInput<typeof taskCodeMapRpc>): RpcOutput<typeof taskCodeMapRpc> {
  const empty = { followed: false, nodes: [], more: 0, error: "" };
  if (!dashboard.owner && dashboard.ownerReason) return { ...empty, error: dashboard.ownerReason };
  const found = locate(dashboard, input.task);
  if (!found || found.loaded.entity.type !== "task") return { ...empty, error: `No task ${input.task}.` };
  const run = localRun(dashboard.runs, found.loaded.entity);
  const code = run && dashboard.follower.codeFiles(run.run_id);
  if (!code) return empty;
  let root: string;
  try {
    root = realpathSync(code.root);
  } catch {
    return { ...empty, followed: true, error: "The run's checkout cannot be read." };
  }
  // Only files inside the checkout, through no link out of it, and not too large.
  const within = (path: string): string | undefined => {
    try {
      const real = realpathSync(join(root, path));
      const inside = relative(root, real);
      return inside && !inside.startsWith("..") && !isAbsolute(inside) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  let budget = MAP_BYTES;
  const read = (path: string): string | undefined => {
    const real = within(path);
    if (!real) return undefined;
    // Opened without blocking and checked on the descriptor itself: a file swapped for a FIFO or
    // grown after a check is neither waited on nor read past the limits.
    let fd: number | undefined;
    try {
      // O_NOFOLLOW: a link put in place after the path was checked is not followed out of the checkout.
      fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > FILE_BYTES || stat.size > budget) return undefined;
      const buffer = Buffer.alloc(stat.size);
      const size = readSync(fd, buffer, 0, stat.size, 0);
      budget -= size;
      return buffer.subarray(0, size).toString("utf8");
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const exists = (path: string): boolean => {
    const real = within(path);
    try {
      return Boolean(real && statSync(real).isFile());
    } catch {
      return false;
    }
  };
  const map = buildCodeMap(code.files, read, exists);
  return { followed: true, nodes: map.nodes, more: map.more, error: "" };
}
