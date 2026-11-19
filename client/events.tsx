import { type PluginHostProps, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { spaceOfId } from "../shared/across.ts";
import { eventsListRpc, eventsSeenRpc, type TaskEvent } from "../shared/events.ts";
import type { Glyph } from "../shared/map.ts";
import { Button, ItemRow, REFRESH_MS, Section, type Styles } from "./common.tsx";
import { useRefresh } from "./forms.tsx";
import { useShow } from "./nav.ts";
import { PLUGIN_NAME } from "../shared/edition.ts";

/** Task events (shared/events.ts): the Live tab's list, and a toast for each new one while the app is open. */

const GLYPH: Record<TaskEvent["kind"], Glyph> = { finished: "done", failed: "failed", needs_input: "needs_you", question: "needs_you" };
const SAID: Record<TaskEvent["kind"], string> = { finished: "finished its turn", failed: "failed", needs_input: "needs you", question: "asks you" };
const SHOWN = 20;

type Theme = PluginHostProps["theme"];

export function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function eventText(event: TaskEvent): string {
  return `${event.title} ${SAID[event.kind]}${event.summary ? `: ${event.summary}` : ""}`;
}

/**
 * The latest events, the unread ones marked; "Mark read" marks read every event up to the newest.
 * "Open chat" opens the event's agent, on hosts that give the plugin navigation.
 */
export function EventsSection({ space, spaces, theme, styles, navigation }: {
  space: string;
  spaces: boolean;
  theme: Theme;
  styles: Styles;
  navigation: PluginScreenProps["navigation"];
}) {
  const show = useShow();
  const refresh = useRefresh();
  const read = useRpc(eventsListRpc);
  const seen = useRpc(eventsSeenRpc);
  // Unread ones only, unless asked: what Needs you lists above is mostly the same news. Both views
  // read the latest events, newest first, so "Mark read" marks through the newest one.
  const [history, setHistory] = useState(false);
  const query = useQuery({
    queryKey: ["dashboard", "events", space],
    queryFn: () => read({ space: space || undefined, history: true, limit: SHOWN }),
    refetchInterval: REFRESH_MS,
  });
  const data = query.data;
  const marking = useMutation({ mutationFn: (through: number) => seen({ through, space: space || undefined }), onSettled: refresh });
  const newest = data?.events[0]?.id ?? 0;
  const events = (data?.events ?? []).filter((event) => history || event.unread);
  const unseen = history ? 0 : (data?.unread ?? 0) - events.length;
  return (
    <Section
      title={`Events · ${data ? `${data.unread} unread` : "–"}`}
      styles={styles}
      trailing={
        <View style={[styles.row, { gap: 4 }]}>
          {data?.unread ? <Button label="Mark read" ghost onPress={() => marking.mutate(newest)} disabled={marking.isPending} styles={styles} /> : null}
          <Button label={history ? "Unread only" : "Earlier"} ghost onPress={() => setHistory(!history)} styles={styles} />
        </View>
      }
    >
      {query.isError ? <Text style={styles.error}>{`Could not read: ${String(query.error)}`}</Text> : null}
      {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}
      {marking.data?.error ? <Text style={styles.error}>{marking.data.error}</Text> : null}
      {data && !events.length ? <Text style={styles.muted}>{history ? "No task has finished, failed or asked for you yet." : "Nothing unread."}</Text> : null}
      {events.map((event) => (
        <View key={event.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <ItemRow
              glyph={GLYPH[event.kind]}
              space={spaces ? spaceOfId(event.task_id) : undefined}
              title={`${event.unread ? "● " : ""}${event.title}`}
              note={[`${SAID[event.kind]} ${clock(event.at)}`, event.summary].filter(Boolean).join(" · ")}
              onPress={() => show.task(event.task_id, { title: event.title })}
              theme={theme}
              styles={styles}
            />
          </View>
          {event.chat_id && navigation ? <Button label="Open chat" ghost onPress={() => navigation.openAgent({ agentId: event.chat_id })} styles={styles} /> : null}
        </View>
      ))}
      {unseen > 0 ? <Text style={styles.muted}>{`${unseen} older unread not shown; "Mark read" marks them read too.`}</Text> : null}
    </Section>
  );
}

/**
 * A toast for each event made while this client watches: `latest` is the overview's newest event id.
 * The first answer only sets the mark, so opening the app does not replay old events (they wait
 * unread in the Live tab); a client that lost its connection catches up from its mark once back.
 */
export function useEventToasts(latest: number | undefined, answeredAt: number) {
  const toast = useToast();
  const read = useRpc(eventsListRpc);
  const mark = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => {
    if (latest === undefined) return;
    if (mark.current === undefined || latest < mark.current) {
      // First answer, or a fresh events file on the daemon: start from here.
      mark.current = latest;
      return;
    }
    if (latest === mark.current || busy.current) return;
    busy.current = true;
    const after = mark.current;
    read({ after, limit: 5 })
      .then((answer) => {
        if (answer.error) return;
        for (const event of answer.events) toast.show(eventText(event), { variant: event.kind === "finished" ? "success" : event.kind === "failed" ? "error" : "warning" });
        if (answer.more) toast.show(`More task events: see ${PLUGIN_NAME} → Live`, { variant: "info" });
        mark.current = Math.max(after, answer.latest);
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
    // answeredAt: a read that failed is tried again with the next overview answer.
  }, [latest, answeredAt, read, toast]);
}
