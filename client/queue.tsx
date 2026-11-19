import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { autopilotReadRpc, autopilotSetRpc, tasksNextRpc, tasksStartReadyRpc } from "../shared/ui.ts";
import { Actions, StartDialog } from "./actions.tsx";
import { Button, ItemRow, REFRESH_MS, Section, type Styles, Toggle } from "./common.tsx";
import { useRefresh } from "./forms.tsx";
import { useShow } from "./nav.ts";

type Theme = PluginScreenProps["theme"];

/**
 * Starting more than one task (D24): "Start next" for the first task ready from this Mac, "Start ready
 * tasks" of a feature, and the cautious autopilot of one task or one project (server/autopilot.ts).
 */

/** "Start next": the first task ready to start from this Mac, through the ordinary start confirmation. */
export function StartNextButton({ space, styles, theme }: { space?: string; styles: Styles; theme: Theme }) {
  const next = useRpc(tasksNextRpc);
  const toast = useToast();
  const show = useShow();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      const answer = await next({ space: space || undefined });
      if (answer.error) toast.show(answer.error);
      else {
        if (answer.passed_over) toast.show(answer.passed_over);
        setTask(answer.task);
      }
    } catch (failure) {
      toast.error(`Could not read the next task: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button label={busy ? "Finding…" : "Start next"} disabled={busy} onPress={() => void ask()} styles={styles} />
      {task ? <StartDialog task={task} open onClose={() => setTask("")} onOpenTask={(id) => show.task(id, { title: id })} styles={styles} theme={theme} /> : null}
    </>
  );
}

function useAutopilot() {
  const read = useRpc(autopilotReadRpc);
  return useQuery({ queryKey: ["dashboard", "autopilot"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
}

function useSetAutopilot() {
  const set = useRpc(autopilotSetRpc);
  const toast = useToast();
  const refresh = useRefresh();
  return async (input: Parameters<typeof set>[0]) => {
    try {
      const answer = await set(input);
      if (!answer.ok) toast.error(answer.error);
    } catch (failure) {
      toast.error(`Unknown whether it changed: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      refresh();
    }
  };
}

/** The autopilot switch of one task or one project, with what it waits for. */
export function AutopilotToggle({ space, task, project, styles, theme }: { space: string; task?: string; project?: string; styles: Styles; theme: Theme }) {
  const state = useAutopilot().data;
  const set = useSetAutopilot();
  const flag = state?.flags.find((f) => f.space === space && (task ? f.task === task : f.project === project && !f.task));
  const label = task ? "Autopilot: start it on this Mac once it is ready" : "Autopilot: start this line's ready tasks on this Mac, one at a time";
  return (
    <View style={{ gap: 4 }}>
      <Toggle label={label} value={Boolean(flag)} onChange={(on) => void set({ space, task, project, on })} theme={theme} />
      {flag?.state ? <Text style={flag.paused ? styles.error : styles.muted}>{flag.state}</Text> : null}
      {flag?.paused ? <Button label="Resume" ghost onPress={() => void set({ space, task, project, resume: true })} styles={styles} /> : null}
    </View>
  );
}

/** Live's view of the autopilot: what is on, what it waits for, and what it started lately. */
export function AutopilotSection({ styles, theme }: { styles: Styles; theme: Theme }) {
  const query = useAutopilot();
  const set = useSetAutopilot();
  const show = useShow();
  const a = query.data;
  if (!a || (!a.flags.length && !a.started.length)) return null;
  // A live run with no agent at work takes no place; its task still waits for the person (Needs you).
  const idle = a.runs.filter((r) => !r.holds_place).length;
  return (
    <Section title={`Autopilot · ${a.running}/${a.max_running} runs at work here${idle ? ` · ${idle} more held with no agent at work` : ""}`} styles={styles}>
      {a.error ? <Text style={styles.error}>{a.error}</Text> : null}
      {a.limit.until ? <Text style={styles.muted}>{`Starts wait for a usage limit until ${new Date(a.limit.until).toLocaleString()}: ${a.limit.source}`}</Text> : null}
      {a.flags.map((f) => (
        <View key={`${f.space}:${f.task || f.project}`} style={styles.row}>
          <View style={{ flex: 1 }}>
            <ItemRow
              glyph={f.paused ? "failed" : "todo"}
              title={f.task ? `${f.title}` : `line ${f.project}`}
              note={[f.space, f.task || "every ready task, one at a time", f.state].filter(Boolean).join(" · ")}
              onPress={f.task ? () => show.task(f.task, { title: f.title }) : undefined}
              theme={theme}
              styles={styles}
            />
          </View>
          {f.paused ? <Button label="Resume" ghost onPress={() => void set({ space: f.space, task: f.task || undefined, project: f.project || undefined, resume: true })} styles={styles} /> : null}
          <Button label="Off" ghost onPress={() => void set({ space: f.space, task: f.task || undefined, project: f.project || undefined, on: false })} styles={styles} />
        </View>
      ))}
      {a.started.slice(0, 5).map((s) => (
        <ItemRow key={`${s.task}:${s.at}`} glyph="working" title={s.title} note={`started by the autopilot · ${s.task} · ${new Date(s.at).toLocaleString()}`} onPress={() => show.task(s.task, { title: s.title })} theme={theme} styles={styles} />
      ))}
    </Section>
  );
}

/** "Start ready tasks" of a feature: a confirmation naming them, then one start after another. */
export function StartReadyButton({ feature, ready, left, styles }: { feature: string; ready: { id: string; title: string }[]; left: { id: string; reason: string }[]; styles: Styles }) {
  const start = useRpc(tasksStartReadyRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  if (!ready.length) return null;
  const go = async () => {
    setBusy(true);
    setResult("");
    try {
      const answer = await start({ feature, tasks: ready.map((t) => t.id) });
      refresh();
      if (answer.error) return setResult(answer.error);
      const skipped = answer.skipped.map((s) => `${s.id}: ${s.reason}`).join("\n");
      toast.show(`Started ${answer.started.length} of ${answer.started.length + answer.skipped.length}`, { variant: answer.skipped.length ? "warning" : "success" });
      if (skipped) setResult(skipped);
      else setOpen(false);
    } catch (failure) {
      setResult(`Unknown how many started: ${String((failure as Error)?.message ?? failure)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button label={`Start ready tasks (${ready.length})`} ghost onPress={() => setOpen(true)} styles={styles} />
      {open ? (
        <Modal title="Start ready tasks" open onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <Modal.Content>
            <Text style={styles.text}>These start, each as a confirmed start does: its own workspace and agent, with the task's profile and mode. One whose instructions you have not seen as they are now is skipped until you open it.</Text>
            {ready.map((t) => (
              <Text key={t.id} style={styles.muted}>{`${t.id} · ${t.title}`}</Text>
            ))}
            {left.length ? <Text style={styles.text}>These stay with a person:</Text> : null}
            {left.map((t) => (
              <Text key={t.id} style={styles.muted}>{`${t.id} · ${t.reason}`}</Text>
            ))}
            {result ? <Text style={styles.error}>{result}</Text> : null}
            <Actions styles={styles}>
              <Button label="Close" ghost onPress={() => setOpen(false)} styles={styles} />
              <Button label={busy ? "Starting…" : "Start them"} disabled={busy} onPress={() => void go()} styles={styles} />
            </Actions>
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
