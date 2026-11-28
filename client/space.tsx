import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { spaceOfId } from "../shared/across.ts";
import { inboxListRpc, tasksListRpc, TASK_FILTERS } from "../shared/api.ts";
import { type Glyph, mapRpc, type MetroMap } from "../shared/map.ts";
import { tasksSendBackRpc, uiRoadmapRpc } from "../shared/ui.ts";
import { type NeedsKind, overviewRpc } from "../shared/overview.ts";
import { useChanges } from "./changes.ts";
import { Button, Chip, ItemRow, LineBadge, LiveStrip, Mark, REFRESH_MS, Section, SpaceTag, type Styles, Tabs, Toggle, useStyles } from "./common.tsx";
import { GLYPH_CHAR } from "./glyphs.ts";
import { glyphStrip, MetroLegend, MetroView } from "./metro.tsx";
import { MergeDialog, StatusDialog } from "./actions.tsx";
import { FeatureForm, ReleaseForm, TaskForm, TaskFormFor, useRefresh } from "./forms.tsx";
import type { ScreenLocation } from "./history.ts";
import { Here, type Inspector as InspectorContext, PeekHere, useArrival, useInspector, useOpen, useShow } from "./nav.ts";
import { CLOSED, current as onView, decode, encode, open, type Peek, type PeekState } from "./peek.ts";
import { Inspector } from "./inspector.tsx";
import { forTheme, isDark } from "./roadmap-theme.ts";
import { ActivitySheet, SpaceActivity } from "./activity.tsx";
import { Onboarding } from "./onboarding.tsx";
import { ProjectsTab } from "./projects.tsx";
import { LaconoteImport } from "./laconote.tsx";
import { IssueImport } from "./issues.tsx";
import { LabelChips, SpaceFilter, TaskFilters, useOptionsOf, useSpaceOptions, withColors } from "./labels.tsx";
import { TeamTab } from "./team.tsx";
import { EventsSection } from "./events.tsx";
import { RecapSection } from "./recap.tsx";
import { PLUGIN_NAME } from "../shared/edition.ts";
import { RankButtons } from "./rank.tsx";
import { NeedCards } from "./reconcile.tsx";
import { AutopilotSection, StartCandidatesSection, StartNextButton } from "./queue.tsx";
import { ReadyReviewSection } from "./ready-review.tsx";
import { ManagedQueueSection } from "./managed-queue.tsx";
import { BoardTab } from "./board.tsx";
import { SyncControl } from "./sync.tsx";
import { TopBar } from "./topbar.tsx";
import type { RecentItem } from "../shared/ui.ts";

/**
 * A space (04-ux.md, Surfaces): the board, the metro map, the live board, the task list, the inbox,
 * the roadmap and the projects. Wide layouts open on the board, the map a tab away (D7). On a phone
 * the full map does not fit, so it opens on the lines list; the board, features and the map stay a
 * tab away (04-ux.md, The line view and the phone). With no space yet it offers to
 * create the plan repository (D18). With several spaces and none asked for, it is the all-spaces
 * view (04-ux.md, All spaces): every space's map as a band, and lists across the spaces with a tag
 * and a filter for the space; writes go to one space, the forms ask which.
 */

type Tab = "board" | "map" | "lines" | "features" | "live" | "tasks" | "inbox" | "roadmap" | "projects" | "team";
type Theme = PluginScreenProps["theme"];

