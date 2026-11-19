import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { featureViewRpc, taskViewRpc } from "../shared/views.ts";
import { mapRpc } from "../shared/map.ts";
import { ItemRow, REFRESH_MS, type Styles, useStyles } from "./common.tsx";
import { FeatureDetail } from "./feature.tsx";
import type { ScreenLocation } from "./history.ts";
import { LineDetail } from "./line.tsx";
import { openScreen, useShow } from "./nav.ts";
import { canStep, CLOSED, current, type Peek, peekKey, type PeekState, position, sibling, step } from "./peek.ts";
import { TaskDetail } from "./task.tsx";
import { onPageKey, onView } from "./web.ts";

/**
 * The inspector (04-ux.md, The inspector): a task, a station's tasks, a feature or a line, beside the
 * space screen's map and lists on wide layouts and over them on phones, with its own back and
 * forward, previous and next in the list a task came from, "Page" for the full screen, and close.
 * On the web and desktop apps, Escape closes it, ↑/↓ (or k/j) step through the list and Alt+←/→ go
 * back and forward, while the panel is what the person sees: the host keeps a space screen mounted
 * under the screens pushed over it, and a hidden panel must not step (and mark tasks seen) on keys
 * meant for the screen on view.
 */

type Theme = PluginScreenProps["theme"];

/** The space screen's map filters, which a station's key depends on (finished releases folded or not). */
export interface StationFilters {
  done: boolean;
  group: string;
  empty: boolean;
}

