import { type PluginHostProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Glyph } from "../shared/map.ts";
import { RECAP_KINDS, RECAP_MAX_LIMIT, type RecapEvent, type RecapKind, recapRpc } from "../shared/recap.ts";
import { Button, Chip, ItemRow, Section, type Styles } from "./common.tsx";
import { clock } from "./events.tsx";
import { useShow } from "./nav.ts";

/**
 * The Live tab's Recap (shared/recap.ts): what happened in the plan over the last days, the same
 * answer God Mode's `recap` reads. Read from the plan's commits on the daemon, so it is asked for
 * once a minute rather than with the rest of the board.
 */

type Theme = PluginHostProps["theme"];

const DAY_MS = 24 * 60 * 60 * 1000;
// 30 rather than the 31 the daemon allows: a clock a little apart from the daemon's stays inside.
const PERIODS = [
  { days: 1, label: "24 h" },
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];
const RECAP_REFRESH_MS = 60_000;
const SHOWN = 10;

const SAID: Record<RecapKind, string> = {
  done: "done",
  merged: "merged",
  review: "to review",
  started: "started",
  blocked: "blocked",
  released: "released",
  created: "new task",
  draft: "new draft",
  status: "status",
};

const GLYPH: Record<RecapKind, Glyph> = {
  done: "done",
  merged: "done",
  review: "review",
  started: "working",
  blocked: "blocked",
  released: "todo",
  created: "todo",
  draft: "todo",
  status: "elsewhere",
};

/** What a row adds to its kind: the change, the blocker, where it started, the merged PR/MR. */
function extra(event: RecapEvent): string {
  switch (event.kind) {
    case "status":
    case "released":
    case "started":
      return event.detail;
    case "blocked":
      return event.detail.replace(/^blocked:\s*/i, "");
    case "merged":
      return event.pr;
    default:
      return "";
  }
}

export function RecapSection({ space, spaces, theme, styles }: { space: string; spaces: boolean; theme: Theme; styles: Styles }) {
  const show = useShow();
  const read = useRpc(recapRpc);
  const [days, setDays] = useState(7);
  const [all, setAll] = useState(false);
  const query = useQuery({
    queryKey: ["dashboard", "recap", space, days],
    queryFn: () => read({ since: new Date(Date.now() - days * DAY_MS).toISOString(), space: space || undefined, limit: RECAP_MAX_LIMIT }),
    refetchInterval: RECAP_REFRESH_MS,
  });
  const data = query.data;
  const events = all ? (data?.events ?? []) : (data?.events ?? []).slice(0, SHOWN);
  const counts = RECAP_KINDS.filter((kind) => data?.counts[kind]).map((kind) => `${data!.counts[kind]} ${SAID[kind]}`);
  return (
    <Section title={`Recap · ${data && !data.error ? data.total : "–"}`} styles={styles}>
      <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
        {PERIODS.map((period) => (
          <Chip
            key={period.days}
            label={period.label}
            accessibilityLabel={`Recap of the last ${period.label}`}
            active={days === period.days}
            onPress={() => {
              setDays(period.days);
              setAll(false);
            }}
            styles={styles}
          />
        ))}
      </View>
      {query.isError ? <Text style={styles.error}>{`Could not read: ${String(query.error)}`}</Text> : null}
      {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}
      {data?.partial ? <Text style={styles.muted}>{`Not complete: ${data.partial}`}</Text> : null}
      {data && !data.error && !data.total ? <Text style={styles.muted}>Nothing changed in the plan in this period.</Text> : null}
      {counts.length ? <Text style={styles.text}>{counts.join(" · ")}</Text> : null}
      {events.map((event, i) => (
        <ItemRow
          key={`${event.at}:${event.task_id}:${event.kind}:${i}`}
          glyph={GLYPH[event.kind]}
          space={spaces ? event.space : undefined}
          title={event.title || event.task_id}
          note={[SAID[event.kind], event.by, clock(event.at), extra(event), event.by_hand ? "by hand" : ""].filter(Boolean).join(" · ")}
          onPress={() => show.task(event.task_id, { title: event.title })}
          theme={theme}
          styles={styles}
        />
      ))}
      {data && data.events.length > SHOWN ? (
        <Button label={all ? "Show fewer" : `Show all ${data.events.length}`} ghost onPress={() => setAll(!all)} styles={styles} />
      ) : null}
      {data?.more && (all || data.events.length <= SHOWN) ? (
        <Text style={styles.muted}>{`${data.total - data.events.length} more not listed: pick a shorter period.`}</Text>
      ) : null}
    </Section>
  );
}
