import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { StartReadyButton } from "./queue.tsx";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { featureViewRpc } from "../shared/views.ts";
import { useChanges } from "./changes.ts";
import { Button, ItemRow, REFRESH_MS, Section, useStyles } from "./common.tsx";
import { TaskForm } from "./forms.tsx";
import { TopBar } from "./topbar.tsx";
import type { ScreenLocation } from "./history.ts";
import { useArrival, useShow } from "./nav.ts";

/**
 * An interchange (04-ux.md, The feature view): the feature's tasks in dependency phases. Wide layouts
 * put phases side by side, phones one under another; each task says what it waits for.
 */
export function FeatureScreen({ theme, layout, params }: PluginScreenProps) {
  useChanges();
  const id = params.feature ?? "";
  useArrival("feature", params);
  // The same query FeatureDetail reads (one cache entry): the title for "‹ Back" and the parent.
  const read = useRpc(featureViewRpc);
  const f = useQuery({ queryKey: ["dashboard", "feature", id], queryFn: () => read({ feature: id }), refetchInterval: REFRESH_MS, enabled: Boolean(id) }).data;
  const here: ScreenLocation = { screenId: "feature", params: { feature: id }, title: f?.title || id };
  const parent: ScreenLocation | undefined = f?.space
    ? { screenId: "space", params: { space: f.space, tab: layout.compact ? "features" : "map" }, title: layout.compact ? "Features" : "Map" }
    : undefined;
  const styles = useStyles(theme, layout.compact);
  const header = (
    <TopBar
      here={here}
      fallback={parent}
      space={f?.space ?? ""}
      theme={theme}
      styles={styles}
      compact={layout.compact}
      needs
      remember={f?.found ? { kind: "feature", id: f.id, title: f.title, space: f.space } : undefined}
    />
  );
  return <FeatureDetail id={id} theme={theme} compact={layout.compact} here={here} header={header} />;
}

/** The feature screen's content, also shown by the space screen's inspector (phases one under another). */
export function FeatureDetail({ id, theme, compact, here, header }: {
  id: string;
  theme: PluginScreenProps["theme"];
  compact: boolean;
  /** Where screens opened from here lead back to: the feature screen; in the inspector, the space screen. */
  here?: ScreenLocation;
  /** Above the feature: the screen's top bar ("‹ Back" and the search). */
  header?: ReactNode;
}) {
  const styles = useStyles(theme, compact);
  const read = useRpc(featureViewRpc);
  const query = useQuery({ queryKey: ["dashboard", "feature", id], queryFn: () => read({ feature: id }), refetchInterval: REFRESH_MS, enabled: Boolean(id) });
  const f = query.data;
  // "+ task" prefills the feature, and the project when it is one the feature plans for.
  const [creating, setCreating] = useState<{ project: string } | undefined>();
  const show = useShow(here);
  // Previous and next walk the feature's tasks in phase order.
  const list = f?.found ? f.phases.flat().map((t) => ({ id: t.id, title: t.title })) : [];
  return (
    // "handled": with a phone's keyboard up, a tap on a search result opens it rather than only closing the keyboard.
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {header}
      {query.isError ? <Text style={styles.error}>{`Could not read the feature: ${String(query.error)}`}</Text> : null}
      {f?.error ? <Text style={styles.error}>{f.error}</Text> : null}
      {f?.found ? (
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {f.title}
          </Text>
          <Text style={styles.muted}>{[f.milestone || "Later", f.branch, `${f.done}/${f.total}`, f.status].filter(Boolean).join(" · ")}</Text>
          <StartReadyButton
            feature={f.id}
            ready={f.phases.flat().filter((t) => t.status === "todo" && t.glyph === "todo" && !t.human).map((t) => ({ id: t.id, title: t.title }))}
            left={f.phases.flat().filter((t) => t.status === "todo" && t.glyph === "todo" && t.human).map((t) => ({ id: t.id, reason: t.human }))}
            styles={styles}
          />
          <View style={{ flexDirection: compact ? "column" : "row", gap: 16, alignItems: compact ? undefined : "flex-start" }}>
            {f.phases.map((phase, index) => (
              <View key={index} style={{ flex: compact ? undefined : 1, minWidth: 200 }}>
                <Section title={index === 0 ? "Phase 1" : `Phase ${index + 1} (after phase ${index})`} styles={styles}>
                  {phase.map((t) => (
                    <ItemRow
                      key={t.id}
                      glyph={t.glyph}
                      title={`${t.project} · ${t.title}`}
                      note={[t.status, t.note].filter(Boolean).join(" · ")}
                      onPress={() => show.task(t.id, { title: t.title, list })}
                      theme={theme}
                      styles={styles}
                    />
                  ))}
                </Section>
              </View>
            ))}
          </View>
          {f.missing.length ? <Text style={styles.muted}>{`Planned without a task yet: ${f.missing.join(", ")}`}</Text> : null}
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {f.missing.map((project) => (
              <Button key={project} label={`+ task for ${project}`} ghost onPress={() => setCreating({ project })} styles={styles} />
            ))}
            <Button label="+ task" ghost onPress={() => setCreating({ project: "" })} styles={styles} />
          </View>
          {creating ? <TaskForm space={f.space} initial={{ feature: f.id, project: creating.project }} open onClose={() => setCreating(undefined)} styles={styles} theme={theme} /> : null}
        </>
      ) : null}
    </ScrollView>
  );
}
