import type { RpcOutput } from "@getpaseo/plugin";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginCommandCapabilities,
  PluginTimelineItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { STARTED_CARD } from "../shared/timeline.ts";
import { uiRunsRpc } from "../shared/ui.ts";
import { taskViewRpc } from "../shared/views.ts";
import { appVisible, onChangesSeen, useChanges } from "./changes.ts";
import { REFRESH_MS, useStyles } from "./common.tsx";
import { openScreen } from "./nav.ts";
import { TaskDetail } from "./task.tsx";
import { PLUGIN_NAME } from "../shared/edition.ts";

/**
 * The dashboard inside Paseo's own surfaces (04-ux.md, Surfaces): Command Center items (one opens the
 * search, one adds the
 * workspace's project as a line, one moves the workspace's task), `/task`, a header button on each task workspace and a composer pill
 * on each task agent, the workspace panel "Task", and the timeline card a start appends.
 */

type Runs = RpcOutput<typeof uiRunsRpc>["runs"];
type Run = Runs[number];

const PANEL_ID = "task";
/** The header button's and the composer pill's id; each target (workspace, agent) has one. */
const BUTTON_ID = "task";

/** The live runs; an answer with an error (another installation owns the data) throws it. */
async function runs(context: Pick<PluginCommandCapabilities, "rpc">): Promise<Runs> {
  const answer = await context.rpc(uiRunsRpc, {});
  if (answer.error) throw new Error(answer.error);
  return answer.runs;
}

/** A task's label on a button or pill: "LAC-7K3QX · 3/5". */
function label(run: Run): string {
  return run.progress ? `${run.task} · ${run.progress}` : run.task;
}

/**
 * Opens the task this workspace or agent runs. A request id makes each "done" or "move" ask once, even on a
 * screen the host reuses; without a run the dashboard opens and says why.
 */
async function openTask(context: PluginCommandCapabilities, match: (run: Run) => boolean, action?: "done" | "move"): Promise<void> {
  let run: Run | undefined;
  try {
    run = (await runs(context)).find(match);
  } catch (error) {
    context.openScreen({ screenId: "space", params: { notice: `Could not read the runs of ${PLUGIN_NAME}: ${String((error as Error)?.message ?? error)}` } });
    return;
  }
  if (!run) {
    context.openScreen({ screenId: "space", params: { notice: `No ${PLUGIN_NAME} task runs here.` } });
    return;
  }
  context.openScreen({ screenId: "task", params: action ? { task: run.task, action, ask: String(Date.now()) } : { task: run.task } });
}

export function registerSurfaces(client: PluginClientContext): () => void {
  const cleanups: (() => void)[] = [
    client.addCommandCenterItem({
      id: "new-task",
      title: "New task",
      icon: "Plus",
      keywords: ["dashboard", "task", "create"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: "space", params: { new: "task" } }),
    }),
    client.addCommandCenterItem({
      id: "import-laconote",
      title: "Import from Laconote",
      icon: "Download",
      keywords: ["dashboard", "laconote", "meeting", "inbox", "import"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: "space", params: { import: String(Date.now()) } }),
    }),
    // ⌘K lists only fixed items: this one opens PD with its search focused (client/topbar.tsx).
    client.addCommandCenterItem({
      id: "search",
      title: `Search ${PLUGIN_NAME}`,
      icon: "Search",
      keywords: ["search", "find", "task", "id", "feature", "release", "paseo dash", "pd", "dashboard"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: "space", params: { search: String(Date.now()) } }),
    }),
    // Fetches every plan now, outside the 60-second loop; the space screen says when and what failed (client/sync.tsx).
    client.addCommandCenterItem({
      id: "sync",
      title: `Sync ${PLUGIN_NAME}`,
      icon: "RefreshCw",
      keywords: ["sync", "fetch", "pull", "plan", "refresh", "paseo dash", "pd", "dashboard"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: "space", params: { sync: String(Date.now()) } }),
    }),
    client.addCommandCenterItem({
      id: "open-dashboard",
      title: `Open ${PLUGIN_NAME}`,
      icon: "Map",
      keywords: ["paseo dash", "pd", "dashboard", "roadmap", "metro"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: "space", params: {} }),
    }),
    // Workspace context only: it is offered with an agent tab focused too, and every run has a workspace.
    client.addCommandCenterItem({
      id: "open-workspace-task",
      title: "Open this task",
      icon: "ListChecks",
      keywords: ["dashboard", "task"],
      context: "workspace",
      onSelect: (context) => openTask(context, (r) => r.workspaceId === context.workspace.id),
    }),
    // "Mark task done" on a live run is a release, so it opens the task with its confirmation.
    client.addCommandCenterItem({
      id: "done-workspace-task",
      title: "Mark task done",
      icon: "CircleCheck",
      keywords: ["dashboard", "task", "done", "release"],
      context: "workspace",
      onSelect: (context) => openTask(context, (r) => r.workspaceId === context.workspace.id, "done"),
    }),
    // A started task keeps its line; the dialog says so and still moves its release or feature.
    client.addCommandCenterItem({
      id: "move-workspace-task",
      title: "Move this task",
      icon: "ArrowRightLeft",
      keywords: ["dashboard", "task", "move", "release", "milestone", "feature"],
      context: "workspace",
      onSelect: (context) => openTask(context, (r) => r.workspaceId === context.workspace.id, "move"),
    }),
    // The workspace's Paseo project as a line of the dashboard (D18); the Projects tab does the adding.
    client.addCommandCenterItem({
      id: "add-workspace-project",
      title: `Add this project to ${PLUGIN_NAME}`,
      icon: "ListPlus",
      keywords: ["dashboard", "project", "line", "add", "roadmap"],
      context: "workspace",
      onSelect: (context) => context.openScreen({ screenId: "space", params: { tab: "projects", add: context.workspace.projectId } }),
    }),
    client.addSlashCommand({
      name: "task",
      description: `Open this agent's ${PLUGIN_NAME} task; /task done marks it done after a confirmation`,
      argumentHint: "[done]",
      context: "agent",
      onSubmit: (context) => openTask(context, (r) => r.agentId === context.agent.id, context.args.trim().toLowerCase() === "done" ? "done" : undefined),
    }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Task", icon: "ListChecks", Component: TaskPanel }),
    client.addTimelineRenderer({ ...STARTED_CARD, schema: startedCard, Component: StartedCard }),
  ];
  cleanups.push(syncButtons(client));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * A header button per task workspace and a composer pill per task agent, kept in step with the live
 * runs: registered when a run appears, relabelled as its progress changes, removed when it ends.
 */
