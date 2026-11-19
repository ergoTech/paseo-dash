import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { Platform, Text, View } from "react-native";
import { releaseCheckRpc, tasksReleaseRpc, tasksUpdateRpc } from "../shared/api.ts";
import { CLARIFICATION_MAX, tasksArchiveWorkspaceRpc, uiMoveRpc, uiOptionsRpc, uiStartCheckRpc, uiStartRpc } from "../shared/ui.ts";
import type { Glyph } from "../shared/map.ts";
import { Button, Chip, isWebUrl, ItemRow, type Styles } from "./common.tsx";
import { Choice, Field, TaskPicker, useRefresh } from "./forms.tsx";

/**
 * The confirmations of 04-ux.md, Main flows: a start shows what it will do and what changed in the
 * instructions; a release names who holds the task; merging and rejecting a draft say what happens.
 */

type Theme = PluginHostProps["theme"];

const message = (failure: unknown) => String((failure as Error)?.message ?? failure);

function Facts({ rows, styles }: { rows: [string, string][]; styles: Styles }) {
  return (
    <View style={{ gap: 4 }}>
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <Text key={label} style={styles.text}>
            <Text style={styles.muted}>{`${label}  `}</Text>
            {value}
          </Text>
        ))}
    </View>
  );
}

export function Actions({ children, styles }: { children: ReactNode; styles: Styles }) {
  return <View style={[styles.row, { justifyContent: "flex-end", flexWrap: "wrap" }]}>{children}</View>;
}

const DIFF_MARK = { "+": "+", "-": "−", " ": " ", "…": "…" } as const;

/** A part's changed lines: added and removed lines carry their sign as well as a color. */
function Diff({ lines, theme, styles }: { lines: { op: "+" | "-" | " " | "…"; text: string }[]; theme: Theme; styles: Styles }) {
  return (
    <View style={[styles.card, { gap: 2 }]}>
      {lines.map((line, index) => (
        <Text
          key={index}
          accessibilityLabel={line.op === "+" ? `added: ${line.text}` : line.op === "-" ? `removed: ${line.text}` : line.text}
          style={{
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
            fontSize: 12,
            color: line.op === "+" ? theme.colors.statusSuccess : line.op === "-" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
          }}
        >
          {`${DIFF_MARK[line.op]} ${line.text}`}
        </Text>
      ))}
    </View>
  );
}

/** A task another one waits for: it opens that task's screen; `onStart` offers Start when it can start now. */
export interface WaitRow {
  id: string;
  title: string;
  status: string;
  glyph: Glyph;
  onStart?: () => void;
}

/** "Waits for" as rows: each opens the task it names, with its status (04-ux.md, Start). */
export function WaitsFor({ rows, onOpen, busy, styles, theme }: { rows: WaitRow[]; onOpen: (id: string) => void; busy?: boolean; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 2 }}>
      {rows.map((w) => (
        <View key={w.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <ItemRow glyph={w.glyph} title={w.title} note={`${w.id} · ${w.status}`} onPress={() => onOpen(w.id)} theme={theme} styles={styles} />
          </View>
          {w.onStart ? <Button label="Start…" ghost disabled={busy} onPress={w.onStart} styles={styles} /> : null}
        </View>
      ))}
    </View>
  );
}

type StartCheck = (input: RpcInput<typeof uiStartCheckRpc>) => Promise<RpcOutput<typeof uiStartCheckRpc>>;
type BranchChoice = "continue" | "fresh";
type Existing = NonNullable<RpcOutput<typeof uiStartCheckRpc>["existing"]>;

/**
 * The planned branch exists and no run of the task made it (03-model.md, Branch names): where it is,
 * its PR/MR, and the choices. Merged work offers "Mark done" or a fresh run on the suffixed name;
 * other work offers continuing on it (when nothing holds it) or the suffixed name.
 */