export function Inspector({ state, onChange, filters, here, theme, compact, navigation }: {
  state: PeekState;
  onChange: (state: PeekState) => void;
  filters: StationFilters;
  /** The space screen with this entry open: a screen opened from the inspector leads back to it. */
  here: ScreenLocation;
  theme: Theme;
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
}) {
  const styles = useStyles(theme, true);
  const on = current(state);
  const at = position(state);
  const root = useRef<View>(null);
  // The handler reads the latest state through a ref, so the listener is added once.
  const latest = useRef({ state, onChange });
  latest.current = { state, onChange };
  useEffect(
    () =>
      onPageKey(({ key, alt }) => {
        if (!onView(root.current)) return false;
        const { state: s, onChange: change } = latest.current;
        if (!current(s)) return false;
        if (key === "Escape" && !alt) return change(CLOSED), true;
        if (alt && (key === "ArrowLeft" || key === "ArrowRight")) {
          const delta = key === "ArrowLeft" ? -1 : 1;
          return canStep(s, delta) ? (change(step(s, delta)), true) : false;
        }
        if (alt || !position(s)) return false;
        const delta = key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : 0;
        if (!delta) return false;
        change(sibling(s, delta));
        return true;
      }),
    [],
  );
  const back = canStep(state, -1) ? state.entries[state.at - 1] : undefined;
  // An entry from a link carries no title: the back label reads it.
  const backTitle = useEntryTitle(back);
  if (!on) return null;
  const page = pageOf(on);
  return (
    <View ref={root} style={[styles.screen, compact ? null : { borderLeftWidth: 1, borderLeftColor: theme.colors.border }]}>
      <View style={[styles.row, { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }]}>
        <IconButton label="‹" accessibilityLabel={back ? `Back to ${backTitle}` : "Back"} disabled={!back} onPress={() => onChange(step(state, -1))} theme={theme} />
        <IconButton label="›" accessibilityLabel="Forward" disabled={!canStep(state, 1)} onPress={() => onChange(step(state, 1))} theme={theme} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {back ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${backTitle}`} onPress={() => onChange(step(state, -1))}>
              <Text numberOfLines={1} style={styles.muted}>
                {backTitle}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {at ? (
          <>
            <IconButton label="↑" accessibilityLabel="Previous task" disabled={at.index === 0} onPress={() => onChange(sibling(state, -1))} theme={theme} />
            <Text style={styles.muted}>{`${at.index + 1}/${at.count}`}</Text>
            <IconButton label="↓" accessibilityLabel="Next task" disabled={at.index === at.count - 1} onPress={() => onChange(sibling(state, 1))} theme={theme} />
          </>
        ) : null}
        <IconButton label="⤢" accessibilityLabel="Open as a page" onPress={() => openScreen(page.screenId, page.params, here)} theme={theme} />
        <IconButton label="✕" accessibilityLabel="Close the inspector" onPress={() => onChange(CLOSED)} theme={theme} />
      </View>
      <View key={peekKey(on)} style={{ flex: 1 }}>
        {on.kind === "task" ? (
          <TaskDetail id={on.task} theme={theme} compact navigation={navigation} here={here} />
        ) : on.kind === "feature" ? (
          <FeatureDetail id={on.feature} theme={theme} compact here={here} />
        ) : on.kind === "line" ? (
          <LineDetail space={on.space} project={on.project} theme={theme} compact navigation={navigation} here={here} />
        ) : (
          <StationTasks peek={on} filters={filters} theme={theme} styles={styles} />
        )}
      </View>
    </View>
  );
}

/** The screen an entry opens as with "Page". */
function pageOf(peek: Peek): { screenId: "task" | "feature" | "line"; params: Record<string, string> } {
  switch (peek.kind) {
    case "task":
      return { screenId: "task", params: { task: peek.task } };
    case "feature":
      return { screenId: "feature", params: { feature: peek.feature } };
    case "line":
      return { screenId: "line", params: { space: peek.space, project: peek.project } };
    case "station":
      // A station has no screen of its own: its line's.
      return { screenId: "line", params: { space: peek.space, project: peek.project } };
  }
}

function labelOf(peek: Peek): string {
  switch (peek.kind) {
    case "task":
      return peek.title || peek.task;
    case "station":
      return peek.title;
    case "feature":
      return peek.title || peek.feature;
    case "line":
      return peek.project;
  }
}

function IconButton({ label, accessibilityLabel, onPress, disabled, theme }: { label: string; accessibilityLabel: string; onPress: () => void; disabled?: boolean; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={{ minWidth: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6, opacity: disabled ? 0.35 : 1 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 17, lineHeight: 20 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A station's tasks, read from the space's map under the space screen's filters (the same map query
 * as the space screen's when one space is on view). Each opens with the station as its list.
 */
function StationTasks({ peek, filters, theme, styles }: { peek: Extract<Peek, { kind: "station" }>; filters: StationFilters; theme: Theme; styles: Styles }) {
  const read = useRpc(mapRpc);
  const { done, group, empty } = filters;
  const query = useQuery({
    queryKey: ["dashboard", "map", peek.space, done, group, empty],
    queryFn: () => read({ space: peek.space, done, group: group || undefined, empty }),
    refetchInterval: REFRESH_MS,
  });
  const show = useShow();
  const map = query.data;
  // In all spaces the map's keys carry the space (`TST/later:-:core`); the space's own map's do not.
  const station = map?.stations.find((s) => s.key === peek.key || `${peek.space}/${s.key}` === peek.key);
  const project = station ? (map?.lines[station.row]?.project ?? peek.project) : peek.project;
  const column = station ? map?.columns[station.column] : undefined;
  const feature = station?.feature ? map?.interchanges.find((i) => i.feature === station.feature && i.column === station.column) : undefined;
  const list = station?.tasks.map((t) => ({ id: t.id, title: t.title })) ?? [];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        {station ? `${project} · ${station.tasks.length === 1 ? "1 task" : `${station.tasks.length} tasks`}` : peek.title}
      </Text>
      {station ? <Text style={styles.muted}>{[column?.title, feature?.title].filter(Boolean).join(" · ")}</Text> : null}
      {query.isError ? <Text style={styles.error}>{`Could not read the map: ${String(query.error)}`}</Text> : null}
      {map?.error ? <Text style={styles.error}>{map.error}</Text> : null}
      {map && !map.error && !station ? <Text style={styles.muted}>This station is no longer on the map under these filters.</Text> : null}
      {feature ? <ItemRow title={`Feature: ${feature.title}`} note={feature.branch || undefined} onPress={() => show.feature(feature.feature, feature.title)} theme={theme} styles={styles} /> : null}
      {station?.tasks.map((t) => (
        <ItemRow key={t.id} glyph={t.glyph} title={t.title} note={`${t.id} · ${t.status}`} labels={t.labels} onPress={() => show.task(t.id, { title: t.title, list })} theme={theme} styles={styles} />
      ))}
    </ScrollView>
  );
}

/** An entry's title for the back label: a task's or a feature's as the daemon has it, else what it was opened with. */
function useEntryTitle(peek: Peek | undefined): string {
  const readTask = useRpc(taskViewRpc);
  const readFeature = useRpc(featureViewRpc);
  const task = peek?.kind === "task" ? peek.task : "";
  const feature = peek?.kind === "feature" ? peek.feature : "";
  const t = useQuery({ queryKey: ["dashboard", "task", task], queryFn: () => readTask({ task }), refetchInterval: REFRESH_MS, enabled: Boolean(task) }).data;
  const f = useQuery({ queryKey: ["dashboard", "feature", feature], queryFn: () => readFeature({ feature }), refetchInterval: REFRESH_MS, enabled: Boolean(feature) }).data;
  if (t?.found) return t.title;
  if (f?.found) return f.title;
  return peek ? labelOf(peek) : "";
}
