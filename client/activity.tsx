import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ActiveWorkspace, activityRpc, activityTrackRpc, type PastWorkspace } from "../shared/activity.ts";
import { Button, REFRESH_MS, SpaceTag, type Styles } from "./common.tsx";
import { Field, useRefresh } from "./forms.tsx";
import { useShow } from "./nav.ts";

/**
 * Work in Paseo that the plan does not hold (shared/activity.ts): a line's open workspaces, busy
 * ones first, each opening in Paseo and each with "Track as task", and its archived ones as "Earlier".
 */

type Theme = PluginHostProps["theme"];
type Navigation = PluginScreenProps["navigation"];

const STATUS_LABEL: Record<ActiveWorkspace["status"], string> = {
  needs_input: "waits for you",
  failed: "failed",
  attention: "finished, take a look",
  running: "agent working",
  done: "idle",
};

export function statusColor(theme: Theme, status: ActiveWorkspace["status"]): string {
  if (status === "needs_input" || status === "failed") return theme.colors.statusDanger;
  if (status === "running" || status === "attention") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", or "14:05" today; empty for no date. */
function shortWhen(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** "as of 14:05", or "as of 26 Oct, 14:05" before today: when the shown answer was read. */
function asOf(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `as of ${at.toDateString() === now.toDateString() ? time : `${shortWhen(iso, now)}, ${time}`}`;
}

/** The read failed: its reason, and when the workspaces still shown were read. */
function ReadProblem({ error, readAt, styles }: { error: string; readAt: string; styles: Styles }) {
  if (!error) return null;
  const when = asOf(readAt);
  return <Text style={styles.error}>{when ? `${error.replace(/\.$/, "")}. Shown ${when}.` : error}</Text>;
}

export function WorkspaceRow({ w, theme, styles, onOpen }: { w: ActiveWorkspace; theme: Theme; styles: Styles; onOpen?: () => void }) {
  const color = statusColor(theme, w.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${w.title}, ${STATUS_LABEL[w.status]}${onOpen ? ", opens in Paseo" : ""}`}
      disabled={!onOpen}
      onPress={onOpen}
      style={[styles.row, { paddingVertical: 6, alignItems: "flex-start" }]}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: color }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={styles.text}>
          {w.title}
        </Text>
        <Text numberOfLines={1} style={styles.muted}>
          <Text style={{ color }}>{STATUS_LABEL[w.status]}</Text>
          {[w.branch, w.pr_state ? `PR ${w.pr_state}` : "", shortWhen(w.since)].filter(Boolean).map((part) => ` · ${part}`).join("")}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * "Track as task" under an open workspace (05-architecture.md, Tracking a Paseo workspace as a task):
 * an inline confirmation, since the list may already be a sheet. It says what will be followed and
 * that the agent has no dashboard tools, then opens the new task, or the task already tracking it.
 */
function TrackWorkspace({ space, project, trunk, w, theme, styles, onTracked }: {
  space: string;
  project: string;
  /** The line's trunk from space.yaml; empty when it names none. */
  trunk: string;
  w: ActiveWorkspace;
  theme: Theme;
  styles: Styles;
  onTracked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(w.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const track = useRpc(activityTrackRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const show = useShow();
  if (!open) {
    return (
      <View style={{ flexDirection: "row", paddingLeft: 18 }}>
        <Button label="Track as task…" ghost onPress={() => setOpen(true)} styles={styles} />
      </View>
    );
  }
  const onTrunk = Boolean(trunk) && w.branch === trunk;
  const follows = onTrunk
    ? `This checkout is on the trunk ${trunk}, so there is no PR/MR: the task shows "landed" once its commits are on origin/${trunk} and its tree is clean, and you mark it done.`
    : `Its PR/MR is followed as a started run's is: first seen open and not a draft, the task goes to review; merged, it is done once its acceptance lines are ticked.${trunk ? "" : " A checkout on the project's default branch shows \"landed\" instead."}`;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await track({ space, project, workspace_id: w.workspace_id, title: title.trim() || undefined });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(answer.existing ? `Already tracked as ${answer.id}` : `Tracked as ${answer.id}`, { variant: "success" });
      setOpen(false);
      show.task(answer.id);
      onTracked?.();
    } catch (failure) {
      setError(`Unknown whether it was tracked: ${String((failure as Error)?.message ?? failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.card, { gap: 6, marginLeft: 18 }]}>
      <Field label="Task title" value={title} onChange={setTitle} styles={styles} theme={theme} />
      <Text style={styles.text}>{follows}</Text>
      <Text style={styles.muted}>
        {`Its agent was not started by Paseo Dash and has no Paseo Dash tools (no task_report): progress comes from the agent's state in Paseo and from ${onTrunk ? "whether its commits landed" : "its PR/MR"}.`}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={[styles.row, { justifyContent: "flex-end", flexWrap: "wrap" }]}>
        <Button label="Close" ghost onPress={() => setOpen(false)} styles={styles} />
        <Button label={busy ? "Working…" : "Track as task"} disabled={busy} onPress={() => void go()} styles={styles} />
      </View>
    </View>
  );
}

function PastRow({ p, styles }: { p: PastWorkspace; styles: Styles }) {
  return (
    <View style={[styles.row, { paddingVertical: 4, alignItems: "flex-start" }]}>
      <Text style={[styles.muted, { width: 52 }]}>{shortWhen(p.archived_at)}</Text>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={styles.text}>
          {p.title}
        </Text>
        {p.branch ? (
          <Text numberOfLines={1} style={styles.muted}>
            {p.branch}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** One line's Paseo workspaces: open ones (each opens in Paseo), then "Earlier" with the archived ones. */
export function LineActivity({ space, project, navigation, theme, styles, onOpened }: {
  space: string;
  project: string;
  navigation: Navigation;
  theme: Theme;
  styles: Styles;
  onOpened?: () => void;
}) {
  const read = useRpc(activityRpc);
  const query = useQuery({ queryKey: ["dashboard", "activity", space, project], queryFn: () => read({ space, project }), refetchInterval: REFRESH_MS });
  const [showPast, setShowPast] = useState(false);
  const entry = query.data?.projects[0];
  const open = (w: ActiveWorkspace) =>
    navigation
      ? () => {
          navigation.openWorkspace({ workspaceId: w.workspace_id });
          onOpened?.();
        }
      : undefined;
  return (
    <View style={{ gap: 8 }}>
      {query.isError ? <Text style={styles.error}>{`Could not read Paseo's workspaces: ${String(query.error)}`}</Text> : null}
      {query.data ? <ReadProblem error={query.data.error} readAt={query.data.read_at} styles={styles} /> : null}
      {!query.data ? <Text style={styles.muted}>Loading…</Text> : null}
      {entry && entry.active.length === 0 ? <Text style={styles.muted}>No open workspace in Paseo outside the plan.</Text> : null}
      {entry?.active.map((w) => (
        <View key={w.workspace_id}>
          <WorkspaceRow w={w} theme={theme} styles={styles} onOpen={open(w)} />
          <TrackWorkspace space={space} project={project} trunk={entry.trunk} w={w} theme={theme} styles={styles} onTracked={onOpened} />
        </View>
      ))}
      {entry && entry.past.length ? (
        <View style={{ gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPast }} onPress={() => setShowPast(!showPast)} style={{ paddingVertical: 4 }}>
            <Text style={styles.heading}>{`${showPast ? "▾" : "▸"} Earlier · ${entry.past.length}`}</Text>
          </Pressable>
          {showPast ? entry.past.map((p) => <PastRow key={`${p.workspace_id}:${p.archived_at}`} p={p} styles={styles} />) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The same as a sheet over the map: tapping a line's Paseo count opens it. */
export function ActivitySheet({ space, project, navigation, theme, styles, onClose }: {
  space: string;
  project: string;
  navigation: Navigation;
  theme: Theme;
  styles: Styles;
  onClose: () => void;
}) {
  return (
    <Modal title={`${project} in Paseo`} open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <LineActivity space={space} project={project} navigation={navigation} theme={theme} styles={styles} onOpened={onClose} />
      </Modal.Content>
    </Modal>
  );
}

/**
 * Every line's open Paseo workspaces outside the plan, for the Live tab; with `space` empty, every
 * space's lines, each headed by its space's tag (a workspace shows once, under the first line that
 * has it: shared/activity.ts).
 */
export function SpaceActivity({ space, navigation, theme, styles }: { space: string; navigation: Navigation; theme: Theme; styles: Styles }) {
  const read = useRpc(activityRpc);
  const query = useQuery({ queryKey: ["dashboard", "activity", space, ""], queryFn: () => read({ space: space || undefined }), refetchInterval: REFRESH_MS });
  const lines = (query.data?.projects ?? []).filter((p) => p.active.length);
  return (
    <View style={{ gap: 8 }}>
      {query.isError ? <Text style={styles.error}>{`Could not read Paseo's workspaces: ${String(query.error)}`}</Text> : null}
      {query.data ? <ReadProblem error={query.data.error} readAt={query.data.read_at} styles={styles} /> : null}
      {query.data && lines.length === 0 ? <Text style={styles.muted}>Nothing open in Paseo outside the plan.</Text> : null}
      {lines.map((p) => (
        <View key={`${p.space}/${p.project}`} style={{ gap: 2 }}>
          <View style={styles.row}>
            {space ? null : <SpaceTag space={p.space} theme={theme} />}
            <Text style={[styles.muted, { fontWeight: "700" }]}>{p.project}</Text>
          </View>
          {p.active.map((w) => (
            <View key={w.workspace_id}>
              <WorkspaceRow w={w} theme={theme} styles={styles} onOpen={navigation ? () => navigation.openWorkspace({ workspaceId: w.workspace_id }) : undefined} />
              <TrackWorkspace space={p.space} project={p.project} trunk={p.trunk} w={w} theme={theme} styles={styles} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
