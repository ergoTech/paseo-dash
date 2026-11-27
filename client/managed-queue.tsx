import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { MAX_QUEUE_STARTS, type QueueAction, queuePreviewRpc, queueReadRpc, queueSetRpc } from "../shared/managed-queue.ts";
import { Button, Chip, ItemRow, REFRESH_MS, Section, type Styles } from "./common.tsx";
import { useShow } from "./nav.ts";

type Theme = PluginScreenProps["theme"];

/**
 * The managed queue (server/managed/, shared/managed-queue.ts): Live's report of what the queue does
 * next and what waits for the owner, and Settings' switch, limit and label scope.
 */

const ACTION_WORDS: Record<QueueAction, string> = {
  next: "next",
  queued: "queued",
  read_first: "forge is read first",
  after_dependency: "waits for a card",
  duplicate: "duplicate",
  needs_owner: "waits for you",
};

const STARTS = Array.from({ length: MAX_QUEUE_STARTS }, (_, i) => String(i + 1));
/** Rows one list of the report shows; the rest are counted. */
const ROWS = 12;

function useQueue() {
  const read = useRpc(queueReadRpc);
  return useQuery({ queryKey: ["dashboard", "queue"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
}

function useSetQueue() {
  const set = useRpc(queueSetRpc);
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof set>[0]) => set(input),
    onSettled: () => client.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

/** Live: what the queue of a project does next, why, and which cases wait for the owner. */
export function ManagedQueueSection({ space, styles, theme }: { space?: string; styles: Styles; theme: Theme }) {
  const queue = useQueue();
  const preview = useRpc(queuePreviewRpc);
  const set = useSetQueue();
  const show = useShow();
  const [chosen, setChosen] = useState("");
  const data = queue.data;
  const projects = (data?.projects ?? []).filter((p) => !space || p.space === space);
  const active = data?.policies.find((p) => p.enabled && (!space || p.space === space));
  const picked = projects.find((p) => `${p.space}/${p.project}` === chosen) ?? projects.find((p) => p.space === active?.space && p.project === active?.project) ?? projects[0];
  const report = useQuery({
    queryKey: ["dashboard", "queue", "preview", picked?.space ?? "", picked?.project ?? ""],
    queryFn: () => preview({ space: picked!.space, project: picked!.project }),
    enabled: Boolean(picked),
    refetchInterval: REFRESH_MS,
  });
  if (!data || !projects.length) return null;
  const r = report.data;
  const policy = data.policies.find((p) => picked && p.space === picked.space && p.project === picked.project);
  const change = (input: { enabled?: boolean; paused?: boolean }) => picked && set.mutate({ space: picked.space, project: picked.project, revision: data.revision, ...input });
  const next = r?.cards.filter((c) => c.action === "next" || c.action === "queued" || c.action === "read_first" || c.action === "after_dependency") ?? [];
  const owner = r?.cards.filter((c) => c.action === "needs_owner" || c.action === "duplicate") ?? [];
  const error = data.error || r?.error || (set.data && !set.data.ok ? set.data.error : "") || (set.isError ? String(set.error) : "") || (report.isError ? String(report.error) : "");
  const rows = (cards: typeof next, glyph: "todo" | "blocked" | "needs_you") =>
    cards.slice(0, ROWS).map((c, index) => (
      <ItemRow
        key={c.id}
        glyph={c.action === "after_dependency" ? "blocked" : glyph}
        title={`${index + 1}. ${c.title}`}
        note={[c.id, ACTION_WORDS[c.action], c.reason, c.step, c.start_with && `would start with ${c.start_with}`].filter(Boolean).join(" · ")}
        onPress={() => show.task(c.id, { title: c.title })}
        theme={theme}
        styles={styles}
      />
    ));
  return (
    <Section title={`Managed queue · ${picked ? `${picked.space}/${picked.project}` : ""} · ${r?.state ?? "…"}`} styles={styles}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {data.paused ? <Text style={styles.error}>{data.paused}</Text> : null}
      {projects.length > 1 ? (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          {projects.map((p) => (
            <Chip key={`${p.space}/${p.project}`} label={`${p.space}/${p.project}`} active={p === picked} onPress={() => setChosen(`${p.space}/${p.project}`)} styles={styles} />
          ))}
        </View>
      ) : null}
      {r ? (
        <>
          <Text style={styles.muted}>
            {`${r.limits.running} of ${r.limits.max_running} places at work on this Mac · ${r.limits.starts_used} of ${r.limits.max_starts} starts in ${r.limits.window_hours} h · ${r.preparer}`}
          </Text>
          {r.hold ? <Text style={styles.error}>{`Starts nothing now: ${r.hold}`}</Text> : null}
          {r.state === "off" ? <Text style={styles.muted}>Off: this is only a preview. Nothing starts until you turn it on; the queue then starts these cards within the limits, one at a time, as the autopilot does.</Text> : null}
        </>
      ) : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {r?.state === "off" ? <Button label="Turn on" disabled={set.isPending} onPress={() => change({ enabled: true })} styles={styles} /> : null}
        {r?.state === "on" ? <Button label="Pause" ghost disabled={set.isPending} onPress={() => change({ paused: true })} styles={styles} /> : null}
        {r?.state === "paused" ? <Button label="Resume" disabled={set.isPending} onPress={() => change({ paused: false })} styles={styles} /> : null}
        {policy?.enabled ? <Button label="Turn off" ghost disabled={set.isPending} onPress={() => change({ enabled: false })} styles={styles} /> : null}
      </View>
      <Text style={styles.text}>{`Next actions · ${next.length}`}</Text>
      {r && !next.length ? <Text style={styles.muted}>Nothing is ready for the queue.</Text> : null}
      {rows(next, "todo")}
      <Text style={styles.text}>{`Needs you · ${owner.length}`}</Text>
      {r && !owner.length ? <Text style={styles.muted}>No card waits for you.</Text> : null}
      {rows(owner, "needs_you")}
      {r && next.length > ROWS ? <Text style={styles.muted}>{`${next.length - ROWS} more next actions not listed`}</Text> : null}
      {r && owner.length > ROWS ? <Text style={styles.muted}>{`${owner.length - ROWS} more cases not listed`}</Text> : null}
      {r?.started.slice(0, 5).map((s) => (
        <ItemRow key={`${s.task}:${s.at}`} glyph="working" title={s.title} note={`started by the queue · ${s.task} · ${new Date(s.at).toLocaleString()}`} onPress={() => show.task(s.task, { title: s.title })} theme={theme} styles={styles} />
      ))}
    </Section>
  );
}

/** Settings: the owner's switch for one project's queue, its limit of starts and the labels it is narrowed to. */
export function ManagedQueueSettings() {
  const queue = useQueue();
  const set = useSetQueue();
  const [chosen, setChosen] = useState("");
  const [labels, setLabels] = useState<string | undefined>();
  const data = queue.data;
  if (!data) return null;
  const picked = data.projects.find((p) => `${p.space}/${p.project}` === chosen) ?? data.projects.find((p) => data.policies.some((o) => o.enabled && o.space === p.space && o.project === p.project)) ?? data.projects[0];
  const policy = data.policies.find((o) => picked && o.space === picked.space && o.project === picked.project);
  const error = data.error || data.paused || (set.data && !set.data.ok ? set.data.error : "") || (set.isError ? String(set.error) : "");
  const send = (input: { enabled?: boolean; paused?: boolean; max_starts?: number; labels?: string[] }) => picked && set.mutate({ space: picked.space, project: picked.project, revision: data.revision, ...input });
  const wanted = (labels ?? policy?.labels.join(", ") ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  return (
    <SettingsSection title="Managed queue (pilot)">
      <SettingsCard>
        <SettingsSelect
          label="Project"
          hint="One project's queue runs at a time. Live shows what it would do before you turn it on."
          value={picked ? `${picked.space}/${picked.project}` : ""}
          options={data.projects.map((p) => ({ label: `${p.name} (${p.space}) · ${p.project}`, value: `${p.space}/${p.project}` }))}
          onValueChange={(value) => {
            setChosen(value);
            setLabels(undefined);
          }}
        />
        <SettingsSwitch
          label="Start this project's ready cards on this Mac"
          hint="Off by default. The autopilot then starts the project's ready cards, one per check, within the limits below and Settings → Autopilot's places and usage limit. It never starts a card that waits for a card, a person, a decision, access or QA, one whose work looks done, a duplicate, or one whose instructions you have not seen as they are now. Text on a card gives it no permission. Turning it off or pausing counts at once, also for a start that is waiting."
          value={policy?.enabled === true}
          disabled={!picked || set.isPending}
          onValueChange={(value) => send({ enabled: value })}
          error={error || null}
        />
        <SettingsSelect
          label="Starts per 24 hours"
          hint={`At most this many starts by the queue in any 24 hours${policy ? `; ${policy.starts_used} so far` : ""}. A start that did not happen is not counted.`}
          value={String(policy?.max_starts ?? 3)}
          options={STARTS.map((value) => ({ label: value, value }))}
          disabled={!picked || set.isPending}
          onValueChange={(value) => send({ max_starts: Number(value) })}
        />
        <SettingsInput
          key={`${picked?.space}/${picked?.project}/${policy?.labels.join(",") ?? ""}`}
          label="Only cards with these labels"
          hint="Comma separated; empty means every card of the project. Cards without them are not the queue's."
          initialValue={policy?.labels.join(", ") ?? ""}
          placeholder="pilot"
          disabled={!picked}
          onChangeText={setLabels}
        />
        <SettingsAction label="Save the labels" hint={wanted.length ? wanted.join(", ") : "every card"} actionLabel="Save" disabled={!picked || set.isPending} onPress={() => send({ labels: wanted })} />
        {policy?.paused ? <SettingsRow label="Paused" hint={policy.paused} error={policy.paused} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
