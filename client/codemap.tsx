import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { codeTree, type TreeRow } from "../shared/codemap.ts";
import { LIVE_GLOW_MS } from "../shared/live.ts";
import { taskCodeMapRpc } from "../shared/views.ts";
import { REFRESH_MS, Section, type Styles } from "./common.tsx";

const MARK: Record<TreeRow["state"], string> = { changed: "✓", read: "◉", linked: "·" };

/**
 * The files the task's run changed or read and how they import each other (server/tracker/codemap.ts),
 * while this machine follows the run: each file under the files that import it. A file the agent
 * touched in the last seconds is in the accent color, as on the map.
 */
export function CodeMapSection({ task, styles, theme }: { task: string; styles: Styles; theme: PluginScreenProps["theme"] }) {
  const read = useRpc(taskCodeMapRpc);
  const query = useQuery({ queryKey: ["dashboard", "task-codemap", task], queryFn: () => read({ task }), refetchInterval: REFRESH_MS, enabled: Boolean(task) });
  const [clock, setClock] = useState(() => Date.now());
  const answer = query.data;
  const fresh = (row: TreeRow) => Boolean(row.at) && clock - Date.parse(row.at) < LIVE_GLOW_MS;
  const tree = answer?.followed ? codeTree(answer.nodes) : { rows: [], cut: false };
  const glowing = tree.rows.some(fresh);
  useEffect(() => {
    if (!glowing) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [glowing]);
  // A new answer may hold a file just touched.
  useEffect(() => setClock(Date.now()), [answer]);
  if (!answer?.followed && !answer?.error) return null;
  const c = theme.colors;
  const files = answer.nodes.length + answer.more;
  return (
    <Section title={`Code map · ${files} file${files === 1 ? "" : "s"}`} styles={styles}>
      {answer.error ? <Text style={styles.error}>{answer.error}</Text> : null}
      {tree.rows.map((row, i) => {
        const now = fresh(row);
        const color = now ? c.accent : row.state === "changed" ? c.foreground : c.foregroundMuted;
        const mark = now ? (row.state === "read" ? "◉" : "✎") : MARK[row.state];
        return (
          <View
            key={`${i}:${row.path}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: row.depth * 14 }}
            accessible
            accessibilityLabel={`${row.path}, ${row.again ? "shown above" : row.state}${row.parent ? `, imported by ${row.parent}` : ""}`}
          >
            <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 16 }}>{row.depth ? "└" : ""}</Text>
            <Text style={{ color, fontSize: 12, width: 14, textAlign: "center" }}>{mark}</Text>
            <Text style={{ color, fontSize: 13, flexShrink: 1, fontWeight: row.state === "changed" && !row.again ? "600" : "400" }} numberOfLines={1} ellipsizeMode="middle">
              {row.path}
            </Text>
            {row.again ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>shown above</Text> : null}
          </View>
        );
      })}
      {tree.cut || answer.more ? (
        <Text style={styles.muted}>{`Not all shown${answer.more ? `: ${answer.more} more file${answer.more === 1 ? "" : "s"}` : ""}.`}</Text>
      ) : null}
      {answer.followed && !answer.nodes.length ? <Text style={styles.muted}>No file changed or read yet.</Text> : null}
      <Text style={styles.muted}>✓ changed   ◉ read   · imported by a changed file   ✎ just now</Text>
    </Section>
  );
}
