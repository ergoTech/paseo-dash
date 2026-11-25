import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { DeliverySection } from "./delivery.tsx";
import { ExternalLink, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { tasksContinueRpc, tasksSeenRpc } from "../shared/ui.ts";
import { taskViewRpc } from "../shared/views.ts";
import { ArchiveTasksDialog, ArchiveWorkspaceDialog, MergeDialog, MoveDialog, ReleaseDialog, type ReleaseTo, StartDialog, StatusDialog, usePrefetchStart } from "./actions.tsx";
import { useChanges } from "./changes.ts";
import { Button, isWebUrl, ItemRow, Mark, REFRESH_MS, Section, type Styles, useStyles } from "./common.tsx";
import { TaskForm, useRefresh } from "./forms.tsx";
import { GLYPH_LABEL } from "./glyphs.ts";
import { LabelChips } from "./labels.tsx";
import { LiveLine } from "./live.tsx";
import { TopBar } from "./topbar.tsx";
import { ResultSection } from "./result.tsx";
import { EarlierRuns } from "./runs.tsx";
import { CodeMapSection } from "./codemap.tsx";
import type { ScreenLocation } from "./history.ts";
import { useArrival, useShow } from "./nav.ts";
import { RankButtons } from "./rank.tsx";
import { AutopilotToggle } from "./queue.tsx";

/**
 * One task (04-ux.md, Surfaces): what it is, where its run is, what its agent said last, its PR/MR,
 * the brief and the acceptance list, its earlier runs, and what can be done with it from here.
 */
export function TaskScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  useChanges();
  const id = params.task ?? "";
  useArrival("task", params);
  // The same query TaskDetail reads (one cache entry): the title for "‹ Back" and the parent.
  const read = useRpc(taskViewRpc);
  const t = useQuery({ queryKey: ["dashboard", "task", id], queryFn: () => read({ task: id }), refetchInterval: REFRESH_MS, enabled: Boolean(id) }).data;
  const parent: ScreenLocation | undefined = !t?.found
    ? undefined
    : t.feature
      ? { screenId: "feature", params: { feature: t.feature.id }, title: t.feature.title }
      : { screenId: "space", params: { space: t.space, tab: layout.compact ? "lines" : "board" }, title: layout.compact ? "Lines" : "Board" };
  const here: ScreenLocation = { screenId: "task", params: { task: id }, title: t?.title || id };
  const styles = useStyles(theme, layout.compact);
  const header = (
    <TopBar
      here={here}
      fallback={parent}
      space={t?.found ? t.space : ""}
      theme={theme}
      styles={styles}
      compact={layout.compact}
      needs
      remember={t?.found ? { kind: "task", id: t.id, title: t.title, space: t.space } : undefined}
    />
  );
  return (
    <TaskDetail
      id={id}
      action={params.action ? `${params.action}:${params.ask ?? ""}` : undefined}
      theme={theme}
      compact={layout.compact}
      navigation={navigation}
      here={here}
      header={header}
    />
  );
}

/**
 * The task screen's content, also shown by the workspace panel "Task". `action: "done"` opens the
 * "Mark done" confirmation once, for the Command Center item and `/task done`; `action: "move"` opens
 * "Move…" once, for the Command Center item "Move this task".
 */
