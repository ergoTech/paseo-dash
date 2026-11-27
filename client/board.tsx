import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { spaceOfId } from "../shared/across.ts";
import { tasksUpdateRpc } from "../shared/api.ts";
import { type BoardColumn, type BoardMove, boardMove, RANKED_COLUMNS, uiBoardRpc } from "../shared/board.ts";
import { overlapText } from "../shared/live.ts";
import { tasksArchiveRpc, tasksRankRpc } from "../shared/ui.ts";
import { ArchiveTasksDialog, StatusDialog } from "./actions.tsx";
import { Button, Chip, isWebUrl, LabelChips, Mark, REFRESH_MS, SpaceTag, type Styles } from "./common.tsx";
import { TaskFormFor, useRefresh } from "./forms.tsx";
import { SpaceFilter, TaskFilters, useOptionsOf, useSpaceOptions, withColors } from "./labels.tsx";
import { LiveLine } from "./live.tsx";
import { useShow } from "./nav.ts";
import { RankButtons } from "./rank.tsx";
import { draggable, dropTarget, onPageKey, onView } from "./web.ts";

/**
 * The board (04-ux.md, The board): a space's tasks in columns by section, the wide layout's first tab.
 * On the web and desktop apps a card drags between the drafts and the tasks waiting to start, and
 * within its column; everywhere its buttons do the same. n opens a new task, f the filters; / is the
 * top bar's search (client/topbar.tsx). Running, review and done cards only open the task: their
 * moves belong to the run. A card whose work was merged outside the dashboard says so, links the
 * PR/MR and offers "Mark done"; the status changes only when the person confirms. A finished card is
 * archived off the board, one by one or all at once; the Archived filter lists them, with Unarchive
 * (03-model.md, Archive).
 */

type Theme = PluginScreenProps["theme"];
type Board = RpcOutput<typeof uiBoardRpc>;
type Card = Board["columns"][number]["tasks"][number];

const COLUMN_TITLE: Record<BoardColumn, string> = {
  draft: "Drafts",
  ready: "Ready to start",
  blocked: "Blocked",
  running: "Running",
  review: "Review",
  done: "Done",
};

const COLUMN_WIDTH = 280;

