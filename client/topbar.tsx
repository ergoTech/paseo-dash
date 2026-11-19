import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";
import { overviewRpc } from "../shared/overview.ts";
import type { RecentItem } from "../shared/ui.ts";
import { BackRow } from "./back.tsx";
import { REFRESH_MS, type Styles } from "./common.tsx";
import type { ScreenLocation } from "./history.ts";
import { useOpen, useShow } from "./nav.ts";
import { SettingsButton } from "./run-settings.tsx";
import { SearchPanel, type SearchOpener, useRememberPlace } from "./search.tsx";
import { onPageKey, onView } from "./web.ts";

/**
 * PD's top bar, the first row of the space, line,
 * feature and task screens: "‹ Back" where there is a way back, the search, off the space screen
 * (whose live strip says it) how many things wait for the person, which opens Live, and, at the
 * right end, Settings (client/run-settings.tsx). Paseo owns the screen header, so the bar is the
 * screen's own first row. `/` focuses the search while
 * its bar is on view, on the web and desktop apps (a page scrolled past it scrolls back first).
 */

type Theme = PluginHostProps["theme"];

export function TopBar({
  here,
  fallback,
  space,
  theme,
  styles,
  compact,
  needs,
  focus,
  remember,
  onShowAll,
  back = true,
}: {
  /** The screen the bar is on: results open from it, and "‹ Back" leaves it. */
  here: ScreenLocation;
  /** Where "‹ Back" leads without a previous screen. */
  fallback?: ScreenLocation;
  /** The space searched first ("" for every space). */
  space: string;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  /** Show the needs-you count (off on the space screen, whose live strip has it). */
  needs?: boolean;
  /** Focus the search when this changes to a new non-empty value (Command Center's "Search"). */
  focus?: string;
  /** The place on view, remembered for the search's empty field once its title is known. */
  remember?: RecentItem;
  /** The space screen shows "Show all" in its own Tasks tab rather than opening another screen. */
  onShowAll?: (space: string, words: string) => void;
  /** "‹ Back": off on the space screen, the dashboard's home, where an old entry could lead to itself. */
  back?: boolean;
}) {
  const root = useRef<View>(null);
  const input = useRef<TextInput>(null);
  const show = useShow(here);
  const openScreen = useOpen(here);
  const opener = useMemo<SearchOpener>(
    () => ({
      task: (id, title) => show.task(id, { title }),
      feature: (id, title) => show.feature(id, title),
      line: (lineSpace, project) => show.line(lineSpace, project),
      tasks: (target, words) => (onShowAll ? onShowAll(target, words) : openScreen("space", { ...(target ? { space: target } : {}), tab: "tasks", q: words })),
    }),
    [show, openScreen, onShowAll],
  );
  useEffect(
    () =>
      onPageKey(({ key, alt }) => {
        if (alt || key !== "/" || !onView(root.current)) return false;
        input.current?.focus();
        return true;
      }),
    [],
  );
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const keep = useRememberPlace();
  const place = remember && remember.title ? `${remember.kind}:${remember.space}:${remember.id}:${remember.title}` : "";
  useEffect(() => {
    if (remember && place) keep(remember);
  }, [place]);
  return (
    <View ref={root}>
      <SearchPanel
        space={space}
        opener={opener}
        theme={theme}
        styles={styles}
        compact={compact}
        inputRef={input}
        leading={back ? <BackRow here={here} fallback={fallback} theme={theme} /> : undefined}
        trailing={
          <>
            {needs ? <NeedsCount space={space} theme={theme} onOpen={() => openScreen("space", { ...(space ? { space } : {}), tab: "live" })} /> : null}
            <SettingsButton theme={theme} styles={styles} compact={compact} />
          </>
        }
      />
    </View>
  );
}

/** "! 3" in red while something waits for the person; nothing while nothing does. */
function NeedsCount({ space, theme, onOpen }: { space: string; theme: Theme; onOpen: () => void }) {
  const read = useRpc(overviewRpc);
  const overview = useQuery({ queryKey: ["dashboard", "overview", space], queryFn: () => read({ space: space || undefined }), refetchInterval: REFRESH_MS });
  const count = overview.data?.counts.needs_you ?? 0;
  if (!count) return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${count} need you: open Live`} onPress={onOpen} hitSlop={6} style={{ paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color: theme.colors.statusDanger, fontWeight: "700", fontSize: 13 }}>{`! ${count}`}</Text>
    </Pressable>
  );
}
