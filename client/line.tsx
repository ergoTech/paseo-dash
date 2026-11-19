import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { mapRpc } from "../shared/map.ts";
import { useChanges } from "./changes.ts";
import { Button, ItemRow, REFRESH_MS, Section, useStyles } from "./common.tsx";
import { TaskForm } from "./forms.tsx";
import { GLYPH_CHAR } from "./glyphs.ts";
import { LineActivity } from "./activity.tsx";
import { TopBar } from "./topbar.tsx";
import type { ScreenLocation } from "./history.ts";
import { useArrival, useShow } from "./nav.ts";
import { AutopilotToggle } from "./queue.tsx";

/**
 * One repo's route (04-ux.md, The line view and the phone): release sections top to bottom, each
 * station with its tasks, and the feature's other repos as a strip of marks ("transfers").
 */
export function LineScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  useChanges();
  const space = params.space ?? "";
  const project = params.project ?? "";
  useArrival("line", params);
  const here: ScreenLocation = { screenId: "line", params: { space, project }, title: project };
  const parent: ScreenLocation | undefined = space
    ? { screenId: "space", params: { space, tab: layout.compact ? "lines" : "map" }, title: layout.compact ? "Lines" : "Map" }
    : undefined;
  const styles = useStyles(theme, layout.compact);
  const header = (
    <TopBar
      here={here}
      fallback={parent}
      space={space}
      theme={theme}
      styles={styles}
      compact={layout.compact}
      needs
      remember={space && project ? { kind: "line", id: project, title: project, space } : undefined}
    />
  );
  return <LineDetail space={space} project={project} theme={theme} compact={layout.compact} navigation={navigation} here={here} header={header} />;
}

/** The line screen's content, also shown by the space screen's inspector. */
export function LineDetail({ space, project, theme, compact, navigation, here, header }: {
  space: string;
  project: string;
  theme: PluginScreenProps["theme"];
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
  /** Where screens opened from here lead back to: the line screen; in the inspector, the space screen. */
  here?: ScreenLocation;
  /** Above the line: the screen's top bar ("‹ Back" and the search). */
  header?: ReactNode;
}) {
  const styles = useStyles(theme, compact);
  const read = useRpc(mapRpc);
  const query = useQuery({ queryKey: ["dashboard", "map", space, false], queryFn: () => read({ space }), refetchInterval: REFRESH_MS, enabled: Boolean(space) });
  const map = query.data;
  const row = map?.lines.find((l) => l.project === project)?.row;
  const [creating, setCreating] = useState(false);
  const show = useShow(here);
  // Previous and next walk the line's tasks from the first release to the last.
  const list =
    map && row !== undefined
      ? map.columns.flatMap((_, index) => map.stations.filter((s) => s.row === row && s.column === index).flatMap((s) => s.tasks.map((t) => ({ id: t.id, title: t.title }))))
      : [];
  return (
    // "handled": with a phone's keyboard up, a tap on a search result opens it rather than only closing the keyboard.
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {header}
      <Text accessibilityRole="header" style={styles.title}>{`${project} · ${map?.space.name ?? space}`}</Text>
      {space && project ? <Button label={`New task in ${project}`} ghost onPress={() => setCreating(true)} styles={styles} /> : null}
      {space && project ? <AutopilotToggle space={space} project={project} styles={styles} theme={theme} /> : null}
      {creating ? <TaskForm space={space} initial={{ project }} open onClose={() => setCreating(false)} styles={styles} theme={theme} /> : null}
      {query.isError ? <Text style={styles.error}>{`Could not read the map: ${String(query.error)}`}</Text> : null}
      {map?.error ? <Text style={styles.error}>{map.error}</Text> : null}
      {map && row === undefined ? <Text style={styles.muted}>{`${project} has no stations in this space.`}</Text> : null}
      {map && row !== undefined && map.lines[row]?.empty ? <Text style={styles.muted}>{`No tasks on ${project} yet.`}</Text> : null}
      {map && row !== undefined
        ? map.columns.map((column, index) => {
            const stations = map.stations.filter((s) => s.row === row && s.column === index);
            if (!stations.length) return null;
            return (
              <Section key={column.id} title={`┃ ${column.title}${column.days_left === null ? "" : column.days_left < 0 ? ` · ${-column.days_left} days late` : ` · ${column.days_left} days`}`} styles={styles}>
                {stations.map((s) => {
                  const interchange = map.interchanges.find((i) => i.column === index && i.feature === s.feature);
                  const transfers = map.stations
                    .filter((o) => o.column === index && o.feature && o.feature === s.feature && o.row !== row)
                    .map((o) => `${map.lines[o.row]?.project}${GLYPH_CHAR[o.glyph]}`)
                    .join(" ");
                  return (
                    <View key={s.key} style={{ gap: 2 }}>
                      {interchange ? <Text style={styles.muted}>{`${interchange.title}${transfers ? ` · ${transfers}` : ""}`}</Text> : null}
                      {s.tasks.map((t) => (
                        <ItemRow key={t.id} glyph={t.glyph} title={t.title} note={`${t.id} · ${t.status}`} labels={t.labels} onPress={() => show.task(t.id, { title: t.title, list })} theme={theme} styles={styles} />
                      ))}
                    </View>
                  );
                })}
              </Section>
            );
          })
        : null}
      {space && project ? (
        <Section title="In Paseo, not on the plan" styles={styles}>
          <LineActivity space={space} project={project} navigation={navigation} theme={theme} styles={styles} />
        </Section>
      ) : null}
    </ScrollView>
  );
}
