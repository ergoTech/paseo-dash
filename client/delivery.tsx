import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { tasksDeliveryRpc, tasksUpdateRpc } from "../shared/api.ts";
import { Actions } from "./actions.tsx";
import { Button, isWebUrl, REFRESH_MS, Section, type Styles, Toggle } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";

type Theme = PluginHostProps["theme"];

/**
 * The task screen's Delivery (JOBBY-YV2QS part 5): its PR/MR and merge commit, checks, stage build,
 * flags, access, device, Trello card and QA's result, with the stage it is at and who acts next.
 * Merged code reads apart from accepted work. The facts a person records go through update_task's
 * `delivery`; Paseo Dash has no Trello access, so a card's state is the one recorded, with its time.
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
      {d.qa_cards?.length ? (
        <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
          <Text style={styles.muted}>QA cards</Text>
          {d.qa_cards.map((card) =>
            isWebUrl(card.url) ? (
              <ExternalLink key={card.url} href={card.url}>
                <Text style={[styles.text, { color: theme.colors.accent }]}>{`${card.label} · ${card.status}`}</Text>
              </ExternalLink>
            ) : null,
          )}
        </View>
      ) : null}
      {d.trello_blocker ? <Text style={[styles.muted, { color: theme.colors.statusWarning }]}>{d.trello_blocker}</Text> : null}
      {d.qa_handoff ? (
        <View style={styles.card}>
          <Text style={styles.muted}>QA handoff</Text>
          <Text selectable style={styles.text}>
            {d.qa_handoff}
          </Text>
        </View>
      ) : null}
      {editing ? <DeliveryEditor task={task} app={d.app} onClose={() => setEditing(false)} styles={styles} theme={theme} /> : null}
    </Section>
  );
}

type Builds = NonNullable<RpcOutput<typeof tasksDeliveryRpc>["app"]>["builds"];

/** A recorded build as its editor line: "variant:environment sha url version"; a url left out is "-". */
const buildLine = (b: Builds[number]) => [`${b.variant}:${b.environment}`, b.sha, b.url || (b.version ? "-" : ""), b.version].filter(Boolean).join(" ");

/**
 * The editor's lines as builds. A line without an environment takes the card's. `bad` names the first
 * line that is not a build: the list replaces the recorded one, so nothing is dropped silently.
 */
function parseBuilds(text: string, environment: string | undefined): { builds: { variant: string; environment?: string; sha: string; url?: string; version?: string }[]; bad: string } {
  const builds: ReturnType<typeof parseBuilds>["builds"] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [name, sha, url, version, ...rest] = line.split(/\s+/);
    const [variant, own] = (name ?? "").split(":");
    const link = url && url !== "-" ? url : undefined;
    if (!variant || !sha || !/^[0-9a-fA-F]{7,64}$/.test(sha) || (link && !/^https:\/\/\S+$/.test(link)) || rest.length) return { builds: [], bad: line };
    const env = own || environment;
    builds.push({ variant, ...(env ? { environment: env } : {}), sha, ...(link ? { url: link } : {}), ...(version ? { version } : {}) });
  }
  return { builds, bad: "" };
}