export function SpaceScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  useChanges();
  const styles = useStyles(theme, layout.compact);
  const readOverview = useRpc(overviewRpc);
  const all = useQuery({ queryKey: ["dashboard", "overview", ""], queryFn: () => readOverview({}), refetchInterval: REFRESH_MS });
  const spaces = all.data?.spaces ?? [];
  const space = params.space ?? (spaces.length === 1 ? spaces[0]!.key : "");
  const wide: { id: Tab; label: string }[] = [
    { id: "board", label: "Board" },
    { id: "map", label: "Map" },
    { id: "live", label: "Live" },
    { id: "tasks", label: "Tasks" },
    { id: "inbox", label: "Inbox" },
    { id: "roadmap", label: "Roadmap" },
    { id: "projects", label: "Projects" },
    { id: "team", label: "People & labels" },
  ];
  const compact: { id: Tab; label: string }[] = [
    { id: "lines", label: "Lines" },
    { id: "board", label: "Board" },
    { id: "features", label: "Features" },
    { id: "map", label: "Map" },
    { id: "live", label: "Live" },
    { id: "tasks", label: "Tasks" },
    { id: "inbox", label: "Inbox" },
    { id: "roadmap", label: "Roadmap" },
    { id: "projects", label: "Projects" },
    { id: "team", label: "People & labels" },
  ];
  // Several spaces and none asked for: all of them. A project to add needs one space: it is picked first.
  const allSpaces = !space && spaces.length > 1 && !params.add;
  const perSpace = new Set<Tab>(["projects", "team"]);
  const tabs = (layout.compact ? compact : wide).filter((t) => !allSpaces || !perSpace.has(t.id));
  const [chosen, setTab] = useState<Tab | undefined>(params.tab as Tab | undefined);
  // Also when the host reuses a mounted screen with new params (Command Center's "Add this project").
  useEffect(() => {
    if (params.tab) setTab(params.tab as Tab);
  }, [params.tab, params.add]);
  // A tab from the params, or kept across a wide/compact switch, counts only if this layout has it.
  const tab: Tab = chosen && tabs.some((t) => t.id === chosen) ? chosen : layout.compact ? "lines" : "board";
  // Command Center's "New task" opens the space with `new: "task"`.
  const [creating, setCreating] = useState<"task" | "feature" | "release" | undefined>();
  // Also when the host reuses a mounted screen with new params.
  useEffect(() => {
    if ((space || allSpaces) && params.new === "task") setCreating("task");
  }, [space, allSpaces, params.new]);
  const stopCreating = () => setCreating(undefined);
  // Command Center's "Import from Laconote" opens the space's inbox with the import sheet; `import`
  // changes on every ask, so a reused screen opens it again.
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if ((space || allSpaces) && params.import) {
      setTab("inbox");
      setImporting(true);
    }
  }, [space, allSpaces, params.import]);
  // The map's filters live here, not in the map, so "‹ Back" to this screen brings them back.
  const [filters, setFilters] = useState<MapFilters>(() => filtersOf(params));
  useEffect(() => setFilters(filtersOf(params)), [params.group, params.empty, params.done]);
  // The words Board, Tasks and Inbox are filtered by: one query for the three, kept in the screen's
  // location so a tab switch and "‹ Back" keep it.
  const [q, setQ] = useState(params.q ?? "");
  useEffect(() => {
    if (params.q !== undefined) setQ(params.q);
  }, [params.q]);
  useArrival("space", params);
  // The inspector (client/peek.ts): what it shows travels in `peek`, so a screen opened from it leads
  // back with it open; a link with `peek` opens it, also on a reused screen.
  const [peek, setPeek] = useState<PeekState>(CLOSED);
  useEffect(() => {
    const asked = decode(params.peek);
    if (asked) setPeek((state) => open(state, asked));
  }, [params.peek]);
  const shown = onView(peek);
  const openPeek = useCallback((entry: Peek) => setPeek((state) => open(state, entry)), []);
  const inspector = useMemo<InspectorContext>(() => ({ open: openPeek, on: shown }), [openPeek, shown]);
  const title = tabs.find((t) => t.id === tab)?.label ?? PLUGIN_NAME;
  const here = useMemo<ScreenLocation>(
    () => ({
      screenId: "space",
      params: { space, tab, group: filters.group, empty: filters.empty ? "" : "off", done: filters.done ? "on" : "", peek: encode(shown), q },
      title,
    }),
    [space, tab, filters, title, shown, q],
  );
  const openScreen = useOpen(space || allSpaces ? here : { screenId: "space", params: {}, title: PLUGIN_NAME });

  if (!space && !allSpaces) {
    // What the caller asked for (a new task, a project to add) goes on with the space picked.
    const { notice: _notice, ...rest } = params;
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {PLUGIN_NAME}
        </Text>
        {params.notice ? <Text style={styles.muted}>{params.notice}</Text> : null}
        {all.isError ? <Text style={styles.error}>{`Could not read ${PLUGIN_NAME}: ${String(all.error)}`}</Text> : null}
        {all.data?.error ? <Text style={styles.error}>{all.data.error}</Text> : null}
        {all.data && spaces.length === 0 && !all.data.error ? <Onboarding styles={styles} theme={theme} /> : null}
        {spaces.map((s) => (
          <ItemRow key={s.key} title={`${s.name} (${s.key})`} note={s.synced} onPress={() => openScreen("space", { ...rest, space: s.key })} theme={theme} styles={styles} />
        ))}
      </ScrollView>
    );
  }

  const current = space ? spaces.find((s) => s.key.toLowerCase() === space.toLowerCase()) : undefined;
  const others = spaces.filter((s) => s !== current);
  const choices = allSpaces ? spaces.map((s) => ({ key: s.key, name: s.name })) : undefined;
  const panel = shown ? (
    <Inspector state={peek} onChange={setPeek} filters={filters} here={here} theme={theme} compact={layout.compact} navigation={navigation} />
  ) : null;
  // What the inspector shows, for the search's recent places.
  const remembered: RecentItem | undefined =
    shown?.kind === "task" && shown.title
      ? { kind: "task", id: shown.task, title: shown.title, space: spaceOfId(shown.task) }
      : shown?.kind === "feature" && shown.title
        ? { kind: "feature", id: shown.feature, title: shown.title, space: spaceOfId(shown.feature) }
        : shown?.kind === "line"
          ? { kind: "line", id: shown.project, title: shown.project, space: shown.space }
          : undefined;
  // "Show all" from the search: this screen's Tasks tab when it is the space searched, else that space's.
  // The Tasks tab is opened afresh, its status, Mine, label and space filters cleared, so it lists
  // what "Show all" counted (until those filters move into the location too: the audit's Phase 4).
  const [tasksKey, setTasksKey] = useState(0);
  const showAll = (target: string, words: string) => {
    if (target === space) {
      setQ(words);
      setTasksKey((k) => k + 1);
      setTab("tasks");
    } else openScreen("space", { ...(target ? { space: target } : {}), tab: "tasks", q: words });
  };
  return (
    <Here value={here}>
      <PeekHere value={inspector}>
        <View style={styles.screen}>
          <View style={[styles.content, { paddingBottom: 0, gap: 10 }]}>
            <TopBar here={here} space={space} theme={theme} styles={styles} compact={layout.compact} focus={params.search} remember={remembered} onShowAll={showAll} back={false} />
            {params.notice ? <Text style={styles.muted}>{params.notice}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, flexShrink: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
                    {allSpaces ? "All spaces" : (current?.name ?? space)}
                  </Text>
                  <Text style={styles.muted}>{current?.key ?? ""}</Text>
                  {!allSpaces && spaces.length > 1 ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="Open all spaces" onPress={() => openScreen("space", {})}>
                      <Text style={[styles.muted, { textDecorationLine: "underline" }]}>All</Text>
                    </Pressable>
                  ) : null}
                  {others.map((o) => (
                    <Pressable key={o.key} accessibilityRole="button" accessibilityLabel={`Open space ${o.name}`} onPress={() => openScreen("space", { space: o.key })}>
                      <Text style={[styles.muted, { textDecorationLine: "underline" }]}>{o.key}</Text>
                    </Pressable>
                  ))}
                </View>
                <LiveStrip space={space} theme={theme} onOpen={setTab} />
              </View>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                <SyncControl space={space} request={params.sync} styles={styles} theme={theme} />
                <Button label="+ Task" onPress={() => setCreating("task")} styles={styles} />
                <Button label="+ Feature" ghost onPress={() => setCreating("feature")} styles={styles} />
                <Button label="+ Release" ghost onPress={() => setCreating("release")} styles={styles} />
              </View>
            </View>
            <Tabs tabs={tabs} value={tab} onChange={setTab} styles={styles} theme={theme} />
          </View>
          {/* Wide: the inspector beside the tab; phones: over the whole screen (the last child, below). */}
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {tab === "roadmap" && allSpaces ? (
                <SpacesRoadmaps spaces={spaces} theme={theme} styles={styles} />
              ) : tab === "map" || tab === "lines" || tab === "features" ? (
                <MapTabs space={space} tab={tab} theme={theme} styles={styles} compact={layout.compact} onProjects={() => setTab("projects")} filters={filters} setFilters={setFilters} navigation={navigation} />
              ) : tab === "board" ? (
                <BoardTab space={space} spaces={choices} theme={theme} styles={styles} compact={layout.compact} onNew={() => setCreating("task")} query={q} onQuery={setQ} />
              ) : tab === "live" ? (
                <LiveTab space={space} spaces={choices} theme={theme} styles={styles} navigation={navigation} />
              ) : tab === "tasks" ? (
                <TasksTab key={tasksKey} space={space} spaces={choices} theme={theme} styles={styles} query={q} onQuery={setQ} />
              ) : tab === "roadmap" ? (
                <RoadmapTab space={space} styles={styles} theme={theme} />
              ) : tab === "projects" ? (
                <ProjectsTab space={space} highlight={params.add} styles={styles} theme={theme} />
              ) : tab === "team" ? (
                <TeamTab space={space} styles={styles} theme={theme} />
              ) : (
                <InboxTab space={space} spaces={choices} theme={theme} styles={styles} onImport={() => setImporting(true)} query={q} onQuery={setQ} />
              )}
            </View>
            {panel && !layout.compact ? <View style={{ width: INSPECTOR_WIDTH, flexShrink: 0 }}>{panel}</View> : null}
          </View>
          {creating === "task" ? <TaskForm space={space} spaces={choices} initial={{}} open onClose={stopCreating} styles={styles} theme={theme} /> : null}
          {creating === "feature" ? <FeatureForm space={space} spaces={choices} open onClose={stopCreating} styles={styles} theme={theme} /> : null}
          {creating === "release" ? <ReleaseForm space={space} spaces={choices} open onClose={stopCreating} styles={styles} theme={theme} /> : null}
          {importing ? <LaconoteImport space={space} spaces={choices} open onClose={() => setImporting(false)} styles={styles} theme={theme} /> : null}
          {panel && layout.compact ? <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>{panel}</View> : null}
        </View>
      </PeekHere>
    </Here>
  );
}

