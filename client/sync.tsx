import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { spacesListRpc, spacesSyncRpc } from "../shared/spaces.ts";
import { Button, type Styles } from "./common.tsx";

/**
 * "Sync" (05-architecture.md, Fetching): fetches the plan of the space on view, or of every space,
 * now, outside the fetch loop, and says when it last synced and what went wrong. Command Center's
 * "Sync" opens the space screen with `sync` set, which asks once per request.
 */

/** The spaces' sync state is read again this often while nothing is asked (as Settings reads it). */
const SYNC_STATE_MS = 60_000;

/** "14:03", or "24 Nov 14:03" when it was not today; "" for no time. */
export function syncedAt(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (at.toDateString() === now.toDateString()) return time;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getMonth()];
  return `${at.getDate()} ${month} ${time}`;
}

/** What the control says of the spaces it syncs: the oldest last sync of them, and every problem. */
export function syncState(spaces: { key: string; name: string; last_sync: string; error: string }[], now = new Date()): { text: string; error: string } {
  if (!spaces.length) return { text: "", error: "" };
  const times = spaces.map((s) => s.last_sync);
  const never = times.some((t) => !t);
  const oldest = never ? "" : times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const text = never ? "Not synced yet" : `Synced ${syncedAt(oldest, now)}`;
  const failed = spaces.filter((s) => s.error);
  const error = failed.map((s) => (spaces.length > 1 ? `${s.key}: ${s.error}` : s.error)).join("; ");
  return { text, error: error ? `Sync failed: ${error}` : "" };
}

export function SyncControl({ space, request, styles, theme }: {
  /** The space on view; empty: every space. */
  space: string;
  /** Changes on every Command Center "Sync": each new value syncs once. */
  request?: string;
  styles: Styles;
  theme: PluginScreenProps["theme"];
}) {
  const queryClient = useQueryClient();
  const list = useRpc(spacesListRpc);
  const sync = useRpc(spacesSyncRpc);
  const state = useQuery({ queryKey: ["dashboard", "spaces"], queryFn: () => list({}), refetchInterval: SYNC_STATE_MS });
  const syncing = useMutation({
    mutationFn: () => sync({ space: space || undefined }),
    // Every screen reads again: the plan may have changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!request || asked.current === request) return;
    asked.current = request;
    syncing.mutate();
  }, [request, syncing]);
  const shown = (state.data?.spaces ?? []).filter((s) => !space || s.key.toLowerCase() === space.toLowerCase());
  // The list is read again once a sync settles, so it says the sync's result; an answer without
  // spaces (no such space, another installation owns the data) is said from the answer itself.
  const { text, error } = syncState(shown);
  const answered = syncing.data && !syncing.isPending ? syncing.data : undefined;
  const failure = syncing.isError
    ? `Sync failed: ${String((syncing.error as Error)?.message ?? syncing.error)}`
    : error || (answered && !answered.ok && !answered.spaces.length ? `Sync failed: ${answered.error}` : "");
  return (
    <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
      <Text style={styles.muted} accessibilityLiveRegion="polite">
        {syncing.isPending ? "Syncing…" : text}
      </Text>
      {failure && !syncing.isPending ? (
        <Text style={[styles.muted, { color: theme.colors.statusDanger }]} numberOfLines={3}>
          {failure}
        </Text>
      ) : null}
      <Button
        label="Sync"
        ghost
        accessibilityLabel={space ? `Sync the plan of ${space} now` : "Sync every plan now"}
        disabled={syncing.isPending}
        onPress={() => syncing.mutate()}
        styles={styles}
      />
    </View>
  );
}