/** Records delivery facts: a field left empty is left as it is; "Clear" takes a recorded one off. */
function DeliveryEditor({ task, app, onClose, styles, theme }: { task: string; app: RpcOutput<typeof tasksDeliveryRpc>["app"]; onClose: () => void; styles: Styles; theme: Theme }) {
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
  // An app's builds: the whole list, one per line; it replaces the recorded one.
  const [variants, setVariants] = useState(app?.variants.join(", ") ?? "");
  const recorded = app?.builds.map(buildLine).join("\n") ?? "";
  const [builds, setBuilds] = useState(recorded);
  const parsed = parseBuilds(builds, app?.environment);
  const [play, setPlay] = useState<"" | "unpublished" | "submitted" | "published">("");
  // One QA card as the person just saw it on Trello: its reading carries the time of saving.
  const [card, setCard] = useState("");
  const [cardState, setCardState] = useState<"" | "open" | "archived">("");
  const [cardList, setCardList] = useState("");
  const [tester, setTester] = useState("");
  const [replacedBy, setReplacedBy] = useState("");
  const [evidence, setEvidence] = useState("");
  const [proof, setProof] = useState("");
  const keep = (text: string) => (text.trim() ? text.trim() : undefined);
  const replacements = replacedBy.split(/[\s,]+/).filter(Boolean);
  const unfinished = Boolean(card.trim()) !== Boolean(cardState) || (!card.trim() && Boolean(cardList.trim() || tester.trim() || replacements.length || evidence.trim() || proof.trim()));
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
          variants: variants.trim() === (app?.variants.join(", ") ?? "") ? undefined : variants.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
          builds: builds === recorded ? undefined : parsed.builds,
          play: play || undefined,
          trello_cards:
            card.trim() && cardState
              ? [
                  {
                    url: card.trim(),
                    checked: new Date().toISOString(),
                    state: cardState,
                    list: keep(cardList),
                    tester: keep(tester),
                    replaced_by: replacements.length ? replacements : undefined,
                    evidence: keep(evidence),
                    proof: keep(proof),
                  },
                ]
              : undefined,
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
        <Text style={styles.muted}>A QA card as you see it on Trello now. It records no QA result, and moves nothing.</Text>
        <Field label="QA card URL" value={card} onChange={setCard} styles={styles} theme={theme} placeholder="https://trello.com/c/…" />
        <Choice
          label="The card is"
          options={[
            { value: "open", label: "Open" },
            { value: "archived", label: "Archived" },
          ]}
          value={cardState}
          onChange={setCardState}
          none="Not recorded"
          styles={styles}
        />
        <Field label="Its list" value={cardList} onChange={setCardList} styles={styles} theme={theme} />
        <Field label="Who tests it next" value={tester} onChange={setTester} styles={styles} theme={theme} />
        <Field label="Replaced by (card URLs, only if someone said so)" value={replacedBy} onChange={setReplacedBy} styles={styles} theme={theme} placeholder="https://trello.com/c/…" />
        <Field label="Where the replacement is said" value={evidence} onChange={setEvidence} styles={styles} theme={theme} placeholder="A comment on the card, the owner's word" />
        <Field label="Where the result of its run is recorded" value={proof} onChange={setProof} styles={styles} theme={theme} />
        {unfinished ? <Text style={styles.error}>A card reading needs its URL and whether it is open or archived.</Text> : null}
        <Text style={styles.muted}>For an app: a build covers every card of the project whose merge it holds; being available passes no test, and a merge publishes nothing.</Text>
        <Field label="Builds QA needs, comma-separated" value={variants} onChange={setVariants} styles={styles} theme={theme} placeholder="phone, wear" />
        <Field label="Recorded builds, one per line: variant:environment sha url version (replaces the list)" value={builds} onChange={setBuilds} styles={styles} theme={theme} multiline placeholder="phone:staging 5e1f0c4 https://apk.example.com/staging.apk 1.4.0" />
        {parsed.bad ? <Text style={styles.error}>{`Not a build line: ${parsed.bad}`}</Text> : null}
        <Choice
          label="Google Play"
          options={[
            { value: "unpublished", label: "Not published" },
            { value: "submitted", label: "Submitted" },
            { value: "published", label: "Published" },
          ]}
          value={play}
          onChange={setPlay}
          none="Unchanged"
          styles={styles}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Actions styles={styles}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={saving.isPending ? "Saving…" : "Save"} disabled={saving.isPending || unfinished || (builds !== recorded && Boolean(parsed.bad))} onPress={() => saving.mutate()} styles={styles} />
        </Actions>
      </Modal.Content>
    </Modal>
  );
}
