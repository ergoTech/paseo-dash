import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { spaceOfId } from "../shared/across.ts";
import { tasksListRpc } from "../shared/api.ts";
import { type RecentItem, uiRecentAddRpc, uiRecentRpc } from "../shared/ui.ts";
import { PLUGIN_NAME } from "../shared/edition.ts";
import { Mark, SpaceTag, type Styles } from "./common.tsx";

/**
 * Search in PD's top bar and the sidebar's popover: a
 * field and, under it while something is typed, the tasks the plan's one search finds (tasks.list,
 * server/search/core.ts) and the features, releases and projects whose names match; with the field
 * empty and focused, the places opened last. ↑ ↓ choose and Enter opens on the web and desktop apps;
 * Enter alone opens the first result of the words in the field (waiting for their search when it
 * has not answered yet), so an id and Enter opens its task. Esc clears, then leaves. The results
 * show while the field has the focus, and stay through a press on one of them; in a popover they
 * show while it is open, and the field takes the focus once the popover is placed.
 */

type Theme = PluginHostProps["theme"];

/** How a result is opened: in the space screen's inspector, as a screen, or from the sidebar. */
export interface SearchOpener {
  task(id: string, title: string): void;
  feature(id: string, title: string): void;
  line(space: string, project: string): void;
  /** The Tasks tab of `space` ("" for every space) with the words: all the results, and a release's tasks. */
  tasks(space: string, words: string): void;
}

/** Results the field shows at most; "Show all" opens the rest in the Tasks tab. */
const SHOWN = 8;
/** How long typing pauses before the search runs. */
const DEBOUNCE_MS = 150;
/** After the field loses the focus (and no result is being pressed), the results go this much later. */
const BLUR_GRACE_MS = 200;
/**
 * Frames a popover's field keeps asking for the focus after it opens: Paseo's popover places itself
 * and settles the focus on frames of its own, after the field's autoFocus ran.
 */
const FOCUS_FRAMES = 10;

type Row =
  | { kind: "task"; id: string; title: string; glyph: Parameters<typeof Mark>[0]["glyph"]; note: string; quote: string }
  | { kind: "feature" | "release" | "project"; id: string; title: string; space: string }
  | { kind: "recent"; item: RecentItem };