function ExistingBranchChoice({ existing, error, busy, onChoose, onMarkDone, styles, theme }: {
  existing: Existing;
  error: string;
  busy: boolean;
  onChoose: (choice: BranchChoice) => void;
  onMarkDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const pr = existing.pr;
  const canContinue = existing.merged === false && !existing.cannot_continue;
  const when = pr?.merged_at ? ` on ${pr.merged_at.slice(0, 16).replace("T", " ")} UTC` : "";
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.error}>{error}</Text>
      {existing.where.length ? <Text style={styles.muted}>{`${existing.branch}: ${existing.where.join("; ")}`}</Text> : null}
      {pr ? (
        <View style={[styles.row, { flexWrap: "wrap", gap: 4 }]}>
          <Text style={styles.muted}>{pr.state === "merged" ? `Merged${when}:` : pr.state === "open" ? "Open:" : "Closed without a merge:"}</Text>
          {isWebUrl(pr.url) ? (
            <ExternalLink href={pr.url}>
              <Text style={[styles.text, { color: theme.colors.accent }]}>{pr.label}</Text>
            </ExternalLink>
          ) : (
            <Text style={styles.text}>{pr.label}</Text>
          )}
        </View>
      ) : null}
      {existing.merged !== true && existing.cannot_continue ? <Text style={styles.muted}>{`Cannot continue on it: ${existing.cannot_continue}.`}</Text> : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {existing.merged ? <Button label="Mark done" disabled={busy} onPress={onMarkDone} styles={styles} /> : null}
        {existing.merged === false ? (
          <Button label={`Continue on ${existing.branch}`} disabled={busy || Boolean(existing.cannot_continue)} onPress={() => onChoose("continue")} styles={styles} />
        ) : null}
        {existing.fresh ? <Button label={`Start on ${existing.fresh}`} ghost={existing.merged === true || canContinue} disabled={busy} onPress={() => onChoose("fresh")} styles={styles} /> : null}
      </View>
    </View>
  );
}

/** How long a start's facts are shown without reading them again, and kept once nothing shows them. */
const START_STALE_MS = 20_000;
const START_GC_MS = 60_000;

/**
 * A start's facts, read past the tasks it waits for: the dialog says those itself, so "Start anyway"
 * shows the rest at once. Not under the "dashboard" key, which the screens' polls refresh too; a write
 * refreshes both (`useRefresh`). The start sends, or checks against its own decision, every row of
 * the facts the dialog showed.
 */
const startFacts = (check: StartCheck, task: string, branch?: BranchChoice) => ({
  queryKey: ["dashboard-start", task, branch ?? ""],
  queryFn: () => check({ task, anyway: true, ...(branch ? { branch } : {}) }),
  staleTime: START_STALE_MS,
  gcTime: START_GC_MS,
});

/** Reads a task's start facts ahead, so its confirmation opens with them. */
export function usePrefetchStart(): (task: string) => void {
  const client = useQueryClient();
  const check = useRpc(uiStartCheckRpc);
  return useCallback((task: string) => void client.prefetchQuery({ ...startFacts(check, task), staleTime: 0 }), [client, check]);
}

/** A mode or effort picked in the confirmation, said as the server says a pick. */
const pickedText = (option: { id: string; label: string; asks?: boolean }) =>
  `${option.label && option.label !== option.id ? `${option.label} (${option.id}, picked)` : `${option.id} (picked)`}${option.asks ? "; it stops for the user's approval, so the agent waits for the user" : ""}`;

/**
 * Start a todo task (04-ux.md, Start): branch, workspace, profile, mode, and per part of the
 * instructions whether it changed since you last saw it, with the diff. A blocked task lists what it
 * waits for, each opening its own screen (`onOpenTask`, after the dialog closes) and offering Start
 * when it can start now, which turns this dialog into that task's start; the task itself starts only
 * with "Start anyway". The mode can be switched to another of the provider's; one that asks before
 * tools is said plainly, since its agent stops for a person at once. The effort can be switched to
 * another of the model's. A clarification typed here is kept on the task and wins over the brief
 * where they disagree. The start sends the hashes of what this dialog showed, so it refuses if the
 * instructions changed while it was open. The facts may come from a read ahead (`usePrefetchStart`)
 * or the last 20 seconds: picking a mode, an effort or "Start anyway" asks the daemon nothing. The
 * start sends the mode, effort, blockers and instruction hashes it showed, and refuses when its own
 * decision of the project, branch, workspace, agent or issue is not the one shown. A planned branch
 * that exists without a run of the task is shown with its choices (ExistingBranchChoice); the one
 * picked is checked and sent with the start.
 */