function syncButtons(client: PluginClientContext): () => void {
  const headers = new Map<string, { registration: PluginButtonRegistration; label: string; title: string }>();
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string; title: string }>();
  let stopped = false;
  // One tick at a time, so a slow answer never lands after a newer one.
  let running = false;

  const reconcile = (
    current: Map<string, { registration: PluginButtonRegistration; label: string; title: string }>,
    wanted: Map<string, Run>,
    add: (key: string, run: Run) => PluginButtonRegistration,
  ) => {
    for (const [key, entry] of current) {
      if (!wanted.has(key)) {
        entry.registration.remove();
        current.delete(key);
      }
    }
    for (const [key, run] of wanted) {
      const entry = current.get(key);
      const text = label(run);
      const title = `${run.task} · ${run.title}`;
      if (!entry) {
        // A refused registration is skipped for this pass and tried again on the next one.
        try {
          current.set(key, { registration: add(key, run), label: text, title });
        } catch (error) {
          console.warn(`dashboard: could not add the button for ${run.task}: ${String((error as Error)?.message ?? error)}`);
        }
      } else if (entry.label !== text || entry.title !== title) {
        entry.registration.update({ label: text, title });
        entry.label = text;
        entry.title = title;
      }
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    let live: Runs;
    try {
      live = await runs(client);
    } catch {
      return; // The daemon is unreachable or not the owner for now; the buttons stay as they were.
    } finally {
      running = false;
    }
    if (stopped) return;
    reconcile(headers, new Map(live.filter((r) => r.workspaceId).map((r) => [r.workspaceId, r])), (workspaceId, run) =>
      client.addHeaderButton({
        // Unique per workspace is enough, and Paseo takes only `^[a-z][a-z0-9-]*$`: no Paseo id in it.
        id: BUTTON_ID,
        workspaceId,
        button: {
          title: `${run.task} · ${run.title}`,
          label: label(run),
          icon: "ListChecks",
          behavior: { kind: "action", onPress: () => client.openPanel(PANEL_ID, { workspaceId }) },
        },
      }),
    );
    reconcile(pills, new Map(live.filter((r) => r.agentId && r.workspaceId).map((r) => [r.agentId, r])), (agentId, run) =>
      client.addComposerPill({
        id: BUTTON_ID,
        workspaceId: run.workspaceId,
        agentId,
        button: {
          title: `${run.task} · ${run.title}`,
          label: label(run),
          icon: "ListChecks",
          behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "task", params: { task: run.task } }) },
        },
      }),
    );
  };

  void tick();
  const offChanges = onChangesSeen(() => void tick());
  const timer = setInterval(() => {
    if (appVisible()) void tick();
  }, REFRESH_MS);
  return () => {
    stopped = true;
    offChanges();
    clearInterval(timer);
    for (const entry of [...headers.values(), ...pills.values()]) entry.registration.remove();
    headers.clear();
    pills.clear();
  };
}

/** The workspace panel "Task": the task this workspace runs, when the dashboard started it. */
function TaskPanel({ workspaceId, theme, layout, navigation }: PluginWorkspacePanelProps) {
  useChanges();
  const styles = useStyles(theme, layout.compact);
  const read = useRpc(uiRunsRpc);
  const live = useQuery({ queryKey: ["dashboard", "runs"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  const run = live.data?.runs.find((r) => r.workspaceId === workspaceId);
  if (run) return <TaskDetail id={run.task} theme={theme} compact navigation={navigation} inWorkspace />;
  return (
    <View style={[styles.screen, styles.content]}>
      {live.isError ? <Text style={styles.error}>{`Could not read ${PLUGIN_NAME}: ${String(live.error)}`}</Text> : null}
      {live.data?.error ? <Text style={styles.error}>{live.data.error}</Text> : null}
      {live.data && !live.data.error ? <Text style={styles.muted}>{`No ${PLUGIN_NAME} task runs in this workspace.`}</Text> : null}
    </View>
  );
}

const startedCard = z.object({ task: z.string(), space: z.string(), branch: z.string(), run: z.string() });

/** "Started from Paseo Dash: LAC-7K3QX · TOTP endpoints in core", on the agent's timeline. */
function StartedCard({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof startedCard>>) {
  const styles = useStyles(theme, layout.compact);
  const read = useRpc(taskViewRpc);
  const { task, branch } = item.data;
  const view = useQuery({ queryKey: ["dashboard", "task", task], queryFn: () => read({ task }) });
  const title = view.data?.found ? ` · ${view.data.title}` : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Started from ${PLUGIN_NAME}: ${task}${title}, branch ${branch}. Open the task.`}
      onPress={() => openScreen("task", { task })}
      style={styles.card}
    >
      <Text style={styles.text}>{`Started from ${PLUGIN_NAME}: ${task}${title}`}</Text>
      <Text style={styles.muted}>{`Branch ${branch}`}</Text>
    </Pressable>
  );
}
