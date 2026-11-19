import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { tasksSendBackRpc, uiTaskResultRpc } from "../shared/ui.ts";
import type { taskViewRpc } from "../shared/views.ts";
import { ReleaseDialog } from "./actions.tsx";
import { Button, isWebUrl, Section, type Styles } from "./common.tsx";
import { Field, useRefresh } from "./forms.tsx";

/**
 * What a task's run produced, where a person decides on it (04-ux.md, Review and close): the PR/MR
 * as the forge has it now, its changed files, checks and review, and the two answers: accept the
 * work (mark the task done) or send the agent a comment. The forge is asked when the screen opens
 * and on "Refresh", not on the task screen's poll: the query key stays outside ["dashboard"], which
 * every action invalidates.
 */

type Theme = PluginScreenProps["theme"];
type TaskView = RpcOutput<typeof taskViewRpc>;
type Result = RpcOutput<typeof uiTaskResultRpc>;

const STALE_MS = 60_000;
/** As `tasks.send-back` takes it. */
const COMMENT_MAX = 4000;

function checksText(checks: NonNullable<Result["checks"]>): string {
  switch (checks.state) {
    case "passing":
      return `✓ Checks pass (${checks.passed})`;
    case "failing":
      return `✗ Failing: ${checks.failing.join(", ")}${checks.failed > checks.failing.length ? ` and ${checks.failed - checks.failing.length} more` : ""}`;
    case "pending":
      return `… ${checks.pending} check${checks.pending === 1 ? "" : "s"} running${checks.passed ? `, ${checks.passed} passed` : ""}`;
    case "waiting":
      return "… The pipeline waits for a manual job or its schedule";
    default:
      return "No checks";
  }
}

function Link({ url, text, styles, theme }: { url: string; text: string; styles: Styles; theme: Theme }) {
  if (!isWebUrl(url)) return <Text style={styles.text}>{text}</Text>;
  return (
    <ExternalLink href={url}>
      <Text style={[styles.text, { color: theme.colors.accent }]}>{text}</Text>
    </ExternalLink>
  );
}

export function ResultSection({ view: t, onCover, styles, theme }: { view: TaskView; onCover: (covered: boolean) => void; styles: Styles; theme: Theme }) {
  const read = useRpc(uiTaskResultRpc);
  const url = t.pr?.url ?? "";
  // The status is in the key: a merge or a move reads the forge again.
  const query = useQuery({ queryKey: ["dashboard-result", t.id, url, t.status], queryFn: () => read({ task: t.id }), enabled: Boolean(t.pr), staleTime: STALE_MS });
  const [accepting, setAccepting] = useState(false);
  useEffect(() => onCover(accepting), [accepting, onCover]);
  const dialog = accepting ? <ReleaseDialog task={t.id} to="done" open onClose={() => setAccepting(false)} styles={styles} /> : null;
  // The dialog outlives the block: a task released elsewhere meanwhile still closes it.
  if (!t.pr && t.status !== "review") return dialog;
  const r = query.data;
  const pr = r?.pr && r.pr.label ? r.pr : undefined;
  // The tracker's bare "a draft" only repeats the state shown beside it.
  const note = t.pr?.note && t.pr.note !== "a draft" ? t.pr.note : "";
  return (
    <Section
      title="Result"
      styles={styles}
      trailing={t.pr ? <Button label={query.isFetching ? "Reading…" : "Refresh"} ghost disabled={query.isFetching} onPress={() => void query.refetch()} styles={styles} /> : undefined}
    >
      {!t.pr ? <Text style={styles.muted}>No PR/MR is known for this run. Read the agent's last message above, then accept the work or send it back.</Text> : null}
      {t.pr && !pr ? <Link url={t.pr.url} text={t.pr.text} styles={styles} theme={theme} /> : null}
      {pr ? (
        <View style={{ gap: 2 }}>
          <Link url={pr.url} text={`${pr.label} ${pr.title}`.trim()} styles={styles} theme={theme} />
          <Text style={styles.muted}>{[pr.state, pr.head && pr.base ? `${pr.head} → ${pr.base}` : "", note].filter(Boolean).join(" · ")}</Text>
        </View>
      ) : null}
      {query.isError ? <Text style={styles.error}>{`Could not ask the forge: ${String(query.error)}`}</Text> : null}
      {r?.error ? <Text style={styles.error}>{r.error}</Text> : null}
      {r?.changes ? (
        <View style={styles.card}>
          <Text style={styles.text}>
            {`${r.changes.files}${r.changes.at_least ? "+" : ""} file${r.changes.files === 1 && !r.changes.at_least ? "" : "s"} changed${r.changes.additions !== null && r.changes.deletions !== null ? ` · +${r.changes.additions} −${r.changes.deletions}` : ""}`}
          </Text>
          {r.changes.list.map((file) => (
            // The counts first: a long path is cut at its start, never the counts.
            <Text key={file.path} style={styles.muted} numberOfLines={1} ellipsizeMode="head">{`+${file.additions} −${file.deletions}  ${file.path}`}</Text>
          ))}
          {r.changes.more > 0 && r.changes.list.length > 0 ? <Text style={styles.muted}>{`and ${r.changes.more} more`}</Text> : null}
          {r.changes.more > 0 && r.changes.list.length === 0 ? <Text style={styles.muted}>The files are listed on the merge request's page and in the workspace.</Text> : null}
        </View>
      ) : null}
      {r?.checks ? (
        r.checks.url ? (
          <Link url={r.checks.url} text={checksText(r.checks)} styles={styles} theme={theme} />
        ) : (
          <Text style={r.checks.state === "failing" ? styles.error : styles.text}>{checksText(r.checks)}</Text>
        )
      ) : null}
      {r?.review ? <Text style={styles.text}>{`Review: ${r.review}`}</Text> : null}
      {r?.read_at && pr ? <Text style={styles.muted}>{`Read from the forge at ${new Date(r.read_at).toLocaleTimeString()}`}</Text> : null}
      {t.status === "review" && t.actions.release ? <Button label="Accept and mark done…" onPress={() => setAccepting(true)} styles={styles} /> : null}
      {t.run?.local && t.run.agentId ? <SendBack task={t.id} status={t.status} styles={styles} theme={theme} /> : null}
      {dialog}
    </Section>
  );
}

function SendBack({ task, status, styles, theme }: { task: string; status: string; styles: Styles; theme: Theme }) {
  const send = useRpc(tasksSendBackRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const long = comment.trim().length > COMMENT_MAX;
  const go = async () => {
    setBusy(true);
    try {
      const answer = await send({ task, comment: comment.trim() });
      if (!answer.ok) toast.error(answer.error);
      else {
        setComment("");
        if (answer.note) toast.error(answer.note);
        else toast.show(answer.status === "in_progress" && status === "review" ? `Sent to the agent; ${task} is in progress again` : "Sent to the agent", { variant: "success" });
      }
      refresh();
    } catch (failure) {
      toast.error(`Unknown whether it was sent: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Field label="Send back to the agent" value={comment} onChange={setComment} multiline placeholder="What to change" styles={styles} theme={theme} />
      {long ? <Text style={styles.error}>{`${comment.trim().length} of at most ${COMMENT_MAX} characters`}</Text> : null}
      <Button label={busy ? "Sending…" : status === "review" ? "Send back" : "Send to the agent"} ghost disabled={busy || !comment.trim() || long} onPress={() => void go()} styles={styles} />
    </View>
  );
}