export function StartDialog({
  task,
  title,
  open,
  onClose,
  onStarted,
  onOpenTask,
  styles,
  theme,
}: {
  task: string;
  /** The task's title, shown while its facts are read. */
  title?: string;
  open: boolean;
  onClose: () => void;
  onStarted?: () => void;
  onOpenTask: (id: string) => void;
  styles: Styles;
  theme: Theme;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const check = useRpc(uiStartCheckRpc);
  const start = useRpc(uiStartRpc);
  const update = useRpc(tasksUpdateRpc);
  // The task this dialog starts: the one it opened for, or a task that one waits for.
  const [current, setCurrent] = useState(task);
  const [anyway, setAnyway] = useState(false);
  /** What the person chose for an existing branch no run of the task made; undefined until asked. */
  const [branch, setBranch] = useState<BranchChoice | undefined>();
  /** A mode picked here; undefined keeps the one the profile, the space or the provider gives. */
  const [mode, setMode] = useState<string | undefined>();
  /** An effort picked here; undefined keeps the profile's or the model's default. */
  const [effort, setEffort] = useState<string | undefined>();
  const [clarification, setClarification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const facts = useQuery({ ...startFacts(check, current, branch), enabled: open });
  const switchTo = (id: string) => {
    setCurrent(id);
    setAnyway(false);
    setBranch(undefined);
    setMode(undefined);
    setEffort(undefined);
    setClarification("");
    setError("");
  };
  const openTask = (id: string) => {
    onClose();
    onOpenTask(id);
  };
  const f = facts.data;
  const blocked = Boolean(f?.blocked_by.length);
  const tooLong = clarification.length > CLARIFICATION_MAX;
  // A read again in the background does not hold the start back: the start sends or checks every fact row.
  const ready = f && !f.error && !tooLong && (!blocked || anyway);
  // The facts are the daemon's choice; a pick here is said like one without asking it again.
  const pickedMode = f && mode !== undefined && mode !== f.mode_id ? f.modes.find((m) => m.id === mode) : undefined;
  const pickedEffort = f && effort !== undefined && effort !== f.effort_id ? f.efforts.find((e) => e.id === effort) : undefined;

  const go = async () => {
    if (!f) return;
    setBusy(true);
    setError("");
    try {
      // The mode shown is the mode started: a space default changed by a sync meanwhile does not slip in.
      const shown = mode ?? (f.modes.some((m) => m.id === f.mode_id) ? f.mode_id : undefined);
      const shownEffort = effort ?? (f.efforts.some((e) => e.id === f.effort_id) ? f.effort_id : undefined);
      const answer = await start({
        task: current,
        ...(shown ? { mode: shown } : {}),
        ...(shownEffort ? { effort: shownEffort } : {}),
        start_past: anyway ? f.blocked_ids : [],
        ...(branch ? { branch } : {}),
        seen: f.parts.map((p) => p.hash),
        clarification,
        // The facts may be up to a minute old: the start refuses if its own decision differs from them.
        shown: { project: f.project, branch: f.branch, workspace: f.workspace, profile: f.profile, issue: f.issue, human: f.human },
      });
      if (!answer.ok) {
        setError(answer.error);
        void facts.refetch();
        return;
      }
      refresh();
      toast.show(`Starting ${answer.id} on ${answer.branch}`, { variant: "success" });
      onStarted?.();
      onClose();
    } catch (failure) {
      // An unclear claim: the next read of the task shows whether it started.
      setError(`Unknown whether it started: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // Merged work: the task is marked done here, without a run; nothing starts.
  const markDone = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await update({ task: current, status: "done" });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(`${answer.id} is done`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it changed: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Start task" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        {facts.isError ? <Text style={styles.error}>{`Could not check the start: ${message(facts.error)}`}</Text> : null}
        {!f && title && current === task ? <Text style={styles.heading}>{title}</Text> : null}
        {!f && facts.isFetching ? <Text style={styles.muted}>Checking the branch, the profile and the instructions…</Text> : null}
        {current !== task ? (
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <Text style={[styles.muted, { flex: 1 }]}>{`Starting ${current}, which ${task} waits for.`}</Text>
            <Button label={`Back to ${task}`} ghost disabled={busy} onPress={() => switchTo(task)} styles={styles} />
          </View>
        ) : null}
        {f ? (
          <>
            <Text style={styles.heading}>{f.title}</Text>
            {f.human ? <Text style={styles.error}>{f.human}</Text> : null}
            {blocked ? (
              <View style={{ gap: 4 }}>
                <Text style={styles.error}>{`⊘ Waits for ${f.blocked_by.length === 1 ? "a task that is" : "tasks that are"} not done:`}</Text>
                <WaitsFor
                  rows={f.waits.map((w) => ({ ...w, onStart: w.can_start ? () => switchTo(w.id) : undefined }))}
                  onOpen={openTask}
                  busy={busy}
                  styles={styles}
                  theme={theme}
                />
                {anyway ? <Text style={styles.muted}>Starting anyway.</Text> : <Button label="Start anyway" ghost onPress={() => setAnyway(true)} styles={styles} />}
              </View>
            ) : null}
            {f.error && !(blocked && !anyway) ? (
              f.existing ? (
                <ExistingBranchChoice existing={f.existing} error={f.error} busy={busy} onChoose={setBranch} onMarkDone={() => void markDone()} styles={styles} theme={theme} />
              ) : (
                <Text style={styles.error}>{f.error}</Text>
              )
            ) : null}
            {branch ? (
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                <Text style={[styles.muted, { flex: 1 }]}>{branch === "continue" ? "Continuing on the existing branch, as you chose." : "On a fresh branch, as you chose."}</Text>
                <Button label="Choose again" ghost disabled={busy} onPress={() => setBranch(undefined)} styles={styles} />
              </View>
            ) : null}
            {!f.error && !(blocked && !anyway) ? (
              <>
                <Facts
                  rows={[
                    ["Project", f.project],
                    ["Branch", f.branch],
                    ["Workspace", f.workspace],
                    ["Agent", f.profile],
                    ["Mode", pickedMode ? pickedText(pickedMode) : f.mode],
                    ["Effort", pickedEffort ? pickedText(pickedEffort) : f.effort],
                    ["Instructions", f.instructions],
                    ...(f.issue ? [["Issue", f.issue] as [string, string]] : []),
                  ]}
                  styles={styles}
                />
                {f.modes.length > 1 ? (
                  <View style={[styles.row, { flexWrap: "wrap" }]}>
                    {f.modes.map((m) => (
                      <Chip
                        key={m.id}
                        label={m.label}
                        active={m.id === (mode ?? f.mode_id)}
                        accessibilityLabel={`Mode ${m.label}${m.asks ? ", stops for your approval" : ""}`}
                        onPress={busy ? undefined : () => setMode(m.id)}
                        styles={styles}
                      />
                    ))}
                  </View>
                ) : null}
                {(pickedMode ? pickedMode.asks : f.mode_asks) ? (
                  <Text style={styles.error}>This mode stops for your approval: the agent waits for you. Pick an automatic mode if you will be away.</Text>
                ) : null}
                {f.efforts.length > 1 ? (
                  <View style={[styles.row, { flexWrap: "wrap" }]}>
                    {f.efforts.map((e) => (
                      <Chip
                        key={e.id}
                        label={e.label}
                        active={e.id === (effort ?? f.effort_id)}
                        accessibilityLabel={`Effort ${e.label}`}
                        onPress={busy ? undefined : () => setEffort(e.id)}
                        styles={styles}
                      />
                    ))}
                  </View>
                ) : null}
                {f.parts
                  .filter((p) => p.state !== "unchanged")
                  .map((p) => (
                    <View key={p.key} style={{ gap: 4 }}>
                      <Text style={styles.muted}>
                        {`${p.name}: ${p.state === "changed" ? "changed since you last saw them" : "not seen by you yet"}${p.author ? ` (per git: ${p.author})` : ""}`}
                      </Text>
                      <Diff lines={p.diff} theme={theme} styles={styles} />
                    </View>
                  ))}
                <Field
                  label="Clarifications (optional)"
                  value={clarification}
                  onChange={setClarification}
                  multiline
                  placeholder="What the brief or acceptance gets wrong or leaves out. Kept on the task; the agent follows it where it disagrees with them."
                  styles={styles}
                  theme={theme}
                />
                {tooLong ? <Text style={styles.error}>{`Clarifications are limited to about ${CLARIFICATION_MAX} characters (${clarification.length} now).`}</Text> : null}
                <Text style={styles.muted}>The agent runs with your permissions and gets these instructions as its first message.</Text>
              </>
            ) : null}
          </>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Starting…" : "Start"} disabled={busy || !ready} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}

export type ReleaseTo = "done" | "todo" | "canceled";

const RELEASE_LABEL: Record<ReleaseTo, string> = { done: "Mark done", todo: "Back to todo", canceled: "Cancel task" };

/**
 * A task held by a live run (04-ux.md, Review and close): who holds it, on which machine, since when;
 * the release stops its agent (D23), and the toast says what became of it.
 */
export function ReleaseDialog({ task, to, open, onClose, styles }: { task: string; to: ReleaseTo; open: boolean; onClose: () => void; styles: Styles }) {
  const toast = useToast();
  const refresh = useRefresh();
  const check = useRpc(releaseCheckRpc);
  const release = useRpc(tasksReleaseRpc);
  const facts = useQuery({ queryKey: ["dashboard", "release-check", task], queryFn: () => check({ task }), enabled: open, staleTime: 0, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const f = facts.data;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await release({ task, to });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(`${answer.id} is ${answer.status}${answer.agent ? `; ${answer.agent}` : ""}`, { variant: answer.agent.startsWith("its agent could not") ? "warning" : "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it was released: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={RELEASE_LABEL[to]} open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        {facts.isError ? <Text style={styles.error}>{`Could not read the task: ${message(facts.error)}`}</Text> : null}
        {f?.error ? <Text style={styles.error}>{f.error}</Text> : null}
        {f && !f.error ? (
          <>
            <Text style={styles.heading}>{f.title}</Text>
            <Text style={styles.text}>{`Held by ${f.held_by} on ${f.host} since ${f.since}.`}</Text>
            <Text style={styles.text}>{`This ends that run's hold and sets the task to ${to}. The run's agent is stopped: on this Mac at once, on another once it syncs (for done, there it keeps running). Its chat and workspace stay.`}</Text>
          </>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Working…" : RELEASE_LABEL[to]} disabled={busy || !f || Boolean(f.error)} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}

/** A status change without a run: done, cancel, reopen, reject a draft. */
export function StatusDialog({
  task,
  title,
  to,
  label,
  note,
  accept,
  open,
  onClose,
  styles,
}: {
  task: string;
  title: string;
  to: "todo" | "done" | "canceled";
  label: string;
  note: string;
  /**
   * The task is an inbox draft marked done: it is accepted first (inbox → todo), then marked done,
   * since a draft never goes to done directly (03-model.md, the transition table).
   */
  accept?: boolean;
  open: boolean;
  onClose: () => void;
  styles: Styles;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const update = useRpc(tasksUpdateRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      if (accept && to === "done") {
        const accepted = await update({ task, status: "todo" });
        if (!accepted.ok) return setError(accepted.error);
      }
      const answer = await update({ task, status: to });
      if (!answer.ok) {
        if (accept) refresh();
        return setError(accept ? `Accepted, but not marked done: ${answer.error}` : answer.error);
      }
      refresh();
      toast.show(`${answer.id} is ${answer.status}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it changed: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={label} open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={styles.heading}>{title}</Text>
        <Text style={styles.text}>{note}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Working…" : label} disabled={busy} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}

/** Merge a draft into another task (04-ux.md, Triage): the draft is canceled and points at that task. */
export function MergeDialog({ space, task, title, open, onClose, styles, theme }: { space: string; task: string; title: string; open: boolean; onClose: () => void; styles: Styles; theme: Theme }) {
  const toast = useToast();
  const refresh = useRefresh();
  const update = useRpc(tasksUpdateRpc);
  const [target, setTarget] = useState<{ id: string; title: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const answer = await update({ task, duplicate_of: target.id, status: "canceled" });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(`${answer.id} merged into ${target.id}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it merged: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Merge into another task" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={styles.heading}>{title}</Text>
        <Text style={styles.text}>The draft is canceled and marked as a duplicate of the task you pick; its text and meeting link stay in its file.</Text>
        <TaskPicker
          space={space}
          label="Duplicate of"
          picked={target ? [target] : []}
          exclude={task}
          onPick={setTarget}
          onUnpick={() => setTarget(undefined)}
          styles={styles}
          theme={theme}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Merging…" : "Merge"} disabled={busy || !target} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}

/** Where a task sits: its project, feature id and own release id ("" for none). */
export interface TaskPlace {
  project: string;
  feature: string;
  milestone: string;
}

/**
 * Move a task to another release, feature or line (04-ux.md, Main flows). The project is offered
 * only while the task was never started (`line` says why not). Only what changed here is sent, with
 * where the dialog showed the task, so a move someone else made meanwhile refuses and says so.
 */
export function MoveDialog({
  space,
  task,
  title,
  place,
  line,
  open,
  onClose,
  styles,
}: {
  space: string;
  task: string;
  title: string;
  place: TaskPlace;
  /** Why the project cannot change; empty while it can. */
  line: string;
  open: boolean;
  onClose: () => void;
  styles: Styles;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const move = useRpc(uiMoveRpc);
  const readOptions = useRpc(uiOptionsRpc);
  const options = useQuery({ queryKey: ["dashboard", "options", space], queryFn: () => readOptions({ space }), enabled: open });
  // `place` may follow the live task; the dialog keeps where it opened, which the move is checked against.
  const [from] = useState(place);
  const [project, setProject] = useState(from.project);
  const [feature, setFeature] = useState(from.feature);
  const [milestone, setMilestone] = useState(from.milestone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const o = options.data;
  const changed = project !== from.project || feature !== from.feature || milestone !== from.milestone;
  const drifted = place.project !== from.project || place.feature !== from.feature || place.milestone !== from.milestone;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await move({
        task,
        project: project !== from.project ? project : undefined,
        feature: feature !== from.feature ? feature : undefined,
        milestone: milestone !== from.milestone ? milestone : undefined,
        from,
      });
      if (!answer.ok) {
        setError(answer.error);
        if (answer.changed.length) refresh();
        return;
      }
      refresh();
      toast.show(`Moved ${answer.id}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it moved: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Move task" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={styles.heading}>{title}</Text>
        {o?.error ? <Text style={styles.error}>{o.error}</Text> : null}
        {line ? (
          <View style={{ gap: 4 }}>
            <Facts rows={[["Project", from.project]]} styles={styles} />
            <Text style={styles.muted}>{line}</Text>
          </View>
        ) : (
          <Choice
            label="Project"
            loaded={Boolean(o)}
            options={(o?.projects ?? []).map((p) => ({ value: p.key, label: p.mapped ? p.key : `${p.key} (not on this Mac)` }))}
            value={project}
            onChange={(value) => setProject(value || from.project)}
            styles={styles}
          />
        )}
        <Choice label="Feature" loaded={Boolean(o)} options={(o?.features ?? []).map((f) => ({ value: f.id, label: f.title }))} value={feature} onChange={setFeature} none="None" styles={styles} />
        {/* A task without its own release follows its feature's. */}
        <Choice
          label="Release"
          loaded={Boolean(o)}
          options={(o?.milestones ?? []).map((m) => ({ value: m.id, label: m.due ? `${m.title} · ${m.due}` : m.title }))}
          value={milestone}
          onChange={setMilestone}
          none={feature ? "The feature's" : "None"}
          styles={styles}
        />
        {drifted ? <Text style={styles.error}>The task is no longer where this dialog opened it; moving now is refused. Close and open Move again.</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Moving…" : "Move"} disabled={busy || !changed} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}

/** "Archive workspace" (D23): a separate step after a run ended, confirmed, never automatic. */
export function ArchiveWorkspaceDialog({ task, title, open, onClose, styles }: { task: string; title: string; open: boolean; onClose: () => void; styles: Styles }) {
  const toast = useToast();
  const refresh = useRefresh();
  const archive = useRpc(tasksArchiveWorkspaceRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await archive({ task });
      refresh();
      if (!answer.ok) return setError(answer.error);
      toast.show(`Archived ${answer.archived === 1 ? "the workspace" : `${answer.archived} workspaces`} of ${task}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Unknown whether it was archived: ${message(failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Archive workspace" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={styles.heading}>{title}</Text>
        <Text style={styles.text}>The worktree this Mac made for the task is archived in Paseo. Its branch and PR/MR stay on the forge; the agent's chat stays in Paseo's history.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Archiving…" : "Archive"} disabled={busy} onPress={() => void go()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}