/** The inspector's width beside the map on wide layouts. */
const INSPECTOR_WIDTH = 460;

interface MapFilters {
  group: string;
  empty: boolean;
  done: boolean;
}

function filtersOf(params: PluginScreenProps["params"]): MapFilters {
  return { group: params.group ?? "", empty: params.empty !== "off", done: params.done === "on" };
}

/** One space's map, or with `space` empty every space's as bands. */
function useMap(space: string, done: boolean, group: string, empty: boolean) {
  const read = useRpc(mapRpc);
  return useQuery({
    queryKey: ["dashboard", "map", space, done, group, empty],
    queryFn: () => read({ space: space || undefined, done, group: group || undefined, empty }),
    refetchInterval: REFRESH_MS,
  });
}

function MapTabs({ space, tab, theme, styles, compact, onProjects, filters, setFilters, navigation }: {
  space: string;
  tab: Tab;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  onProjects: () => void;
  filters: MapFilters;
  setFilters: (change: (filters: MapFilters) => MapFilters) => void;
  navigation: PluginScreenProps["navigation"];
}) {
  const openScreen = useOpen();
  const show = useShow();
  const inspector = useInspector();
  const [labels, setLabels] = useState(!compact);
  const { group, empty, done } = filters;
  const setGroup = (value: string) => setFilters((f) => ({ ...f, group: value }));
  const setEmpty = (value: boolean) => setFilters((f) => ({ ...f, empty: value }));
  const setDone = (value: boolean) => setFilters((f) => ({ ...f, done: value }));
  // A line's Paseo workspaces open over the map; they belong to one band's space.
  const [activityFor, setActivityFor] = useState<{ space: string; project: string } | undefined>();
  const query = useMap(space, done, group, empty);
  const map = query.data;
  // All spaces: each space's own map as a band, one under another (04-ux.md, All spaces).
  const banded = !space;
  const maps: MetroMap[] = map ? (banded ? map.bands : [map]) : [];
  const groups = [...new Set(maps.flatMap((m) => m.groups))];
  // A group renamed or emptied elsewhere would leave the map filtered with no chip to clear it.
  useEffect(() => {
    if (map && !map.error && group && !groups.includes(group)) setGroup("");
  }, [map, group]);
  // A failed refresh keeps the last map on screen, with the error above it.
  const failed = query.isError ? <Text style={styles.error}>{`Could not refresh the map: ${String(query.error)}`}</Text> : null;
  if (!map) return failed ? <View style={{ margin: 16 }}>{failed}</View> : <Text style={[styles.muted, { margin: 16 }]}>Loading…</Text>;
  if (map.error) return <Text style={[styles.error, { margin: 16 }]}>{map.error}</Text>;

  // A band whose space has none of the group's lines has nothing to show under that filter.
  const shown = banded && group ? maps.filter((m) => m.lines.length || m.folded.length) : maps;
  const anyStation = maps.some((m) => m.stations.length);
  const band = (m: MetroMap) => {
    const key = m.space.key;
    // A station of one task opens the task; one of several lists them in the inspector.
    const onStation = (stationKey: string, title: string) => {
      const s = m.stations.find((x) => x.key === stationKey);
      if (!s) return;
      if (s.tasks.length === 1) return show.task(s.tasks[0]!.id, { title: s.tasks[0]!.title });
      inspector?.open({ kind: "station", space: key, key: stationKey, project: m.lines[s.row]?.project ?? "", title });
    };
    const noProjects = m.lines.length === 0 && m.folded.length === 0 && !group;
    return (
      <View key={key} style={{ gap: 12 }}>
        {banded ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open space ${m.space.name}`} onPress={() => openScreen("space", { space: key })} style={[styles.row, { paddingTop: 8 }]}>
            <Text accessibilityRole="header" style={styles.heading}>
              {m.space.name}
            </Text>
            <Text style={styles.muted}>{key}</Text>
          </Pressable>
        ) : null}
        {noProjects ? (
          <View style={[styles.card, { gap: 8 }]}>
            <Text style={styles.heading}>No projects yet</Text>
            <Text style={styles.muted}>Each project in Paseo Dash is a line on the map. Add your Paseo projects, or any repository by URL.</Text>
            <Button label="Add projects" onPress={banded ? () => openScreen("space", { space: key, tab: "projects" }) : onProjects} styles={styles} />
          </View>
        ) : null}
        {tab === "map" ? (
          <>
            {m.stations.length === 0 && !noProjects ? <Text style={styles.muted}>No accepted tasks yet: triage the inbox, or create a task.</Text> : null}
            <MetroView
              map={m}
              theme={theme}
              labels={labels}
              onStation={onStation}
              onFeature={(feature) => show.feature(feature)}
              onLine={(project) => show.line(key, project)}
              onActivity={(project) => setActivityFor({ space: key, project })}
            />
            {m.folded.length ? <Text style={styles.muted}>{`${m.folded.join(" · ")}: no tasks in view; turn on Empty lines to draw them`}</Text> : null}
          </>
        ) : tab === "lines" ? (
          <LinesList map={m} space={key} styles={styles} theme={theme} />
        ) : (
          <FeatureCards map={m} styles={styles} />
        )}
        <Depot map={m} theme={theme} styles={styles} />
      </View>
    );
  };
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      {failed}
      {(tab === "map" || tab === "lines") && groups.length ? (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <Chip label="All" active={!group} onPress={() => setGroup("")} styles={styles} />
          {groups.map((g) => (
            <Chip key={g} label={g} active={g === group} onPress={() => setGroup(g === group ? "" : g)} styles={styles} />
          ))}
        </View>
      ) : null}
      {tab === "map" ? (
        <View style={[styles.row, { flexWrap: "wrap", justifyContent: "flex-end" }]}>
          <View style={[styles.row, { gap: 4 }]}>
            <Toggle label="Titles" value={labels} onChange={setLabels} theme={theme} />
            <Toggle label="Empty lines" value={empty} onChange={setEmpty} theme={theme} />
            <Toggle label="Finished releases" value={done} onChange={setDone} theme={theme} />
          </View>
        </View>
      ) : null}
      {banded && shown.length === 0 ? <Text style={styles.muted}>{group ? `No space has lines in ${group}.` : "No space is connected yet."}</Text> : null}
      {shown.map(band)}
      {tab === "map" && anyStation ? <MetroLegend theme={theme} /> : null}
      {activityFor ? (
        <ActivitySheet
          space={activityFor.space}
          project={activityFor.project}
          navigation={navigation}
          theme={theme}
          styles={styles}
          onClose={() => setActivityFor(undefined)}
        />
      ) : null}
    </ScrollView>
  );
}

function LinesList({ map, space, styles, theme }: { map: MetroMap; space: string; styles: Styles; theme: Theme }) {
  const show = useShow();
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>{map.columns.map((c) => c.title).join(" ┆ ")}</Text>
      {map.lines.map((line) => (
        <Pressable key={line.project} accessibilityRole="button" onPress={() => show.line(space, line.project)} style={[styles.row, { paddingVertical: 8 }]}>
          <View style={{ width: 112 }}>
            <LineBadge project={line.project} color={line.color} theme={theme} size="small" />
          </View>
          <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
            {glyphStrip(map, line.row)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function FeatureCards({ map, styles }: { map: MetroMap; styles: Styles }) {
  const show = useShow();
  return (
    <View style={{ gap: 8 }}>
      {map.interchanges.length === 0 ? <Text style={styles.muted}>No features with tasks yet.</Text> : null}
      {map.interchanges.map((ic) => {
        const stations = map.stations.filter((s) => s.column === ic.column && s.feature === ic.feature);
        const all = stations.flatMap((s) => s.tasks);
        return (
          <Pressable key={ic.key} accessibilityRole="button" onPress={() => show.feature(ic.feature, ic.title)} style={styles.card}>
            <Text style={styles.heading}>{ic.title}</Text>
            <Text style={styles.muted}>{`${map.columns[ic.column]?.title} · ${all.filter((t) => t.glyph === "done").length}/${all.length}${ic.branch ? ` · ${ic.branch}` : ""}`}</Text>
            <Text style={styles.text}>{stations.map((s) => `${map.lines[s.row]?.project} ${GLYPH_CHAR[s.glyph]}`).join("  ")}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Drafts waiting for triage, as chips under the map. */
function Depot({ map, theme, styles }: { map: MetroMap; theme: Theme; styles: Styles }) {
  const show = useShow();
  if (!map.depot.length) return null;
  const list = map.depot.map((d) => ({ id: d.id, title: d.title }));
  return (
    <Section title={`Depot · Inbox ${map.depot.length}`} styles={styles}>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {map.depot.slice(0, 12).map((d) => (
          <Chip key={d.id} label={d.title} active={show.shows({ kind: "task", task: d.id })} onPress={() => show.task(d.id, { title: d.title, list })} styles={styles} />
        ))}
        {map.depot.length > 12 ? <Text style={{ color: theme.colors.foregroundMuted }}>{`+${map.depot.length - 12}`}</Text> : null}
      </View>
    </Section>
  );
}

type Choices = { key: string; name: string }[] | undefined;

/** What each kind of "needs you" item asks for, before its reason. */
const NEEDS_LABEL: Record<NeedsKind, string> = {
  permission: "asks permission",
  question: "asks you",
  failed: "agent failed",
  sync: "not pushed",
  answer: "agent waits",
  subagent: "sub-agent open",
  stopped: "agent stopped",
  checkout: "mark done once landed",
  closed: "PR/MR closed",
  merged: "merged, not done",
  accept: "accept or send back",
  qa: "QA card not settled",
  merge: "merge in this order",
  reconcile: "left to you",
};

const NEEDS_GLYPH: Record<NeedsKind, Glyph> = {
  permission: "needs_you",
  question: "needs_you",
  failed: "failed",
  sync: "failed",
  answer: "needs_you",
  subagent: "needs_you",
  // A stopped agent is no failure either: the map draws it `!` too (server/map/read.ts).
  stopped: "needs_you",
  // A tracked trunk checkout's end is no failure: the map's mark for it too.
  checkout: "elsewhere",
  closed: "review",
  merged: "review",
  accept: "review",
  qa: "needs_you",
  merge: "review",
  reconcile: "needs_you",
};

function LiveTab({ space, spaces, theme, styles, navigation }: { space: string; spaces: Choices; theme: Theme; styles: Styles; navigation: PluginScreenProps["navigation"] }) {
  const show = useShow();
  const read = useRpc(overviewRpc);
  // All spaces: one board across them (needs you most urgent first), narrowed to one by the filter.
  const [only, setOnly] = useState("");
  const asked = space || only;
  // The whole lists, not God Mode's excerpts of ten.
  const query = useQuery({ queryKey: ["dashboard", "overview", asked, "board"], queryFn: () => read({ space: asked || undefined, limit: BOARD_LIMIT }), refetchInterval: REFRESH_MS });
  const data = query.data;
  const tag = (task: string) => (spaces ? spaceOfId(task) : undefined);
  // Previous and next in the inspector walk the board: needs you, then working, then review.
  const board = [
    ...(data?.needs_you ?? []).filter((n) => n.task).map((n) => ({ id: n.task, title: n.title })),
    ...(data?.running ?? []).map((r) => ({ id: r.task, title: r.title })),
    ...(data?.review ?? []).map((r) => ({ id: r.task, title: r.title })),
  ];
  const list = board.filter((t, i) => board.findIndex((o) => o.id === t.id) === i);
  const shows = (task: string) => show.shows({ kind: "task", task });
  const openTask = (task: string, title: string) => show.task(task, { title, list });
  const more = (shown: number, total: number | undefined) => (total !== undefined && total > shown ? <Text style={styles.muted}>{`${total - shown} more not shown.`}</Text> : null);
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      {spaces ? <SpaceFilter spaces={spaces} value={only} onChange={setOnly} styles={styles} /> : null}
      {query.isError ? <Text style={styles.error}>{`Could not read: ${String(query.error)}`}</Text> : null}
      {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}
      {/* What waits for the person comes first (04-ux.md, Live). */}
      <Section title={`Needs you · ${data?.counts.needs_you ?? "–"}`} styles={styles}>
        {data?.needs_you.length ? null : <Text style={styles.muted}>Nothing waits for you.</Text>}
        {data?.needs_you.map((n) => (
          <NeedsRow
            key={`${n.kind}:${n.task || n.space}`}
            item={n}
            spaces={Boolean(spaces)}
            active={Boolean(n.task) && shows(n.task)}
            onOpen={n.task ? () => openTask(n.task, n.title) : undefined}
            onOpenCard={openTask}
            navigation={navigation}
            theme={theme}
            styles={styles}
          />
        ))}
        {more(data?.needs_you.length ?? 0, data?.counts.needs_you)}
      </Section>
      <Section title={`Working · ${data?.counts.running ?? "–"}`} styles={styles}>
        {data?.running.map((r) => (
          <View key={r.task} style={styles.row}>
            <View style={{ flex: 1 }}>
              <ItemRow
                glyph={r.activity === "failed" ? "failed" : r.activity === "waiting" && WAITS_FOR_USER.has(r.state) ? "needs_you" : r.activity === "stopped" || !r.chat_id ? "elsewhere" : "working"}
                space={tag(r.task)}
                title={r.title}
                note={[STATE_WORDS[r.state] ?? r.activity, r.host, ago(r.since)].filter(Boolean).join(" · ")}
                active={shows(r.task)}
                onPress={() => openTask(r.task, r.title)}
                theme={theme}
                styles={styles}
              />
            </View>
            {r.chat_id && navigation ? <Button label="Open chat" ghost onPress={() => navigation.openAgent({ agentId: r.chat_id })} styles={styles} /> : null}
          </View>
        ))}
        {more(data?.running.length ?? 0, data?.counts.running)}
      </Section>
      <Section title={`Review · ${data?.counts.review ?? "–"}`} styles={styles}>
        {data?.review.map((r) => (
          <ItemRow
            key={r.task}
            glyph="review"
            space={tag(r.task)}
            title={r.title}
            note={[r.pr, r.since ? `in review ${ago(r.since)}` : ""].filter(Boolean).join(" · ")}
            active={shows(r.task)}
            onPress={() => openTask(r.task, r.title)}
            theme={theme}
            styles={styles}
          />
        ))}
        {more(data?.review.length ?? 0, data?.counts.review)}
      </Section>
      <View style={styles.row}>
        <StartNextButton space={asked} styles={styles} theme={theme} />
      </View>
      <StartCandidatesSection space={asked} styles={styles} theme={theme} />
      <ReadyReviewSection key={asked ?? ""} space={asked} styles={styles} theme={theme} />
      <ManagedQueueSection key={asked ?? ""} space={asked} styles={styles} theme={theme} />
      <AutopilotSection styles={styles} theme={theme} />
      <EventsSection space={asked} spaces={Boolean(spaces)} theme={theme} styles={styles} navigation={navigation} />
      <RecapSection space={asked} spaces={Boolean(spaces)} theme={theme} styles={styles} />
      <Section title="In Paseo, not on the plan" styles={styles}>
        <SpaceActivity space={asked} navigation={navigation} theme={theme} styles={styles} />
      </Section>
    </ScrollView>
  );
}

/** How the Working list names a run's state (shared/overview.ts WAIT_STATES). */
const STATE_WORDS: Record<string, string> = {
  launching: "launching",
  working: "working",
  subagent_working: "a sub-agent at work",
  waiting_for_ci: "waiting for CI",
  waiting_for_review: "waiting for review",
  needs_user_question: "asks you a question",
  approval: "waits for your approval",
  answer: "waits for your reply",
  blocked: "blocked: needs you",
  failed: "failed",
  stopped: "stopped: no agent at work",
  subagent_open: "a sub-agent still open",
  record_lost: "no record of its agent here",
  checkout: "checkout ended",
  elsewhere: "on another machine",
};

/** The states that wait for the user: the rest are at work or wait on CI, a review or a sub-agent. */
const WAITS_FOR_USER = new Set(["needs_user_question", "approval", "answer", "blocked", "failed", "stopped", "subagent_open", "record_lost", "checkout"]);

/** The longest answer tasks.send-back takes. */
const REPLY_MAX = 4000;

/** How many of each list the Live tab shows (the overview answers at most 200). */
const BOARD_LIMIT = 200;

/** How long ago, as a person glances at it: "5m", "3h", "2d"; "" when unknown. */
function ago(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

type NeedsItem = NonNullable<RpcOutput<typeof overviewRpc>["needs_you"]>[number];

/** A stopped run says what became of its chat, once read. */
const CHAT_LABEL = { closed: "chat closed", archived: "chat archived", gone: "agent gone" } as const;
const needLabel = (item: NeedsItem) => (item.kind === "stopped" && item.chat ? CHAT_LABEL[item.chat.state] : NEEDS_LABEL[item.kind]);

/**
 * One thing waiting for the person, with what can be done about it in place: open the agent's chat,
 * and for an agent that finished its turn while the task is in progress, answer it right here.
 */
function NeedsRow({ item, spaces, active, onOpen, onOpenCard, navigation, theme, styles }: {
  item: NeedsItem;
  spaces: boolean;
  active: boolean;
  onOpen?: () => void;
  /** Opens one of the item's cards: a merge list or a group names several. */
  onOpenCard?: (task: string, title: string) => void;
  navigation: PluginScreenProps["navigation"];
  theme: Theme;
  styles: Styles;
}) {
  const send = useRpc(tasksSendBackRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const reply = async () => {
    setBusy(true);
    try {
      const answer = await send({ task: item.task, comment: text, reply: true });
      if (answer.ok) {
        toast.show(`Sent to the agent of ${item.task}`, { variant: "success" });
        setText("");
        setReplying(false);
      } else toast.error(answer.error);
      refresh();
    } catch (failure) {
      toast.error(`Unknown whether it was sent: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          {/* A space's sync failure has no task to open: Settings → Paseo Dash shows it. */}
          <ItemRow
            glyph={NEEDS_GLYPH[item.kind]}
            space={spaces ? item.space : undefined}
            title={item.title}
            note={[needLabel(item), ago(item.since), item.why].filter(Boolean).join(" · ")}
            active={active}
            onPress={onOpen}
            theme={theme}
            styles={styles}
          />
        </View>
        {item.kind === "answer" && item.chat_id ? <Button label="Reply" ghost onPress={() => setReplying(!replying)} styles={styles} /> : null}
        {item.chat_id && navigation ? (
          <Button
            // The row's chat is a sub-agent's when it is not the stopped run's own.
            label={item.chat && item.chat.id !== item.chat_id ? "Open sub-agent" : "Open chat"}
            ghost
            onPress={() => navigation.openAgent({ agentId: item.chat_id })}
            styles={styles}
          />
        ) : null}
      </View>
      {item.chat && navigation ? <ChatLinks chat={item.chat} shown={item.chat_id} navigation={navigation} styles={styles} /> : null}
      {item.cards?.length ? <NeedCards item={item} onOpen={(task, title) => onOpenCard?.(task, title)} theme={theme} styles={styles} /> : null}
      {replying ? (
        <View style={[styles.row, { gap: 6 }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Your answer, sent to the agent as written"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Answer the agent of ${item.title}`}
            multiline
            style={[styles.text, { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
          />
          <Button label={busy ? "Sending…" : "Send"} disabled={busy || !text.trim() || text.length > REPLY_MAX} onPress={() => void reply()} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

/** The chats of a stopped run besides the row's own button: the run's closed or archived one, and every unarchived sub-agent. */
function ChatLinks({ chat, shown, navigation, styles }: { chat: NonNullable<NeedsItem["chat"]>; shown: string; navigation: NonNullable<PluginScreenProps["navigation"]>; styles: Styles }) {
  const subs = chat.sub_agents.filter((sub) => sub.id !== shown);
  const own = chat.state !== "gone" && chat.id !== shown;
  if (!own && !subs.length) return null;
  return (
    <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
      {own ? <Button label={`Open the run's ${chat.state} chat`} ghost onPress={() => navigation.openAgent({ agentId: chat.id })} styles={styles} /> : null}
      {subs.map((sub) => (
        <Button key={sub.id} label={`Open sub-agent ${sub.id.slice(0, 8)} (${sub.state.replace("_", " ")})`} ghost onPress={() => navigation.openAgent({ agentId: sub.id })} styles={styles} />
      ))}
    </View>
  );
}

function TasksTab({ space, spaces, theme, styles, query, onQuery }: { space: string; spaces: Choices; theme: Theme; styles: Styles; query: string; onQuery: (query: string) => void }) {
  const show = useShow();
  // Unpicked: the server's default, open tasks, or every status while searching.
  const [status, setStatus] = useState<(typeof TASK_FILTERS)[number] | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const [label, setLabel] = useState("");
  const [only, setOnly] = useState("");
  const asked = space || only;
  const keys = spaces?.map((s) => s.key) ?? [];
  const own = useSpaceOptions(space).data?.labels;
  const every = useOptionsOf(keys).of;
  // A row's labels in its own space's colors.
  const paletteOf = (id: string) => (space ? own : every.get(spaceOfId(id))?.labels);
  const [words, setWords] = useState(query.trim());
  // Ask once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => setWords(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  // What the server applies when no chip is picked: a query with a letter or digit searches every
  // status (parseQuery, server/search/core.ts). Tapping the picked chip again unpicks it.
  const shownStatus = status ?? (/[\p{L}\p{N}]/u.test(words) ? "all" : "open");
  const read = useRpc(tasksListRpc);
  // A page at a time, in the server's order (sortTasks); "Show more" asks for the next one.
  const list = useInfiniteQuery({
    queryKey: ["dashboard", "tasks", asked, status, words, mine, label],
    queryFn: ({ pageParam }) =>
      read({ space: asked || undefined, status, query: words || undefined, mine: mine || undefined, label: label || undefined, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const seen = pages.reduce((n, page) => n + page.tasks.length, 0);
      return last.tasks.length === PAGE && seen < last.total ? seen : undefined;
    },
    refetchInterval: REFRESH_MS,
  });
  const pages = list.data?.pages ?? [];
  const tasks = pages.flatMap((page) => page.tasks).filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i);
  const total = pages[0]?.total ?? 0;
  const error = pages.find((page) => page.error)?.error;
  const listed = tasks.map((t) => ({ id: t.id, title: t.title }));
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      <View style={styles.row}>
        <StartNextButton space={asked} styles={styles} theme={theme} />
      </View>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {TASK_FILTERS.map((f) => (
          <Chip key={f} label={f.replace("_", " ")} active={f === shownStatus} onPress={() => setStatus(f === status ? undefined : f)} styles={styles} />
        ))}
      </View>
      {spaces ? <SpaceFilter spaces={spaces} value={only} onChange={setOnly} styles={styles} /> : null}
      <TaskFilters space={asked} spaces={keys} mine={mine} onMine={setMine} label={label} onLabel={setLabel} styles={styles} />
      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="Filter the list: words, an id, a label, a PR link or branch"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Search tasks"
        style={[styles.text, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
      />
      {list.isError ? <Text style={styles.error}>{`Could not read: ${String(list.error)}`}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.muted}>{list.data ? `${tasks.length} of ${total}` : "Loading…"}</Text>
      {pages[0]?.searched_for ? <Text style={styles.muted}>{`Nothing matched as typed; showing «${pages[0].searched_for}», the other keyboard layout.`}</Text> : null}
      {pages[0]?.partial ? <Text style={styles.muted}>No task has every word; these have some of them.</Text> : null}
      {tasks.map((t, i) => (
        <View key={t.id} style={{ gap: 4 }}>
          {/* A search lists title matches first, so a section may show again further down. */}
          {t.section !== tasks[i - 1]?.section ? <Text accessibilityRole="header" style={[styles.heading, { marginTop: i ? 8 : 0 }]}>{SECTION_TITLE[t.section] ?? t.section}</Text> : null}
          <View style={[styles.row, { alignItems: "center" }]}>
          <View style={{ flex: 1 }}>
          <ItemRow
            glyph={t.glyph}
            space={spaces ? spaceOfId(t.id) : undefined}
            title={t.title}
            note={[t.id, t.priority, t.release, t.project, t.assignee, t.activity, t.section === "blocked" && t.blocked_by ? `⊘ waits for ${t.blocked_by}` : ""].filter(Boolean).join(" · ")}
            quote={t.matched_in && t.matched_in !== "title" && t.matched_in !== "id" ? `${t.matched_in.replace("_", " ")}: «${t.quote}»` : undefined}
            labels={withColors(t.labels ?? [], paletteOf(t.id))}
            active={show.shows({ kind: "task", task: t.id })}
            onPress={() => show.task(t.id, { title: t.title, list: listed })}
            theme={theme}
            styles={styles}
          />
          </View>
          {/* A move is among all tasks of the priority: offered only while the list shows them all, in their order. */}
          {RANKED.has(t.section) && !words && !mine && !label ? <RankButtons task={t.id} styles={styles} compact /> : null}
          </View>
        </View>
      ))}
      {list.hasNextPage ? (
        <Button label={list.isFetchingNextPage ? "Loading…" : `Show more (${total - tasks.length} left)`} ghost disabled={list.isFetchingNextPage} onPress={() => void list.fetchNextPage()} styles={styles} />
      ) : null}
    </ScrollView>
  );
}

/** Sections whose tasks a person orders by hand (D21). */
const RANKED = new Set(["ready", "blocked", "draft"]);

/** Tasks per page of the Tasks tab (the server answers at most 50). */
const PAGE = 50;

/** The sections of a task list (server/api/view.ts, TASK_SECTIONS) as the Tasks tab heads them. */
const SECTION_TITLE: Record<string, string> = {
  running: "Running",
  review: "Review",
  ready: "Ready to start",
  blocked: "Blocked",
  draft: "Drafts",
  done: "Done",
  canceled: "Canceled",
};

/** Drafts to triage (04-ux.md, Triage the inbox): accept with a project, merge into a task, reject. */
function InboxTab({ space, spaces, theme, styles, onImport, query, onQuery }: { space: string; spaces: Choices; theme: Theme; styles: Styles; onImport: () => void; query: string; onQuery: (query: string) => void }) {
  const show = useShow();
  const read = useRpc(inboxListRpc);
  const [mine, setMine] = useState(false);
  const [label, setLabel] = useState("");
  const [only, setOnly] = useState("");
  const asked = space || only;
  const keys = spaces?.map((s) => s.key) ?? [];
  const own = useSpaceOptions(space).data?.labels;
  const every = useOptionsOf(keys).of;
  const paletteOf = (id: string) => (space ? own : every.get(spaceOfId(id))?.labels);
  const [words, setWords] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setWords(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useQuery({
    queryKey: ["dashboard", "inbox", asked, mine, label, words],
    queryFn: () => read({ space: asked || undefined, mine: mine || undefined, label: label || undefined, query: words || undefined, limit: 50 }),
    refetchInterval: REFRESH_MS,
  });
  const filtered = mine || Boolean(label) || Boolean(only) || /[\p{L}\p{N}]/u.test(words);
  const [dialog, setDialog] = useState<{ kind: "accept" | "merge" | "reject"; id: string; title: string } | undefined>();
  const close = () => setDialog(undefined);
  const [issues, setIssues] = useState(false);
  const drafts = (list.data?.items ?? []).map((item) => ({ id: item.id, title: item.title }));
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button label="Import from Laconote…" ghost onPress={onImport} styles={styles} />
        <Button label="Import from GitHub/GitLab…" ghost onPress={() => setIssues(true)} styles={styles} />
      </View>
      {issues ? <IssueImport space={space} spaces={spaces ?? []} open onClose={() => setIssues(false)} styles={styles} theme={theme} /> : null}
      {spaces ? <SpaceFilter spaces={spaces} value={only} onChange={setOnly} styles={styles} /> : null}
      <TaskFilters space={asked} spaces={keys} mine={mine} onMine={setMine} label={label} onLabel={setLabel} styles={styles} />
      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="Filter the drafts: words or an id"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Filter the drafts"
        style={[styles.text, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
      />
      {list.data?.error ? <Text style={styles.error}>{list.data.error}</Text> : null}
      {list.data?.searched_for ? <Text style={styles.muted}>{`Nothing matched as typed; showing «${list.data.searched_for}», the other keyboard layout.`}</Text> : null}
      {list.data?.partial ? <Text style={styles.muted}>No draft has every word; these have some of them.</Text> : null}
      {list.data && list.data.total === 0 && !list.data.error ? <Text style={styles.muted}>{filtered ? "No drafts match these filters." : "The inbox is empty."}</Text> : null}
      {list.data && list.data.total > list.data.items.length ? <Text style={styles.muted}>{`Showing ${list.data.items.length} of ${list.data.total}.`}</Text> : null}
      {list.data?.items.map((item) => (
        <View key={item.id} style={[styles.card, show.shows({ kind: "task", task: item.id }) ? styles.chipActive : null]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open draft ${item.title}`} onPress={() => show.task(item.id, { title: item.title, list: drafts })} style={{ gap: 4 }}>
            <View style={styles.row}>
              <Mark glyph="todo" theme={theme} />
              {spaces ? <SpaceTag space={spaceOfId(item.id)} theme={theme} /> : null}
              <Text style={[styles.text, { flex: 1 }]}>{item.title}</Text>
            </View>
            <Text style={styles.muted}>{[item.id, item.project || "no project yet", item.assignee, item.meeting_title].filter(Boolean).join(" · ")}</Text>
            <LabelChips labels={withColors(item.labels, paletteOf(item.id))} theme={theme} small />
          </Pressable>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <Button label="Accept…" onPress={() => setDialog({ kind: "accept", ...item })} styles={styles} />
            <Button label="Merge into…" ghost onPress={() => setDialog({ kind: "merge", ...item })} styles={styles} />
            <Button label="Reject…" ghost onPress={() => setDialog({ kind: "reject", ...item })} styles={styles} />
          </View>
        </View>
      ))}
      {dialog?.kind === "accept" ? <TaskFormFor task={dialog.id} accept onClose={close} styles={styles} theme={theme} /> : null}
      {/* A draft merges into a task of its own space. */}
      {dialog?.kind === "merge" ? <MergeDialog space={space || spaceOfId(dialog.id)} task={dialog.id} title={dialog.title} open onClose={close} styles={styles} theme={theme} /> : null}
      {dialog?.kind === "reject" ? (
        <StatusDialog task={dialog.id} title={dialog.title} to="canceled" label="Reject draft" note="The draft is canceled; its file stays in the plan." open onClose={close} styles={styles} />
      ) : null}
      <Button label="Refresh" ghost onPress={() => void list.refetch()} styles={styles} />
    </ScrollView>
  );
}

/** All spaces: each repository has its own ROADMAP.md, so the tab lists the spaces, each opening its own. */
function SpacesRoadmaps({ spaces, theme, styles }: { spaces: { key: string; name: string }[]; theme: Theme; styles: Styles }) {
  const openScreen = useOpen();
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      <Text style={styles.muted}>Each space keeps its own roadmap in its plan repository.</Text>
      {spaces.map((s) => (
        <ItemRow key={s.key} space={s.key} title={s.name} note="ROADMAP.md" onPress={() => openScreen("space", { space: s.key, tab: "roadmap" })} theme={theme} styles={styles} />
      ))}
    </ScrollView>
  );
}

/**
 * The space's ROADMAP.md as the plan repository carries it (04-ux.md, For people without Paseo), in
 * the host's Markdown, which renders its Mermaid diagrams. The file's diagram colors are for GitHub's
 * light page; on a dark theme the same states are shown with dark fills, here only, not in the file.
 */
function RoadmapTab({ space, styles, theme }: { space: string; styles: Styles; theme: Theme }) {
  const read = useRpc(uiRoadmapRpc);
  const roadmap = useQuery({ queryKey: ["dashboard", "roadmap", space], queryFn: () => read({ space }), refetchInterval: REFRESH_MS });
  const dark = isDark(theme.colors.surface0);
  const text = useMemo(() => (roadmap.data?.text ? forTheme(roadmap.data.text.replace(/^<!--[^\n]*-->\n+/, ""), dark) : ""), [roadmap.data?.text, dark]);
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      {roadmap.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {roadmap.isError ? <Text style={styles.error}>{`Could not read the roadmap: ${String(roadmap.error)}`}</Text> : null}
      {roadmap.data?.error ? <Text style={styles.error}>{roadmap.data.error}</Text> : null}
      {text ? <Markdown>{text}</Markdown> : null}
    </ScrollView>
  );
}
