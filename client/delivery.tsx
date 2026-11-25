import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { tasksDeliveryRpc, tasksUpdateRpc } from "../shared/api.ts";
import { Actions } from "./actions.tsx";
import { Button, REFRESH_MS, Section, type Styles, Toggle } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";

type Theme = PluginHostProps["theme"];

/**
 * The task screen's Delivery (JOBBY-YV2QS part 5): its PR/MR and merge commit, checks, stage build,
 * flags, access, device, Trello card and QA's result, with the stage it is at and who acts next.
 * Merged code reads apart from accepted work. The facts a person records go through update_task's
 * `delivery`; Paseo Dash has no Trello access, so the card's state is the one recorded.
 */
export function DeliverySection({ task, styles, theme }: { task: string; styles: Styles; theme: Theme }) {
  const read = useRpc(tasksDeliveryRpc);
  const query = useQuery({ queryKey: ["dashboard", "delivery", task], queryFn: () => read({ task }), refetchInterval: REFRESH_MS });
  const [editing, setEditing] = useState(false);
  const d = query.data;
  if (!d) return null;
  return (
    <Section title={`Delivery · ${d.stage.replace(/_/g, " ")}`} styles={styles} trailing={<Button label="Record…" ghost onPress={() => setEditing(true)} styles={styles} />}>
      {d.error ? <Text style={styles.error}>{d.error}</Text> : null}
      {d.next ? <Text style={styles.text}>{`${d.next_by ? `Next: ${d.next_by} · ` : ""}${d.next}`}</Text> : null}
      {d.steps.map((s) => (
        <Text key={s.step} style={styles.muted}>{`${s.step}: ${s.state} · ${s.fact}`}</Text>
      ))}
      {d.trello_blocker ? <Text style={[styles.muted, { color: theme.colors.statusWarning }]}>{d.trello_blocker}</Text> : null}
      {d.qa_handoff ? (
        <View style={styles.card}>
          <Text style={styles.muted}>QA handoff</Text>
          <Text selectable style={styles.text}>
            {d.qa_handoff}
          </Text>
        </View>
      ) : null}
      {editing ? <DeliveryEditor task={task} onClose={() => setEditing(false)} styles={styles} theme={theme} /> : null}
    </Section>
  );
}

/** Records delivery facts: a field left empty is left as it is; "Clear" takes a recorded one off. */
function DeliveryEditor({ task, onClose, styles, theme }: { task: string; onClose: () => void; styles: Styles; theme: Theme }) {
  const update = useRpc(tasksUpdateRpc);
  const refresh = useRefresh();
  const [stageSha, setStageSha] = useState("");
  const [stageUrl, setStageUrl] = useState("");
  const [stageVersion, setStageVersion] = useState("");
  const [flags, setFlags] = useState("");
  const [flagsReady, setFlagsReady] = useState<boolean | undefined>(undefined);
  const [accessReady, setAccessReady] = useState<boolean | undefined>(undefined);
  const [device, setDevice] = useState("");
  const [deviceReady, setDeviceReady] = useState<boolean | undefined>(undefined);
  const [trello, setTrello] = useState("");
  const [trelloState, setTrelloState] = useState("");
  const [qa, setQa] = useState<"" | "pending" | "passed" | "failed">("");
  const [qaNote, setQaNote] = useState("");
  const keep = (text: string) => (text.trim() ? text.trim() : undefined);
  const saving = useMutation({
    mutationFn: () =>
      update({
        task,
        delivery: {
          stage_sha: keep(stageSha),
          stage_url: keep(stageUrl),
          stage_version: keep(stageVersion),
          flags: flags.trim() ? flags.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
          flags_ready: flagsReady,
          access_ready: accessReady,
          device: keep(device),
          device_ready: deviceReady,
          trello: keep(trello),
          trello_state: keep(trelloState),
          qa: qa || undefined,
          qa_note: keep(qaNote),
        },
      }),
    onSuccess: (answer) => {
      refresh();
      if (answer.ok) onClose();
    },
  });
  const error = saving.isError ? String((saving.error as Error)?.message ?? saving.error) : saving.data && !saving.data.ok ? saving.data.error : "";
  return (
    <Modal title="Record delivery facts" open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Text style={styles.muted}>Only the fields you fill in change; the day of each is recorded.</Text>
        <Field label="Stage build commit (sha)" value={stageSha} onChange={setStageSha} styles={styles} theme={theme} placeholder="5e1f0c4" />
        <Field label="Stage URL" value={stageUrl} onChange={setStageUrl} styles={styles} theme={theme} placeholder="https://stage.example.com" />
        <Field label="Stage version" value={stageVersion} onChange={setStageVersion} styles={styles} theme={theme} />
        <Field label="Flags QA needs, comma-separated" value={flags} onChange={setFlags} styles={styles} theme={theme} />
        <Toggle label="The flags are on" value={flagsReady === true} onChange={setFlagsReady} theme={theme} />
        <Toggle label="QA has access" value={accessReady === true} onChange={setAccessReady} theme={theme} />
        <Field label="Device QA tests on" value={device} onChange={setDevice} styles={styles} theme={theme} placeholder="iPhone 14, iOS 26" />
        <Toggle label="The device is there" value={deviceReady === true} onChange={setDeviceReady} theme={theme} />
        <Field label="Trello card URL" value={trello} onChange={setTrello} styles={styles} theme={theme} placeholder="https://trello.com/c/…" />
        <Field label="Trello card's state, as you checked it" value={trelloState} onChange={setTrelloState} styles={styles} theme={theme} placeholder="In QA" />
        <Choice
          label="QA's result"
          options={[
            { value: "pending", label: "Pending" },
            { value: "passed", label: "Passed" },
            { value: "failed", label: "Failed" },
          ]}
          value={qa}
          onChange={setQa}
          none="Unchanged"
          styles={styles}
        />
        <Field label="QA note" value={qaNote} onChange={setQaNote} styles={styles} theme={theme} multiline />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={saving.isPending ? "Saving…" : "Save"} disabled={saving.isPending} onPress={() => saving.mutate()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}
