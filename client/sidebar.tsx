import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useStyles } from "./common.tsx";
import { SearchPanel, type SearchOpener } from "./search.tsx";
import { helloRpc, overviewRpc } from "../shared/overview.ts";
import { uiPrefsRpc } from "../shared/ui.ts";
import { useChanges } from "./changes.ts";
import { REFRESH_MS } from "./common.tsx";
import { useEventToasts } from "./events.tsx";
import { PLUGIN_NAME } from "../shared/edition.ts";

/** Something waits for the person: the row opens on Live, where it is listed first. */
const live = (count: number): Record<string, string> => (count ? { tab: "live" } : {});

/**
 * The sidebar group (04-ux.md, Surfaces): with one space, one row for it; with several, one
 * plugin-named row ("Paseo Dash") for all of them with the total needs-you count, and a row per
 * space only when Settings → Paseo Dash turns them on.
 */
export function DashboardSidebarItem({ currentScreen, openScreen, openPopover, theme }: PluginSidebarItemProps) {
  useChanges();
  const hello = useRpc(helloRpc);
  // One cheap call per connection: it hands the daemon side its Paseo client early.
  useQuery({ queryKey: ["dashboard", "hello"], queryFn: () => hello({}), staleTime: Infinity });
  const read = useRpc(overviewRpc);
  const all = useQuery({ queryKey: ["dashboard", "overview", ""], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  // While the sidebar is mounted, each new task event is a toast (client/events.tsx).
  useEventToasts(all.data?.events_latest, all.dataUpdatedAt);
  const readPrefs = useRpc(uiPrefsRpc);
  const prefs = useQuery({ queryKey: ["dashboard", "prefs"], queryFn: () => readPrefs({}), refetchInterval: REFRESH_MS });
  const spaces = all.data?.spaces ?? [];
  // Each space's own count: `needs_you` is only an excerpt of all of them.
  const needs = (key: string) => spaces.find((s) => s.key === key)?.needs_you ?? 0;
  const onScreen = currentScreen && ["space", "line", "feature", "task"].includes(currentScreen.screenId);
  const badge = (count: number) => (count ? <Text style={{ color: theme.colors.statusDanger, fontWeight: "700" }}>{`! ${count}`}</Text> : undefined);
  // The search from any Paseo screen: a popover beside the row, a bottom sheet on a phone.
  const search = (
    <Pressable accessibilityRole="button" accessibilityLabel={`Search ${PLUGIN_NAME}`} hitSlop={6} onPress={() => openPopover(SearchPopover)}>
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
  const trailing = (count: number) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {badge(count)}
      {search}
    </View>
  );
  const total = all.data?.counts.needs_you ?? 0;
  if (spaces.length <= 1) {
    return (
      <SidebarRow
        icon="Map"
        active={Boolean(onScreen)}
        onPress={() => openScreen({ screenId: "space", params: { ...(spaces[0] ? { space: spaces[0].key } : {}), ...live(total) } })}
        trailing={trailing(total)}
      />
    );
  }
  const rows = prefs.data?.space_rows === true;
  const shownSpace = rows && currentScreen?.screenId === "space" ? spaces.find((s) => s.key === currentScreen.params.space)?.key : undefined;
  return (
    <>
      <SidebarRow
        id="all"
        icon="Map"
        label={PLUGIN_NAME}
        active={Boolean(onScreen) && !shownSpace}
        onPress={() => openScreen({ screenId: "space", params: live(total) })}
        trailing={trailing(total)}
      />
      {rows
        ? spaces.map((space) => (
            <SidebarRow
              key={space.key}
              id={`space-${space.key}`}
              icon="Map"
              label={space.name}
              active={shownSpace === space.key}
              onPress={() => openScreen({ screenId: "space", params: { space: space.key, ...live(needs(space.key)) } })}
              trailing={badge(needs(space.key))}
            />
          ))
        : null}
    </>
  );
}

/** PD's search in the sidebar's popover: every space; a result opens its screen and closes the popover. */
function SearchPopover({ theme, layout, close, openScreen }: PluginPopoverProps) {
  const styles = useStyles(theme, layout.compact);
  const opener = useMemo<SearchOpener>(() => {
    const go = (screenId: string, params: Record<string, string>) => {
      close();
      openScreen({ screenId, params });
    };
    return {
      task: (task) => go("task", { task }),
      feature: (feature) => go("feature", { feature }),
      line: (space, project) => go("line", { space, project }),
      tasks: (space, words) => go("space", { ...(space ? { space } : {}), tab: "tasks", q: words }),
    };
  }, [close, openScreen]);
  return (
    <View style={{ padding: 12, gap: 8, minWidth: layout.compact ? undefined : 420, backgroundColor: theme.colors.surface0 }}>
      <SearchPanel space="" opener={opener} theme={theme} styles={styles} compact={layout.compact} autoFocus />
    </View>
  );
}
