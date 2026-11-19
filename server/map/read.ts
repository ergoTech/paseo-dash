import type { RpcInput } from "@getpaseo/plugin";
import type { Glyph, MapAnswer, MetroMap, mapRpc } from "../../shared/map.ts";
import type { Task } from "../../shared/model.ts";
import { liveNowOf, localRun, overlapsByTask } from "../api/view.ts";
import type { LiveOverlap } from "../../shared/live.ts";
import type { Activity } from "../runner/runs.ts";
import type { Dashboard } from "../dashboard.ts";
import type { Plan } from "../plan/load.ts";
import type { SpaceEntry } from "../api/resolve.ts";
import { buildMetro, planGlyph } from "./metro.ts";
import { BUSY_STATUSES } from "../../shared/activity.ts";
import { alsoIn } from "../spaces/overlap.ts";

const ACTIVITY_GLYPH: Record<Activity, Glyph> = {
  launching: "working",
  working: "working",
  needs_input: "needs_you",
  failed: "failed",
  // An agent that ended its turn while the task is in progress, or is gone, waits for the person: the
  // same facts Live lists under Needs you (server/overview.ts, kinds answer and stopped).
  waiting: "needs_you",
  stopped: "needs_you",
};

/** A task's mark: from the plan, refined by this machine's run of it when there is one. */
export function glyphFor(dashboard: Dashboard, plan: Plan, task: Task): Glyph {
  const run = localRun(dashboard.runs, task);
  // A tracked trunk checkout's agent is gone at its normal end, no trouble: Needs you lists it as
  // `checkout` with the same mark, and the task waits for "Mark done".
  if (task.status === "in_progress" && run?.adopted?.trunk && run.activity === "stopped") return "elsewhere";
  if (task.status === "in_progress" && run) return ACTIVITY_GLYPH[run.activity];
  return planGlyph(plan, task);
}

const emptyMap = (space: { key: string; name: string }, error: string): MetroMap => ({
  space,
  lines: [],
  folded: [],
  groups: [],
  columns: [],
  interchanges: [],
  stations: [],
  depot: [],
  error,
});

/**
 * One space's metro, with this machine's runs refining the marks of their tasks; without a space,
 * every space's metro as a band (shared/map.ts), its station and interchange keys prefixed with the
 * space key since the same project and column ids recur in other bands.
 */
export function readMap(dashboard: Dashboard, input: RpcInput<typeof mapRpc>, now = new Date()): MapAnswer {
  const asked = input.space?.trim() ?? "";
  if (!dashboard.owner && dashboard.ownerReason) return { ...emptyMap({ key: asked, name: "" }, dashboard.ownerReason), bands: [] };
  if (!asked) {
    const overlaps = overlapsByTask(dashboard);
    const bands = [...dashboard.spaces.values()].map((entry) => {
      const band = spaceMap(dashboard, entry, input, now, overlaps);
      const key = entry.record.key;
      for (const station of band.stations) station.key = `${key}/${station.key}`;
      for (const interchange of band.interchanges) interchange.key = `${key}/${interchange.key}`;
      return band;
    });
    return { ...emptyMap({ key: "", name: "" }, ""), bands };
  }
  const entry = [...dashboard.spaces.values()].find((s) => s.record.key.toLowerCase() === asked.toLowerCase());
  if (!entry) return { ...emptyMap({ key: asked, name: "" }, `No space ${asked}.`), bands: [] };
  return { ...spaceMap(dashboard, entry, input, now, overlapsByTask(dashboard)), bands: [] };
}

function spaceMap(dashboard: Dashboard, entry: SpaceEntry, input: RpcInput<typeof mapRpc>, now: Date, overlaps: Map<string, LiveOverlap[]>): MetroMap {
  const plan = entry.sync.plan;
  const glyphOf = (task: Task): Glyph => glyphFor(dashboard, plan, task);
  const liveOf = (task: Task) => liveNowOf(dashboard.runs, dashboard.follower, task);
  const overlapsOf = (task: Task) => overlaps.get(task.id);
  const map = buildMetro({ plan, space: { key: entry.record.key, name: entry.record.name }, glyphOf, liveOf, overlapsOf, showDone: input.done, group: input.group, showEmpty: input.empty, now });
  const projects = plan.space?.projects ?? {};
  for (const line of map.lines) {
    const remote = projects[line.project]?.remote;
    if (remote) line.shared_with = alsoIn(dashboard.spaces.values(), entry.record.key, remote);
  }
  // Paseo's own work on each line, from the last read (never waited for here); marked stale while
  // the latest read failed, so old counts never pass for current ones.
  const activity = dashboard.activity.peek();
  if (activity) {
    for (const line of map.lines) {
      line.stale = Boolean(dashboard.activity.lastError);
      const local = entry.record.mapping[line.project];
      const active = local ? (activity.byProject.get(local)?.active ?? []) : [];
      line.open = active.length;
      line.busy = active.filter((w) => BUSY_STATUSES.includes(w.status)).length;
    }
  }
  return map;
}
