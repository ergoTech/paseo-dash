import type { LiveNow, LiveOverlap } from "../../shared/live.ts";
import { shownLabel } from "../../shared/labels.ts";
import { type Glyph, type MetroMap, URGENCY } from "../../shared/map.ts";
import { type Feature, type Milestone, refId, type Task } from "../../shared/model.ts";
import { lineColors } from "../../shared/projects.ts";
import { blockers, daysLeft, featuresOf, milestoneOf, milestonesOf, sortTasks, tasksOf } from "../api/view.ts";
import type { Plan } from "../plan/load.ts";

/**
 * The metro layout as a pure function of the plan (04-ux.md, Rendering and scale): which column,
 * slot and row every interchange and station takes. Pixels are the client's business.
 *
 * - Lines are the space's projects in space.yaml order, kept together by group (groups in the order
 *   they first appear, projects without a group after them, unknown projects last). A listed line
 *   without any station is drawn as empty, or folded when empty lines are not wanted; an unknown
 *   project shows only with stations. With a group asked, only that group's lines and tasks count,
 *   release totals included.
 * - Columns are open releases by due date, then `order`, then id; then Later. Finished or canceled
 *   releases fold into one Done column at the left, or show one by one when asked.
 * - A task's column is its release (its own milestone, else its feature's); an open task of a finished
 *   or canceled release goes to Later, so open work never hides in Done.
 * - In a column, each feature with stations there takes a slot (by `order`, then id); tasks without
 *   a feature (or whose feature is missing or canceled) share one last slot. A feature whose tasks
 *   are in several releases has an interchange in each of them.
 * - A station is one feature's tasks in one project in one column (or one project's tasks without a
 *   feature); its mark is the most urgent of its tasks, which are listed in the order of every task list (sortTasks).
 * - Drafts are in the depot, not on the map; canceled tasks are not shown.
 */

/** The most urgent mark of several. */
export function mostUrgent(glyphs: Glyph[]): Glyph {
  return [...glyphs].sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b))[0] ?? "todo";
}

/** A task's mark from the plan alone; the caller refines in-progress tasks with what this machine knows. */
export function planGlyph(plan: Plan, task: Task): Glyph {
  switch (task.status) {
    case "done":
      return "done";
    case "review":
      return "review";
    case "in_progress":
      return "elsewhere";
    default:
      return blockers(plan, task).length ? "blocked" : "todo";
  }
}

export interface MetroInput {
  plan: Plan;
  space: { key: string; name: string };
  glyphOf?: (task: Task) => Glyph;
  /** The latest call of a task's agent on this machine, while it runs. */
  liveOf?: (task: Task) => LiveNow | undefined;
  /** Other tasks whose runs on this machine change some of the same files. */
  overlapsOf?: (task: Task) => LiveOverlap[] | undefined;
  showDone?: boolean;
  /** Only this group's projects; empty: all. */
  group?: string;
  /** Draw listed projects without stations as empty lines (default) instead of folding them. */
  showEmpty?: boolean;
  now?: Date;
}

const finished = (m: Milestone) => m.status === "done" || m.status === "canceled";

const liveField = (live: LiveNow | undefined) => (live ? { live } : {});
const overlapField = (overlaps: LiveOverlap[] | undefined) => (overlaps?.length ? { overlaps } : {});

