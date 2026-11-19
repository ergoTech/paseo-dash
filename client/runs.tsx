import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Markdown } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { taskRunsRpc } from "../shared/views.ts";
import { Button, isWebUrl, REFRESH_MS, Section, type Styles } from "./common.tsx";

/**
 * The task's earlier runs (04-ux.md, Surfaces): every run the plan's commits know except the live one,
 * which the Run section shows, newest first. A run this machine started leads to its agent in Paseo;
 * another machine's run says where its agent is.
 */
export function EarlierRuns({
  task,
  styles,
  theme,
  navigation,
  inWorkspace,
  handoffAbove,
}: {
  task: string;
  /** The run whose handoff the screen already shows as the task's latest one. */
  handoffAbove?: string;
  styles: Styles;
  theme: PluginScreenProps["theme"];
  navigation: PluginScreenProps["navigation"];
  inWorkspace?: boolean;
}) {
  const read = useRpc(taskRunsRpc);
  const query = useQuery({ queryKey: ["dashboard", "task-runs", task], queryFn: () => read({ task }), refetchInterval: REFRESH_MS, enabled: Boolean(task) });
  const answer = query.data;
  const runs = answer?.runs.filter((run) => !run.live) ?? [];
  const error = query.isError ? `Could not read the earlier runs: ${String(query.error)}` : answer?.found ? answer.error : "";
  if (!runs.length && !error) return null;
  return (
    <Section title={`Earlier runs · ${runs.length}`} styles={styles}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {runs.map((run) => (
        <View key={run.id} style={[styles.card, { gap: 4 }]}>
          <Text style={styles.text}>{run.result}</Text>
          <Text style={styles.muted}>{[`${run.by || "someone"} on ${run.host || "an unknown machine"}`, run.branch, run.id].filter(Boolean).join(" · ")}</Text>
          <Text style={styles.muted}>{run.ended ? `${run.started} → ${run.ended}` : `started ${run.started}`}</Text>
          {run.pr ? (
            isWebUrl(run.pr) ? (
              <ExternalLink href={run.pr}>
                <Text style={[styles.text, { color: theme.colors.accent }]} numberOfLines={1}>
                  {run.pr}
                </Text>
              </ExternalLink>
            ) : (
              <Text style={styles.text} numberOfLines={1}>
                {run.pr}
              </Text>
            )
          ) : (
            <Text style={styles.muted}>No PR/MR recorded</Text>
          )}
          {run.progress ? <Text style={styles.text}>{run.progress}</Text> : null}
          {run.handoff && run.id === handoffAbove ? (
            <Text style={styles.muted}>Its handoff is the one shown above.</Text>
          ) : run.handoff ? (
            <>
              <Text style={styles.muted}>{`Handoff, ${run.handoff.at}`}</Text>
              <Markdown>{run.handoff.text}</Markdown>
            </>
          ) : null}
          {run.local ? (
            <>
              {run.local.lastMessage ? (
                <>
                  <Text style={styles.muted}>Latest from the agent</Text>
                  <Text style={styles.text}>{run.local.lastMessage}</Text>
                </>
              ) : null}
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {run.local.agentId && navigation ? <Button label="Open chat" ghost onPress={() => navigation.openAgent({ agentId: run.local!.agentId })} styles={styles} /> : null}
                {run.local.workspaceId && navigation && !inWorkspace ? (
                  <Button label="Open workspace" ghost onPress={() => navigation.openWorkspace({ workspaceId: run.local!.workspaceId })} styles={styles} />
                ) : null}
              </View>
              {!run.local.agentId ? <Text style={styles.muted}>Started on this Mac, but no agent was made for it.</Text> : null}
            </>
          ) : (
            <Text style={styles.muted}>{run.elsewhere}</Text>
          )}
        </View>
      ))}
    </Section>
  );
}