export function TaskDetail({
  id,
  action,
  theme,
  compact,
  navigation,
  inWorkspace,
  here,
  header,
}: {
  id: string;
  /** `done:<request id>` or `move:<request id>`: each request opens its dialog once. */
  action?: string;
  /** Shown inside the task's own workspace, which needs no "Open workspace". */
  inWorkspace?: boolean;
  /** The task screen's own location, so screens opened from here lead back to it; none in the panel. */
  here?: ScreenLocation;
  /** Above the task: the screen's top bar ("‹ Back" and the search). */
  header?: ReactNode;
  theme: PluginScreenProps["theme"];
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
}) {
  const styles = useStyles(theme, compact);
  const show = useShow(here);
  const read = useRpc(taskViewRpc);
  const query = useQuery({ queryKey: ["dashboard", "task", id], queryFn: () => read({ task: id }), refetchInterval: REFRESH_MS, enabled: Boolean(id) });
  const t = query.data;
  // Showing the brief, acceptance, clarifications and handoff is what "seen" means (05-architecture.md, Security):
  // mark each version once, and only as the server still has it. Not while a dialog covers the
  // screen: a version the poll brings in then is not on view, and the start confirmation must still
  // show it.
  const [covered, setCovered] = useState(false);
  const markSeen = useRpc(tasksSeenRpc);
  const prefetchStart = usePrefetchStart();
  const marked = useRef("");
  useEffect(() => {
    if (covered || !t?.found || !t.instructions_hash || marked.current === t.instructions_hash) return;
    marked.current = t.instructions_hash;
    // A task that can start has its start facts read ahead, once these instructions count as seen,
    // so the confirmation opens with them and does not call them new.
    const startable = t.status === "todo" && !t.actions.start;
    void markSeen({ task: t.id, hash: t.instructions_hash })
      .then(() => (startable ? prefetchStart(t.id) : undefined))
      .catch(() => {
        marked.current = "";
      });
  }, [covered, t?.found, t?.id, t?.instructions_hash, t?.status, t?.actions.start, markSeen, prefetchStart]);
  return (
    // "handled": with a phone's keyboard up, a tap on a search result opens it rather than only closing the keyboard.
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {header}
      {query.isError ? <Text style={styles.error}>{`Could not read the task: ${String(query.error)}`}</Text> : null}
      {t?.error ? <Text style={styles.error}>{t.error}</Text> : null}
      {t?.found ? (
        <>
          <View style={styles.row}>
            <Mark glyph={t.glyph} theme={theme} size={18} />
            <Text accessibilityRole="header" style={[styles.title, { flex: 1 }]}>
              {t.title}
            </Text>
          </View>
          <Text style={styles.muted}>
            {[t.id, `${t.status} (${GLYPH_LABEL[t.glyph]})`, t.project, t.feature?.title, t.milestone?.title, t.priority, t.assignee].filter(Boolean).join(" · ")}
          </Text>
          <LabelChips labels={t.labels} theme={theme} />
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {t.run?.agentId && navigation ? <Button label="Open chat" onPress={() => navigation.openAgent({ agentId: t.run!.agentId })} styles={styles} /> : null}
            {t.run?.workspaceId && navigation && !inWorkspace ? <Button label="Open workspace" ghost onPress={() => navigation.openWorkspace({ workspaceId: t.run!.workspaceId })} styles={styles} /> : null}
            {t.feature ? <Button label="Feature" ghost onPress={() => show.feature(t.feature!.id, t.feature!.title)} styles={styles} /> : null}
          </View>
          <TaskActions view={t} action={action} onCover={setCovered} onOpenTask={(task) => show.task(task)} styles={styles} theme={theme} />
          {t.run ? (
            <Section title="Run" styles={styles}>
              <Text style={styles.text}>{t.run.activity || `held by ${t.run.by} on ${t.run.host}`}</Text>
              {t.wait && t.wait.state !== "working" && t.wait.state !== "launching" ? (
                <Text style={styles.muted}>{`${t.wait.state.replace(/_/g, " ")}${t.wait.note ? `: ${t.wait.note}` : ""}`}</Text>
              ) : null}
              <Text style={styles.muted}>{`${t.run.by} on ${t.run.host} since ${t.run.since} · ${t.run.branch}`}</Text>
              {t.run.settings ? <Text style={styles.muted}>{t.run.settings}</Text> : null}
              {t.run.live ? <LiveRun live={t.run.live} styles={styles} theme={theme} /> : null}
              {t.progress ? <Text style={styles.text}>{t.progress}</Text> : null}
              {t.run.tracked?.landed ? <Text style={styles.text}>{`${t.run.tracked.landed}${t.run.tracked.archived ? " · workspace archived" : ""}`}</Text> : null}
              {t.run.tracked ? <Text style={styles.muted}>{t.run.tracked.note}</Text> : null}
              {t.run.lastMessage ? (
                <View style={styles.card}>
                  <Text style={styles.muted}>Latest from the agent</Text>
                  <Text style={styles.text}>{t.run.lastMessage}</Text>
                </View>
              ) : null}
            </Section>
          ) : t.progress ? (
            <Text style={styles.text}>{t.progress}</Text>
          ) : null}
          <ResultSection key={t.id} view={t} onCover={setCovered} styles={styles} theme={theme} />
          {t.hold || t.requires.length || t.readiness ? (
            <Section title="Before an agent takes it" styles={styles}>
              {t.hold ? <Text style={styles.text}>{`Nothing starts it on its own: ${t.hold}`}</Text> : null}
              {t.requires.map((r) => (
                <Text key={r} style={styles.muted}>{`Requires ${r}`}</Text>
              ))}
              <Text style={styles.muted}>{t.readiness ? `Checked ${t.readiness}` : "Nobody has checked yet that it can start as it is."}</Text>
            </Section>
          ) : null}
          {t.delivery ? <DeliverySection task={t.id} styles={styles} theme={theme} /> : null}
          <Section title="Brief" styles={styles}>
            {t.brief ? <Markdown>{t.brief}</Markdown> : <Text style={styles.muted}>No brief yet.</Text>}
          </Section>
          <Section title={`Acceptance · ${t.acceptance.filter((a) => a.done).length}/${t.acceptance.length}`} styles={styles}>
            {t.acceptance.length ? null : <Text style={styles.muted}>No acceptance lines.</Text>}
            {t.acceptance.map((a, i) => (
              <Text key={`${i}:${a.text}`} style={styles.text}>{`${a.done ? "☑" : "☐"} ${a.text}`}</Text>
            ))}
          </Section>
          {t.clarifications ? (
            <Section title="Clarifications" styles={styles}>
              <Text style={styles.muted}>Given when starting the task; agents follow them where they disagree with the brief or acceptance</Text>
              <Markdown>{t.clarifications}</Markdown>
            </Section>
          ) : null}
          {t.handoff ? (
            <Section title="Handoff" styles={styles}>
              <Text style={styles.muted}>{t.handoff.run ? `Left by run ${t.handoff.run} at ${t.handoff.at}; the next run's agent gets it` : "The next run's agent gets it"}</Text>
              <Markdown>{t.handoff.text}</Markdown>
            </Section>
          ) : null}
          {t.run?.live ? <CodeMapSection task={t.id} styles={styles} theme={theme} /> : null}
          <EarlierRuns task={t.id} handoffAbove={t.handoff?.run} styles={styles} theme={theme} navigation={navigation} inWorkspace={inWorkspace} />
          {t.dependencies.length ? (
            <Section title="Waits for" styles={styles}>
              {t.dependencies.map((d) => (
                <ItemRow key={d.id} glyph={d.status === "done" ? "done" : "blocked"} title={d.title} note={`${d.id} · ${d.status}`} onPress={() => show.task(d.id, { title: d.title })} theme={theme} styles={styles} />
              ))}
            </Section>
          ) : null}
          {t.issue ? (
            <Section title="Issue" styles={styles}>
              {isWebUrl(t.issue.url) ? (
                <ExternalLink href={t.issue.url}>
                  <Text style={[styles.text, { color: theme.colors.accent }]} numberOfLines={1}>
                    {t.issue.label}
                  </Text>
                </ExternalLink>
              ) : (
                <Text style={styles.text} numberOfLines={1}>
                  {t.issue.label}
                </Text>
              )}
              <Text style={styles.muted}>{t.issue.state === "unknown" ? "State unknown until the forge answers" : `On the forge: ${t.issue.state}`}</Text>
              {t.issue.note ? <Text style={styles.text}>{t.issue.note}</Text> : null}
            </Section>
          ) : null}
          {t.meeting || t.links.length ? (
            <Section title="Links" styles={styles}>
              {t.meeting ? (
                isWebUrl(t.meeting) ? (
                  <ExternalLink href={t.meeting}>
                    <Text style={[styles.text, { color: theme.colors.accent }]}>{t.meeting_title || t.meeting}</Text>
                  </ExternalLink>
                ) : (
                  <Text style={styles.text}>{t.meeting_title || t.meeting}</Text>
                )
              ) : null}
              {t.links.map((l, i) =>
                isWebUrl(l) ? (
                  <ExternalLink key={`${i}:${l}`} href={l}>
                    <Text style={[styles.text, { color: theme.colors.accent }]} numberOfLines={1}>
                      {l}
                    </Text>
                  </ExternalLink>
                ) : (
                  <Text key={`${i}:${l}`} style={styles.text} numberOfLines={1}>
                    {l}
                  </Text>
                ),
              )}
            </Section>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

type TaskView = RpcOutput<typeof taskViewRpc>;
type Dialog =
  | { kind: "start" }
  | { kind: "release"; to: ReleaseTo }
  | { kind: "status"; to: "todo" | "done" | "canceled"; label: string; note: string; accept?: boolean }
  | { kind: "edit"; accept: boolean }
  | { kind: "merge" }
  | { kind: "move" }
  | { kind: "archive" }
  | { kind: "archive-task"; archived: boolean };

/**
 * The task's actions (04-ux.md, Main flows), as the server says they apply from this machine: a
 * draft is accepted, merged or rejected; a todo task starts, or is marked done or canceled; a task a
 * live run holds is released with a confirmation naming who holds it; a task in review continues on
 * its run's own machine; a finished one reopens. An open task moves to another release, feature or,
 * until it is first started, another line. A task that never ran whose work was merged outside the
 * dashboard says so first, with "Mark done" (a draft is accepted on the way). A task in progress that
 * no live run holds (unheld: set outside the dashboard) is closed, put back to todo or started again by
 * the person, with its merged work shown the same way. A finished task is archived off the board.
 */
function TaskActions({
  view: t,
  action,
  onCover,
  onOpenTask,
  styles,
  theme,
}: {
  view: TaskView;
  /** `done:<request id>` or `move:<request id>`: open that dialog once per request, once the task is read. */
  action?: string;
  /** Whether a dialog covers the task screen. */
  onCover: (covered: boolean) => void;
  /** Opens another task's screen: one this task waits for. */
  onOpenTask: (id: string) => void;
  styles: Styles;
  theme: PluginScreenProps["theme"];
}) {
  const [dialog, setDialog] = useState<Dialog | undefined>();
  useEffect(() => onCover(Boolean(dialog)), [dialog, onCover]);
  // Per task and request: a reused screen with another task or a new request asks again.
  const asked = useRef("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const request = `${t.id}:${action ?? ""}`;
    if (!(action?.startsWith("done:") || action?.startsWith("move:")) || asked.current === request) return;
    asked.current = request;
    setNotice("");
    if (action.startsWith("move:")) {
      if (t.status !== "done" && t.status !== "canceled") setDialog({ kind: "move" });
      else setNotice(`${t.id} is ${t.status}; reopen it first to move it.`);
    } else if (t.actions.release) setDialog({ kind: "release", to: "done" });
    else if (t.actions.close) setDialog({ kind: "status", to: "done", label: "Mark done", note: "The task is marked done without a run." });
    else setNotice(`${t.id} cannot be marked done from here: it is ${t.status}${t.status === "inbox" ? "; accept it first" : ""}.`);
  }, [action, t.id, t.status, t.actions.release, t.actions.close]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const refresh = useRefresh();
  const cont = useRpc(tasksContinueRpc);
  const a = t.actions;
  const close = () => setDialog(undefined);
  const continueWork = async () => {
    setBusy(true);
    try {
      const answer = await cont({ task: t.id });
      if (answer.ok) toast.show(`${answer.id} is in progress again`, { variant: "success" });
      else toast.error(answer.error);
      refresh();
    } catch (failure) {
      toast.error(`Unknown whether it changed: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  const draft = {
    id: t.id,
    title: t.title,
    brief: t.brief,
    project: t.project,
    feature: t.feature?.id ?? "",
    milestone: t.own_milestone,
    priority: t.priority,
    assignee: t.assignee,
    labels: t.labels.map((l) => l.name),
    depends: t.dependencies.map((d) => ({ id: d.id, title: d.title })),
    line: a.line,
  };
  const editable = t.status !== "done" && t.status !== "canceled";
  const merged = t.merged.length > 0;
  const markMerged = () =>
    setDialog({
      kind: "status",
      to: "done",
      label: "Mark done",
      note: `${t.status === "inbox" ? "The draft is accepted and marked done" : "The task is marked done"} without a run: its work is merged already (${t.merged.map((pr) => pr.label).join(", ")}).`,
      accept: t.status === "inbox",
    });
  return (
    <View style={{ gap: 6 }}>
      {merged ? (
        <View style={[styles.card, { gap: 4 }]}>
          <View style={[styles.row, { flexWrap: "wrap", gap: 4 }]}>
            <Text style={styles.text}>✓ Work already merged:</Text>
            {t.merged.map((pr) =>
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
          <Text style={styles.muted}>Merged after the task was created, by work no run of this task did. Its status changes only when you mark it done.</Text>
        </View>
      ) : null}
      {a.unheld ? (
        <Text style={styles.muted}>
          {`In progress, but no run of this dashboard holds it: a session outside the dashboard or an edit of the plan set the status, so nothing moves it by itself. Mark it done, put it back to todo, cancel it, or start a new run.`}
        </Text>
      ) : null}
      {t.archived ? <Text style={styles.muted}>{`Archived ${t.archived}: off the board, still in the plan. The board's Archived filter lists it.`}</Text> : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {a.triage && merged ? <Button label="Mark done…" onPress={markMerged} styles={styles} /> : null}
        {a.triage ? (
          <>
            <Button label="Accept…" ghost={merged} onPress={() => setDialog({ kind: "edit", accept: true })} styles={styles} />
            <Button label="Merge into…" ghost onPress={() => setDialog({ kind: "merge" })} styles={styles} />
            <Button
              label="Reject"
              ghost
              onPress={() => setDialog({ kind: "status", to: "canceled", label: "Reject draft", note: "The draft is canceled; its file stays in the plan." })}
              styles={styles}
            />
          </>
        ) : null}
        {t.status === "todo" || a.unheld ? <Button label="Start…" ghost={merged || a.unheld} disabled={Boolean(a.start)} onPress={() => setDialog({ kind: "start" })} styles={styles} /> : null}
        {a.continue ? <Button label="Continue work" disabled={busy} onPress={() => void continueWork()} styles={styles} /> : null}
        {a.release ? (
          <>
            <Button label={a.landed_done ? "Landed: mark done…" : "Mark done…"} ghost={!a.landed_done} onPress={() => setDialog({ kind: "release", to: "done" })} styles={styles} />
            <Button label="Back to todo…" ghost onPress={() => setDialog({ kind: "release", to: "todo" })} styles={styles} />
            <Button label="Cancel…" ghost onPress={() => setDialog({ kind: "release", to: "canceled" })} styles={styles} />
          </>
        ) : null}
        {a.close ? (
          <>
            {merged ? (
              <Button label="Mark done…" onPress={markMerged} styles={styles} />
            ) : (
              <Button label="Mark done…" ghost onPress={() => setDialog({ kind: "status", to: "done", label: "Mark done", note: "The task is marked done without a run." })} styles={styles} />
            )}
            {a.unheld ? (
              <Button
                label="Back to todo…"
                ghost
                onPress={() => setDialog({ kind: "status", to: "todo", label: "Back to todo", note: `The task goes back to todo from ${t.status}; no run held it, so nothing is stopped.` })}
                styles={styles}
              />
            ) : null}
            <Button label="Cancel…" ghost onPress={() => setDialog({ kind: "status", to: "canceled", label: "Cancel task", note: "The task is canceled; its file stays in the plan." })} styles={styles} />
          </>
        ) : null}
        {a.reopen ? (
          <Button label="Reopen…" ghost onPress={() => setDialog({ kind: "status", to: "todo", label: "Reopen", note: "The task goes back to todo; its earlier run stays as history." })} styles={styles} />
        ) : null}
        {editable && !a.triage ? <Button label="Edit…" ghost onPress={() => setDialog({ kind: "edit", accept: false })} styles={styles} /> : null}
        {editable ? <Button label="Move…" ghost onPress={() => setDialog({ kind: "move" })} styles={styles} /> : null}
        {/* Its place among the tasks of its priority waiting to start (D21). */}
        {(t.status === "todo" && !t.run) || t.status === "inbox" ? <RankButtons task={t.id} styles={styles} /> : null}
        {a.archive_task ? <Button label="Archive" ghost onPress={() => setDialog({ kind: "archive-task", archived: true })} styles={styles} /> : null}
        {a.unarchive ? <Button label="Unarchive" ghost onPress={() => setDialog({ kind: "archive-task", archived: false })} styles={styles} /> : null}
        {a.archive ? <Button label="Archive workspace…" ghost onPress={() => setDialog({ kind: "archive" })} styles={styles} /> : null}
      </View>
      {t.status === "todo" && !t.run ? <AutopilotToggle space={t.space} task={t.id} styles={styles} theme={theme} /> : null}
      {notice ? <Text style={styles.muted}>{notice}</Text> : null}
      {(t.status === "todo" || a.unheld) && a.start ? <Text style={styles.muted}>{`Cannot start from here: ${a.start}.`}</Text> : null}
      {(t.status === "todo" || a.unheld) && !a.start && a.blocked_by.length ? (
        <Text style={styles.muted}>
          {"⊘ Waits for "}
          {t.dependencies
            .filter((d) => d.status !== "done")
            .map((d, i) => (
              <Text key={d.id}>
                {i ? "; " : ""}
                <Text accessibilityRole="link" onPress={() => onOpenTask(d.id)} style={{ color: theme.colors.accent }}>{`${d.id} «${d.title}» (${d.status})`}</Text>
              </Text>
            ))}
        </Text>
      ) : null}

      {dialog?.kind === "start" ? <StartDialog task={t.id} title={t.title} open onClose={close} onOpenTask={onOpenTask} styles={styles} theme={theme} /> : null}
      {dialog?.kind === "release" ? <ReleaseDialog task={t.id} to={dialog.to} open onClose={close} styles={styles} /> : null}
      {dialog?.kind === "status" ? <StatusDialog task={t.id} title={t.title} to={dialog.to} label={dialog.label} note={dialog.note} accept={dialog.accept} open onClose={close} styles={styles} /> : null}
      {dialog?.kind === "archive" ? <ArchiveWorkspaceDialog task={t.id} title={t.title} open onClose={close} styles={styles} /> : null}
      {dialog?.kind === "archive-task" ? <ArchiveTasksDialog tasks={[t.id]} title={t.title} archived={dialog.archived} open onClose={close} styles={styles} /> : null}
      {dialog?.kind === "merge" ? <MergeDialog space={t.space} task={t.id} title={t.title} open onClose={close} styles={styles} theme={theme} /> : null}
      {dialog?.kind === "move" ? (
        <MoveDialog
          space={t.space}
          task={t.id}
          title={t.title}
          place={{ project: t.project, feature: t.own_feature, milestone: t.own_milestone }}
          line={a.line}
          open
          onClose={close}
          styles={styles}
        />
      ) : null}
      {dialog?.kind === "edit" ? <TaskForm space={t.space} initial={{ ...draft, accept: dialog.accept }} open onClose={close} styles={styles} theme={theme} /> : null}
    </View>
  );
}

/** Files a run lists before "and N more". */
const CHANGED_SHOWN = 12;

/**
 * What the run's agent does now and what the run changed, while this machine follows it
 * (server/tracker/follow.ts): git's answer at the last turn's end, plus the edits since.
 */
function LiveRun({ live, styles, theme }: { live: NonNullable<NonNullable<TaskView["run"]>["live"]>; styles: Styles; theme: PluginScreenProps["theme"] }) {
  const rest = Math.max(0, live.changed.length - CHANGED_SHOWN) + live.more;
  return (
    <View style={{ gap: 2 }}>
      {live.now ? <LiveLine now={live.now} style={styles.text} accent={theme.colors.accent} muted={theme.colors.foreground} /> : null}
      {live.overlaps.length ? (
        <View style={{ gap: 2 }}>
          <Text style={[styles.text, { color: theme.colors.statusDanger }]}>⚠ Another task here changes the same files: a merge conflict in the making</Text>
          {live.overlaps.map((overlap) => (
            <Text key={overlap.task} style={styles.text} numberOfLines={2}>
              {`${overlap.task}: ${overlap.files.join(", ")}${overlap.more ? ` and ${overlap.more} more` : ""}`}
            </Text>
          ))}
        </View>
      ) : null}
      {live.changed.length ? (
        <>
          <Text style={styles.muted}>{`Changed · ${live.changed.length + live.more}`}</Text>
          {live.changed.slice(0, CHANGED_SHOWN).map((path) => (
            <Text key={path} style={styles.text} numberOfLines={1} ellipsizeMode="middle">
              {path}
            </Text>
          ))}
          {rest ? <Text style={styles.muted}>{`and ${rest} more`}</Text> : null}
        </>
      ) : null}
    </View>
  );
}