export function buildMetro(input: MetroInput): MetroMap {
  const { plan } = input;
  const glyphOf = input.glyphOf ?? ((task: Task) => planGlyph(plan, task));
  const now = input.now ?? new Date();
  const projects = plan.space?.projects ?? {};
  const palette = plan.space?.labels ?? {};
  const groupOf = (project: string) => projects[project]?.group ?? "";
  const tasks = tasksOf(plan).filter(
    (t) => t.status !== "canceled" && t.status !== "inbox" && (!input.group || groupOf(t.project ?? "") === input.group),
  );
  const features = new Map(featuresOf(plan).map((f) => [f.id, f]));
  const milestones = milestonesOf(plan);

  // Columns.
  const byDue = (a: Milestone, b: Milestone) =>
    (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
  const open = milestones.filter((m) => !finished(m)).sort(byDue);
  const closed = milestones.filter(finished).sort(byDue);
  type Column = { id: string; title: string; due: string; days_left: number | null };
  const columns: Column[] = [];
  const columnOfMilestone = new Map<string, number>();
  if (closed.length) {
    if (input.showDone) {
      for (const m of closed) {
        columnOfMilestone.set(m.id, columns.length);
        columns.push({ id: m.id, title: m.title, due: m.due ?? "", days_left: null });
      }
    } else {
      const index = columns.length;
      for (const m of closed) columnOfMilestone.set(m.id, index);
      columns.push({ id: "done", title: "Done", due: "", days_left: null });
    }
  }
  for (const m of open) {
    columnOfMilestone.set(m.id, columns.length);
    columns.push({ id: m.id, title: m.title, due: m.due ?? "", days_left: daysLeft(m.due, now) });
  }
  const later = columns.length;
  columns.push({ id: "later", title: "Later", due: "", days_left: null });
  const finishedIds = new Set(closed.map((m) => m.id));
  const columnOf = (task: Task) => {
    const milestone = milestoneOf(plan, task);
    if (milestone === undefined || !columnOfMilestone.has(milestone)) return later;
    if (finishedIds.has(milestone) && task.status !== "done") return later;
    return columnOfMilestone.get(milestone)!;
  };

  // Lines.
  const listed = Object.keys(projects);
  const colorOf = lineColors(listed.map((p) => [p, projects[p]!.color]));
  const groupRank = new Map<string, number>();
  for (const p of listed) if (groupOf(p) && !groupRank.has(groupOf(p))) groupRank.set(groupOf(p), groupRank.size);
  groupRank.set("", groupRank.size);
  const declared = listed
    .map((p, index) => ({ p, index }))
    .sort((a, b) => groupRank.get(groupOf(a.p))! - groupRank.get(groupOf(b.p))! || a.index - b.index)
    .map(({ p }) => p)
    .filter((p) => !input.group || groupOf(p) === input.group);
  const extra = [...new Set(tasks.map((t) => t.project ?? "").filter((p) => p && !listed.includes(p)))].sort();
  const allLines = [...declared, ...extra];

  // Stations, grouped by column, feature (or none) and project.
  type Group = { column: number; feature: string; project: string; tasks: Task[] };
  const groups = new Map<string, Group>();
  for (const task of tasks) {
    const project = task.project ?? "";
    if (!project) continue;
    const ref = refId(task.feature);
    const found = ref ? features.get(ref) : undefined;
    const live = found && found.status !== "canceled" ? found.id : "";
    const column = columnOf(task);
    const key = `${column}|${live}|${project}`;
    const group = groups.get(key) ?? { column, feature: live, project, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }

  const used = new Set([...groups.values()].map((g) => g.project));
  const showEmpty = input.showEmpty ?? true;
  const lines = allLines.filter((p) => used.has(p) || (showEmpty && listed.includes(p)));
  const folded = allLines.filter((p) => !lines.includes(p));
  const rowOf = new Map(lines.map((p, i) => [p, i]));

  // Slots: features with stations in the column, by order then id; then the slot for tasks without one.
  const slotsOf = columns.map((_, column) => {
    const ids = [...new Set([...groups.values()].filter((g) => g.column === column && g.feature).map((g) => g.feature))];
    const ordered = ids
      .map((id) => features.get(id)!)
      .filter(Boolean)
      .sort((a: Feature, b: Feature) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    const loose = [...groups.values()].some((g) => g.column === column && !g.feature);
    return { features: ordered.map((f) => f.id), loose };
  });
  const slotOf = (column: number, feature: string) => {
    const slots = slotsOf[column]!;
    return feature ? slots.features.indexOf(feature) : slots.features.length;
  };

  const stations: MetroMap["stations"] = [...groups.values()]
    .map((g) => {
      const marks = g.tasks.map(glyphOf);
      return {
        key: `${columns[g.column]!.id}:${g.feature || "-"}:${g.project}`,
        column: g.column,
        slot: slotOf(g.column, g.feature),
        row: rowOf.get(g.project)!,
        feature: g.feature,
        glyph: mostUrgent(marks),
        tasks: sortTasks(g.tasks.map((task, i) => ({ plan, task, glyph: marks[i]! }))).map(({ task, glyph }) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          glyph,
          labels: task.labels.map((name) => shownLabel(palette, name)),
          ...liveField(input.liveOf?.(task)),
          ...overlapField(input.overlapsOf?.(task)),
        })),
      };
    })
    .sort((a, b) => a.column - b.column || a.slot - b.slot || a.row - b.row);

  const interchanges: MetroMap["interchanges"] = [];
  columns.forEach((_, column) => {
    for (const id of slotsOf[column]!.features) {
      const feature = features.get(id)!;
      const rows = stations.filter((s) => s.column === column && s.feature === id).map((s) => s.row);
      interchanges.push({
        key: `${columns[column]!.id}:${id}`,
        feature: id,
        title: feature.title,
        branch: feature.branch ?? "",
        status: feature.status,
        column,
        slot: slotOf(column, id),
        rows,
        top: Math.min(...rows),
        bottom: Math.max(...rows),
      });
    }
  });

  const counted = (column: number) => stations.filter((s) => s.column === column).flatMap((s) => s.tasks);
  return {
    space: input.space,
    lines: lines.map((project, row) => ({ project, row, color: colorOf.get(project) ?? "", group: groupOf(project), empty: !used.has(project), open: 0, busy: 0, stale: false, shared_with: [] })),
    folded,
    groups: [...groupRank.keys()].filter(Boolean),
    columns: columns.map((c, column) => {
      const own = counted(column);
      return {
        id: c.id,
        title: c.title,
        due: c.due,
        days_left: c.days_left,
        done: own.filter((t) => t.glyph === "done").length,
        total: own.length,
        needs_you: own.filter((t) => t.glyph === "needs_you").length,
        blocked: own.filter((t) => t.glyph === "blocked").length,
        slots: slotsOf[column]!.features.length + (slotsOf[column]!.loose ? 1 : 0),
      };
    }),
    interchanges,
    stations,
    depot: tasksOf(plan)
      .filter((t) => t.status === "inbox")
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.id.localeCompare(b.id))
      .map((t) => ({ id: t.id, title: t.title, project: t.project ?? "" })),
    error: "",
  };
}