/** The words to mark in a title: as typed, each of two characters or more. */
function marked(words: string): string[] {
  return [...new Set(words.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
}

/** `text` with the words asked in bold, ignoring case. */
export function Highlighted({ text, words, style, strong }: { text: string; words: string[]; style: object; strong: object }) {
  if (!words.length) return <Text style={style}>{text}</Text>;
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const parts = text.split(pattern);
  return (
    <Text style={style} numberOfLines={2}>
      {parts.map((part, i) => (i % 2 ? <Text key={i} style={strong}>{part}</Text> : part))}
    </Text>
  );
}

/** Remembers a place a person opened (server/ui-prefs.ts); a failure only means it is not offered later. */
export function useRememberPlace(): (item: RecentItem) => void {
  const add = useRpc(uiRecentAddRpc);
  const client = useQueryClient();
  return useCallback(
    (item: RecentItem) => {
      if (!item.id || !item.title) return;
      void add(item)
        .then(() => client.invalidateQueries({ queryKey: ["dashboard", "recent"] }))
        .catch(() => undefined);
    },
    [add, client],
  );
}

export function SearchPanel({
  space,
  opener,
  theme,
  styles,
  compact,
  inputRef,
  autoFocus,
  persistent,
  leading,
  trailing,
}: {
  /** The space searched first ("" for every space); a chip widens it. */
  space: string;
  opener: SearchOpener;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  inputRef?: RefObject<TextInput | null>;
  autoFocus?: boolean;
  /** In a popover: the results show while it is open, whatever has the focus, and the field takes the focus. */
  persistent?: boolean;
  /** Beside the field, before and after it (the top bar's "‹ Back" and needs-you count). */
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const own = useRef<TextInput>(null);
  const input = inputRef ?? own;
  const [text, setText] = useState("");
  const [words, setWords] = useState("");
  // The results show while the field is focused, and a little after it lost focus to a press on one.
  const [focused, setFocused] = useState(Boolean(autoFocus));
  const [everywhere, setEverywhere] = useState(false);
  const [selected, setSelected] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputFocused = useRef(Boolean(autoFocus));
  const pressing = useRef(false);
  // Enter pressed before the search of the text in the field answered: open its first result then.
  const pendingEnter = useRef<string | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setWords(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  // A popover settles the focus after its content mounted: ask for it again while the field lacks it.
  useEffect(() => {
    if (!persistent) return;
    let frames = 0;
    let frame = requestAnimationFrame(function ask() {
      if (input.current && !input.current.isFocused()) input.current.focus();
      frames += 1;
      if (frames < FOCUS_FRAMES) frame = requestAnimationFrame(ask);
    });
    return () => cancelAnimationFrame(frame);
  }, [persistent, input]);
  const shown = persistent || focused;
  // Each new search starts at its first result.
  useEffect(() => setSelected(0), [words, everywhere]);
  const scope = everywhere ? "" : space;
  const list = useRpc(tasksListRpc);
  const searchable = /[\p{L}\p{N}]/u.test(words);
  const found = useQuery({
    queryKey: ["dashboard", "search", scope, words],
    queryFn: () => list({ space: scope || undefined, query: words, limit: SHOWN }),
    enabled: searchable,
    // The last results stay while the next ones are read, so the list does not flash on each key.
    placeholderData: (previous) => previous,
  });
  const readRecent = useRpc(uiRecentRpc);
  const recent = useQuery({ queryKey: ["dashboard", "recent"], queryFn: () => readRecent({}), enabled: shown && !text.trim() });
  const remember = useRememberPlace();

  const typed = text.trim();
  // Results of the words now in the field only: never an older search's, which Enter must not open.
  const current = searchable && !found.isPlaceholderData ? found.data : undefined;
  const data = searchable ? found.data : undefined;
  const rows: Row[] = !typed
    ? (recent.data?.items ?? []).map((item) => ({ kind: "recent" as const, item }))
    : [
        ...(data?.tasks ?? []).map((t) => ({
          kind: "task" as const,
          id: t.id,
          title: t.title,
          glyph: t.glyph,
          note: [t.id, t.section.replace("_", " "), t.project].filter(Boolean).join(" · "),
          quote: t.matched_in && t.matched_in !== "title" && t.matched_in !== "id" && t.quote ? `${t.matched_in.replace("_", " ")}: «${t.quote}»` : "",
        })),
        ...(data?.also ?? []).map((a) => ({ kind: a.kind, id: a.id, title: a.title, space: a.space ?? spaceOfId(a.id) })),
      ];
  const open = (row: Row) => {
    pendingEnter.current = undefined;
    setText("");
    setWords("");
    input.current?.blur();
    switch (row.kind) {
      case "task":
        remember({ kind: "task", id: row.id, title: row.title, space: spaceOfId(row.id) });
        return opener.task(row.id, row.title);
      case "feature":
        remember({ kind: "feature", id: row.id, title: row.title, space: row.space });
        return opener.feature(row.id, row.title);
      case "project":
        remember({ kind: "line", id: row.id, title: row.id, space: row.space });
        return opener.line(row.space, row.id);
      case "release":
        // A release has no screen: its tasks are what its title finds (search reads a task's release).
        return opener.tasks(row.space, row.title);
      case "recent": {
        const { item } = row;
        remember(item);
        if (item.kind === "task") return opener.task(item.id, item.title);
        if (item.kind === "feature") return opener.feature(item.id, item.title);
        return opener.line(item.space, item.id);
      }
    }
  };
  // Enter waited for the search of the text in the field: open its choice once that search answers;
  // a search that failed opens nothing, now or later.
  useEffect(() => {
    const waiting = pendingEnter.current;
    if (waiting !== undefined && found.isError) pendingEnter.current = undefined;
    if (waiting === undefined || waiting !== words || !current || found.isFetching) return;
    pendingEnter.current = undefined;
    const row = rows[selected] ?? rows[0];
    if (row) open(row);
  });
  const submit = () => {
    if (!typed) {
      const row = rows[selected] ?? rows[0];
      if (row) open(row);
      return;
    }
    if (!/[\p{L}\p{N}]/u.test(typed)) return;
    // The results on screen are those of the words in the field: open the chosen one now.
    if (typed === words && current && !found.isFetching) {
      const row = rows[selected] ?? rows[0];
      if (row) open(row);
      return;
    }
    // Else the words in the field are searched now, and their first result opens when it is known.
    pendingEnter.current = typed;
    if (typed !== words) setWords(typed);
  };
  const close = () => {
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (!inputFocused.current && !pressing.current) setFocused(false);
    }, BLUR_GRACE_MS);
  };
  const onKey = (key: string) => {
    if (key === "ArrowDown") setSelected((i) => Math.max(0, Math.min(rows.length - 1, i + 1)));
    else if (key === "ArrowUp") setSelected((i) => Math.max(0, i - 1));
    else if (key === "Escape") {
      pendingEnter.current = undefined;
      if (text) setText("");
      else input.current?.blur();
    }
  };
  const strong = { fontWeight: "700" as const, color: theme.colors.foreground };
  const total = data?.total ?? 0;
  const shownTasks = data?.tasks.length ?? 0;
  // A press on a result keeps the results until it is done, however long the press.
  const pressProps = {
    onPressIn: () => {
      pressing.current = true;
    },
    onPressOut: () => {
      pressing.current = false;
      close();
    },
  };
  const rowStyle = (active: boolean) => [styles.row, { paddingVertical: 6, paddingHorizontal: 6, borderRadius: 6, alignItems: "flex-start" as const }, active ? { backgroundColor: theme.colors.surface2 } : null];
  const renderRow = (row: Row, i: number) => {
    const active = i === selected;
    if (row.kind === "task") {
      return (
        <Pressable key={`task:${row.id}`} accessibilityRole="button" accessibilityLabel={`${row.title}, ${row.note}`} onPress={() => open(row)} {...pressProps} style={rowStyle(active)}>
          <Mark glyph={row.glyph} theme={theme} />
          {!scope ? <SpaceTag space={spaceOfId(row.id)} theme={theme} /> : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Highlighted text={row.title} words={marked(words)} style={styles.text} strong={strong} />
            <Text style={styles.muted} numberOfLines={1}>
              {row.note}
            </Text>
            {row.quote ? (
              <Text style={[styles.muted, { fontStyle: "italic" }]} numberOfLines={2}>
                {row.quote}
              </Text>
            ) : null}
          </View>
        </Pressable>
      );
    }
    if (row.kind === "recent") {
      return (
        <Pressable key={`recent:${row.item.kind}:${row.item.space}:${row.item.id}`} accessibilityRole="button" accessibilityLabel={`${row.item.kind} ${row.item.title}`} onPress={() => open(row)} {...pressProps} style={rowStyle(active)}>
          <Text style={[styles.muted, { width: 52 }]}>{row.item.kind}</Text>
          <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
            {row.item.title}
          </Text>
          <Text style={styles.muted}>{row.item.kind === "line" ? row.item.space : row.item.id}</Text>
        </Pressable>
      );
    }
    return (
      <Pressable key={`${row.kind}:${row.space}:${row.id}`} accessibilityRole="button" accessibilityLabel={`${row.kind} ${row.title}`} onPress={() => open(row)} {...pressProps} style={rowStyle(active)}>
        <Text style={[styles.muted, { width: 52 }]}>{row.kind}</Text>
        <View style={{ flex: 1 }}>
          <Highlighted text={row.title} words={marked(words)} style={styles.text} strong={strong} />
        </View>
        <Text style={styles.muted}>{row.kind === "project" ? row.space : row.id}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 6, flexGrow: 1, flexShrink: 1 }}>
      <View style={[styles.row, { flexWrap: compact ? "wrap" : "nowrap" }]}>
        {leading}
        <TextInput
          ref={input}
          value={text}
          onChangeText={(next) => {
            // Enter asked for the words it was pressed on, not for what is typed after it.
            if (pendingEnter.current !== undefined && next.trim() !== pendingEnter.current) pendingEnter.current = undefined;
            setText(next);
          }}
          autoFocus={autoFocus}
          onFocus={() => {
            inputFocused.current = true;
            clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          onBlur={() => {
            inputFocused.current = false;
            close();
          }}
          onKeyPress={(event) => onKey(event.nativeEvent.key)}
          onSubmitEditing={submit}
          submitBehavior="submit"
          // Paseo's web and desktop TextInput reads only this one: without it the field blurs on Enter.
          blurOnSubmit={false}
          returnKeyType="search"
          placeholder={compact ? "Search tasks, features, ids" : "Search tasks, features, releases, ids ( / )"}
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel={`Search ${PLUGIN_NAME}`}
          style={[styles.text, { flex: 1, minWidth: 160, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.border, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10 }]}
        />
        {space && focused ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={everywhere ? `Search only ${space}` : `Searching ${space}; search every space`}
            onPress={() => {
              setEverywhere(!everywhere);
              // On the web the press took the focus from the field: give it back, so the results stay.
              input.current?.focus();
            }}
            {...pressProps}
            style={[styles.chip, everywhere ? null : styles.chipActive]}
          >
            <Text style={styles.text}>{everywhere ? "every space" : `in ${space} ×`}</Text>
          </Pressable>
        ) : null}
        {trailing}
      </View>
      {shown ? (
        <View accessibilityRole="list" style={[styles.card, { gap: 2 }]}>
          {!typed ? <Text style={styles.muted}>{rows.length ? "Opened lately" : "Type words of a task, a feature or a release, or an id."}</Text> : null}
          {typed && !/[\p{L}\p{N}]/u.test(typed) ? <Text style={styles.muted}>Type a letter or a digit.</Text> : null}
          {found.isError ? <Text style={styles.error}>{`Could not search: ${String(found.error)}`}</Text> : null}
          {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}
          {data?.searched_for ? <Text style={styles.muted}>{`Nothing matched as typed; showing «${data.searched_for}», the other keyboard layout.`}</Text> : null}
          {data?.partial ? <Text style={styles.muted}>No task has every word; these have some of them.</Text> : null}
          {typed && current && !current.error && rows.length === 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.text}>{`Nothing found for «${words}»${scope ? ` in ${scope}` : ""}.`}</Text>
              <Text style={styles.muted}>Ids, titles, labels, projects, features, releases, people and the text of tasks are searched, in every state.</Text>
              {scope ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setEverywhere(true);
                    input.current?.focus();
                  }}
                  {...pressProps}
                  style={styles.chip}
                >
                  <Text style={styles.text}>Search every space</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {/* Above the rows, where a phone's keyboard does not cover it. */}
          {typed && total > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const asked = words;
                setText("");
                input.current?.blur();
                opener.tasks(scope, asked);
              }}
              {...pressProps}
              style={{ paddingVertical: 6, paddingHorizontal: 6 }}
            >
              <Text style={[styles.text, { color: theme.colors.accent }]}>{total > shownTasks ? `Show all ${total} tasks →` : "Show in the Tasks tab →"}</Text>
            </Pressable>
          ) : null}
          {/* Bounded and scrolling: on the space screen it sits above the tab, on a phone above the keyboard. */}
          <ScrollView style={{ maxHeight: compact ? 240 : 420 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {rows.map(renderRow)}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