export function BoardTab({ space, spaces, theme, styles, compact, onNew, query, onQuery }: {
  space: string;
  spaces: { key: string; name: string }[] | undefined;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  onNew: () => void;
  /** The words the board is filtered by, shared with Tasks and Inbox (the space screen keeps them). */
  query: string;
  onQuery: (query: string) => void;
}) {
  const read = useRpc(uiBoardRpc);
  const update = useRpc(tasksUpdateRpc);
  const rank = useRpc(tasksRankRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const [only, setOnly] = useState("");
  const asked = space || only;
  const [mine, setMine] = useState(false);
  const [label, setLabel] = useState("");
  const [words, setWords] = useState(query.trim());
  const [filtering, setFiltering] = useState(false);
  const [accepting, setAccepting] = useState<string | undefined>();
  const [over, setOver] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);
  const archive = useRpc(tasksArchiveRpc);
  useEffect(() => {
    const timer = setTimeout(() => setWords(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const keys = spaces?.map((s) => s.key) ?? [];
  const own = useSpaceOptions(space).data?.labels;
  const every = useOptionsOf(keys).of;
  const paletteOf = (id: string) => (space ? own : every.get(spaceOfId(id))?.labels);
  const board = useQuery({
    queryKey: ["dashboard", "board", asked, mine, label, words, archived],
    queryFn: () => read({ space: asked || undefined, mine: mine || undefined, label: label || undefined, query: words || undefined, archived: archived || undefined }),
    refetchInterval: REFRESH_MS,
  });
  const columns = board.data?.columns ?? [];
  // A move among all tasks of a priority is offered only while the column shows them all.
  const narrowed = mine || Boolean(label) || Boolean(words);

  const root = useRef<View>(null);
  const latest = useRef({ onNew });
  latest.current = { onNew };
  useEffect(
    () =>
      onPageKey(({ key, alt }) => {
        if (alt || !onView(root.current)) return false;
        if (key === "n") return latest.current.onNew(), true;
        if (key === "f") return setFiltering((open) => !open), true;
        return false;
      }),
    [],
  );

  const act = async (card: Card, move: BoardMove) => {
    if (move.kind === "none") {
      if (move.why) toast.show(move.why);
      return;
    }
    if (move.kind === "accept") return setAccepting(card.id);
    setBusy(true);
    try {
      if (move.kind === "status") {
        const answer = await update({ task: card.id, status: move.to });
        if (!answer.ok) toast.error(answer.error);
        else toast.show(`${card.id} is ${move.to === "todo" ? "accepted" : "back in the drafts"}`, { variant: "success" });
      } else {
        const answer = await rank({ task: card.id, position: move.position, next_to: move.next_to });
        if (!answer.ok) toast.error(answer.error);
      }
    } catch (failure) {
      toast.error(`Unknown whether it changed: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  /** Archive or Unarchive on one card: reversible, so it asks nothing. */
  const archiveCard = async (card: Card, to: boolean) => {
    setBusy(true);
    try {
      const answer = await archive({ archived: to, tasks: [card.id] });
      if (!answer.ok) toast.error(answer.error);
      else toast.show(to ? `${card.id} archived: the Archived filter lists it` : `${card.id} is back on the board`, { variant: "success" });
    } catch (failure) {
      toast.error(`Unknown whether it changed: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const doneTotal = columns.find((c) => c.column === "done")?.total ?? 0;
  const find = (id: string) => columns.flatMap((c) => c.tasks).find((t) => t.id === id);
  const drop = (id: string, column: BoardColumn, target?: Card, after?: boolean) => {
    setOver(undefined);
    const card = find(id);
    if (!card || busy) return;
    void act(card, boardMove(card, { column, card: target, after }));
  };

  return (
    <View ref={root} style={{ flex: 1 }}>
      <View style={[styles.content, { paddingTop: 12, paddingBottom: 8, gap: 8 }]}>
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <TextInput
            value={query}
            onChangeText={onQuery}
            placeholder="Filter the board: words, an id, a label"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Filter the board"
            style={[styles.text, { flex: 1, minWidth: 180, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
          />
          <Button label={filtering ? "Hide filters" : compact ? "Filters" : "Filters ( f )"} ghost onPress={() => setFiltering(!filtering)} styles={styles} />
          <Chip
            label={archived ? "✓ Archived" : "Archived"}
            active={archived}
            accessibilityLabel={archived ? "Show the board" : "Show only the archived tasks"}
            onPress={() => setArchived(!archived)}
            styles={styles}
          />
        </View>
        {archived ? <Text style={styles.muted}>Archived tasks only: done and canceled tasks taken off the board. Unarchive puts one back.</Text> : null}
        {filtering ? (
          <>
            {spaces ? <SpaceFilter spaces={spaces} value={only} onChange={setOnly} styles={styles} /> : null}
            <TaskFilters space={asked} spaces={keys} mine={mine} onMine={setMine} label={label} onLabel={setLabel} styles={styles} />
          </>
        ) : null}
        {board.isError ? <Text style={styles.error}>{`Could not read the board: ${String(board.error)}`}</Text> : null}
        {board.data?.error ? <Text style={styles.error}>{board.data.error}</Text> : null}
        {board.data?.searched_for ? <Text style={styles.muted}>{`Nothing matched as typed; showing «${board.data.searched_for}», the other keyboard layout.`}</Text> : null}
        {board.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      </View>
      {/* A horizontal scroller clips what is taller than it, so each column fills its height and scrolls its own cards. */}
      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: compact ? 12 : 20, paddingBottom: 16, gap: 12 }}>
        {columns
          .filter((c) => !archived || c.column === "done")
          .map((c) => (
            <Column
              key={c.column}
              column={c.column}
              archived={archived}
              onArchiveAll={!archived && !narrowed && c.column === "done" && c.total > 0 ? () => setArchivingAll(true) : undefined}
              onArchive={archiveCard}
              total={c.total}
              tasks={c.tasks}
              over={over === c.column}
              onOver={() => setOver(c.column)}
              onDrop={drop}
              onDragEnd={() => setOver(undefined)}
              act={act}
              busy={busy}
              narrowed={narrowed}
              spaces={Boolean(spaces)}
              paletteOf={paletteOf}
              theme={theme}
              styles={styles}
            />
          ))}
      </ScrollView>
      {accepting ? <TaskFormFor task={accepting} accept onClose={() => setAccepting(undefined)} styles={styles} theme={theme} /> : null}
      {archivingAll ? (
        <ArchiveTasksDialog
          finishedOf={asked ? { space: asked } : {}}
          title={asked ? `Every finished task of ${asked}` : "Every finished task of every space"}
          note={`The ${doneTotal} done task${doneTotal === 1 ? "" : "s"} of the board's Done column, and the canceled ones (which have no column), are archived.`}
          archived
          open
          onClose={() => setArchivingAll(false)}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function Column({ column, archived, onArchiveAll, onArchive, total, tasks, over, onOver, onDrop, onDragEnd, act, busy, narrowed, spaces, paletteOf, theme, styles }: {
  column: BoardColumn;
  /** The board shows only archived tasks, all in this one column. */
  archived: boolean;
  /** "Archive all…" in the column's header: the done column of a board not narrowed by filters. */
  onArchiveAll?: () => void;
  onArchive: (card: Card, archived: boolean) => Promise<void>;
  total: number;
  tasks: Card[];
  over: boolean;
  onOver: () => void;
  onDrop: (id: string, column: BoardColumn, target?: Card, after?: boolean) => void;
  onDragEnd: () => void;
  act: (card: Card, move: BoardMove) => Promise<void>;
  busy: boolean;
  narrowed: boolean;
  spaces: boolean;
  paletteOf: (id: string) => { name: string; color: string; defined: boolean }[] | undefined;
  theme: Theme;
  styles: Styles;
}) {
  const show = useShow();
  const ref = useRef<View>(null);
  const takes = RANKED_COLUMNS.has(column);
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const hover = useRef(onOver);
  hover.current = onOver;
  useEffect(() => (takes ? dropTarget(ref.current, { over: () => hover.current(), drop: (id) => latest.current(id, column) }) : undefined), [takes, column]);
  const list = tasks.map((t) => ({ id: t.id, title: t.title }));
  const left = total - tasks.length;
  return (
    <View
      ref={ref}
      accessibilityLabel={`${COLUMN_TITLE[column]}, ${total}`}
      style={[styles.card, { width: COLUMN_WIDTH, gap: 8, backgroundColor: theme.colors.surface0 }, over ? { borderColor: theme.colors.accent } : null]}
    >
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <Text accessibilityRole="header" style={styles.heading}>{`${archived ? "Archived" : COLUMN_TITLE[column]} · ${total}`}</Text>
        {onArchiveAll ? <Button label="Archive all…" accessibilityLabel="Archive every done and canceled task" ghost disabled={busy} onPress={onArchiveAll} styles={styles} /> : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
        {tasks.length === 0 ? <Text style={styles.muted}>Nothing here.</Text> : null}
        {tasks.map((t) => (
          <BoardCard
            key={t.id}
            card={t}
            column={column}
            active={show.shows({ kind: "task", task: t.id })}
            onOpen={() => show.task(t.id, { title: t.title, list })}
            onDrop={(id, after) => latest.current(id, column, t, after)}
            onDragEnd={onDragEnd}
            act={act}
            onArchive={onArchive}
            busy={busy}
            narrowed={narrowed}
            space={spaces ? spaceOfId(t.id) : undefined}
            palette={paletteOf(t.id)}
            theme={theme}
            styles={styles}
          />
        ))}
        {left > 0 ? (
          <Text style={styles.muted}>{column === "done" ? `${left} older ${archived ? "archived" : "finished"} tasks: the Tasks tab lists them.` : `${left} more: the Tasks tab lists them.`}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** What "Mark done" says about a card whose work was merged outside the dashboard. */
function mergedNote(card: Card): string {
  const prs = (card.merged ?? []).map((pr) => pr.label).join(", ");
  const draft = card.status === "inbox" ? "The draft is accepted and marked done" : "The task is marked done";
  return `${draft} without a run: its work is merged already (${prs}). Nothing else changes.`;
}

function BoardCard({ card, column, active, onOpen, onDrop, onDragEnd, act, onArchive, busy, narrowed, space, palette, theme, styles }: {
  card: Card;
  onArchive: (card: Card, archived: boolean) => Promise<void>;
  column: BoardColumn;
  active: boolean;
  onOpen: () => void;
  onDrop: (id: string, after: boolean) => void;
  onDragEnd: () => void;
  act: (card: Card, move: BoardMove) => Promise<void>;
  busy: boolean;
  narrowed: boolean;
  space?: string;
  palette: { name: string; color: string; defined: boolean }[] | undefined;
  theme: Theme;
  styles: Styles;
}) {
  const ref = useRef<View>(null);
  const ranked = RANKED_COLUMNS.has(column);
  const [marking, setMarking] = useState(false);
  const latest = useRef({ onDrop, onDragEnd });
  latest.current = { onDrop, onDragEnd };
  useEffect(() => {
    if (!ranked) return undefined;
    const stopDrag = draggable(ref.current, card.id, () => latest.current.onDragEnd());
    const stopDrop = dropTarget(ref.current, { drop: (id, after) => latest.current.onDrop(id, after) });
    return () => {
      stopDrag();
      stopDrop();
    };
  }, [ranked, card.id]);
  const note = [card.id, card.priority, card.project || (card.status === "inbox" ? "no project yet" : ""), card.assignee, card.activity].filter(Boolean).join(" · ");
  return (
    <View ref={ref} style={[styles.card, { gap: 4 }, active ? styles.chipActive : null]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${card.title}`} onPress={onOpen} style={{ gap: 4 }}>
        <View style={[styles.row, { alignItems: "flex-start" }]}>
          <Mark glyph={card.glyph} theme={theme} />
          {space ? <SpaceTag space={space} theme={theme} /> : null}
          <Text style={[styles.text, { flex: 1 }]} numberOfLines={3}>
            {card.title}
          </Text>
        </View>
        <Text style={styles.muted} numberOfLines={2}>
          {note}
        </Text>
        {card.live ? <LiveLine now={card.live} style={styles.muted} accent={theme.colors.accent} muted={theme.colors.foregroundMuted} /> : null}
        {card.overlaps?.length ? (
          <Text style={[styles.muted, { color: theme.colors.statusDanger }]} numberOfLines={2}>
            {`⚠ Also changed here by ${card.overlaps.map(overlapText).join("; ")}`}
          </Text>
        ) : null}
        {card.blocked_by ? (
          <Text style={styles.muted} numberOfLines={2}>{`⊘ waits for ${card.blocked_by}`}</Text>
        ) : null}
        {card.needs === "merged" && card.next ? (
          <Text style={styles.text} numberOfLines={4}>{`✓ Merged work waits: ${card.next}`}</Text>
        ) : null}
        {card.unheld ? (
          <Text style={styles.muted} numberOfLines={2}>
            No run holds it: open it to mark it done, put it back to todo, cancel or start it.
          </Text>
        ) : null}
        {card.quote && card.matched_in && card.matched_in !== "title" && card.matched_in !== "id" ? (
          <Text style={[styles.muted, { fontStyle: "italic" }]} numberOfLines={2}>{`${card.matched_in.replace("_", " ")}: «${card.quote}»`}</Text>
        ) : null}
        {card.labels?.length ? <LabelChips labels={withColors(card.labels, palette)} theme={theme} small /> : null}
      </Pressable>
      {card.merged?.length ? (
        <View style={{ gap: 4 }}>
          <View style={[styles.row, { flexWrap: "wrap", gap: 4 }]}>
            <Text style={styles.text}>✓ Work already merged:</Text>
            {card.merged.map((pr) =>
              isWebUrl(pr.url) ? (
                <ExternalLink key={pr.url} href={pr.url}>
                  <Text style={[styles.text, { color: theme.colors.accent }]}>{pr.label}</Text>
                </ExternalLink>
              ) : (
                <Text key={pr.url} style={styles.text}>
                  {pr.label}
                </Text>
              ),
            )}
          </View>
          <View style={styles.row}>
            <Button label="Mark done…" accessibilityLabel={`Mark ${card.title} done: its work is merged`} disabled={busy} onPress={() => setMarking(true)} styles={styles} />
          </View>
        </View>
      ) : null}
      {marking ? (
        <StatusDialog
          task={card.id}
          title={card.title}
          to="done"
          label="Mark done"
          note={mergedNote(card)}
          accept={card.status === "inbox"}
          open
          onClose={() => setMarking(false)}
          styles={styles}
        />
      ) : null}
      {card.status === "done" || card.status === "canceled" ? (
        <View style={styles.row}>
          <Button
            label={card.archived ? "Unarchive" : "Archive"}
            accessibilityLabel={card.archived ? `Put ${card.title} back on the board` : `Archive ${card.title}: take it off the board`}
            ghost
            disabled={busy}
            onPress={() => void onArchive(card, !card.archived)}
            styles={styles}
          />
        </View>
      ) : null}
      {ranked ? (
        <View style={[styles.row, { flexWrap: "wrap", gap: 4 }]}>
          {column === "draft" ? (
            <Button
              label={card.project ? "Accept" : "Accept…"}
              accessibilityLabel={card.project ? `Accept ${card.title} as a task to start` : `Accept ${card.title}: pick its project`}
              ghost
              disabled={busy}
              onPress={() => void act(card, boardMove(card, { column: "ready" }))}
              styles={styles}
            />
          ) : (
            <Button label="To drafts" accessibilityLabel={`Move ${card.title} back to the drafts`} ghost disabled={busy} onPress={() => void act(card, boardMove(card, { column: "draft" }))} styles={styles} />
          )}
          {narrowed ? null : <RankButtons task={card.id} styles={styles} compact />}
        </View>
      ) : null}
    </View>
  );
}
