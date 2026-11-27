import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { ExternalLink, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { type overviewRpc } from "../shared/overview.ts";
import { reconcileRulesRpc, reconcileRulesSetRpc } from "../shared/reconcile.ts";
import type { Styles } from "./common.tsx";
import { isWebUrl } from "./common.tsx";

type Theme = PluginHostProps["theme"];
type Item = RpcOutput<typeof overviewRpc>["needs_you"][number];

/**
 * The cards behind a Needs you item (06-god-mode.md): a merge list's PR/MRs in the order to merge
 * them, each with its own blockers, or a group of cards that wait for the same thing, each with where
 * its decision comes from and the links to the evidence. Opening a card is the row's own press.
 */
export function NeedCards({ item, onOpen, theme, styles }: { item: Item; onOpen: (task: string, title: string) => void; theme: Theme; styles: Styles }) {
  const cards = item.cards ?? [];
  if (!cards.length) return null;
  const merge = item.kind === "merge";
  return (
    <View style={{ gap: 6, paddingLeft: 24 }}>
      {cards.map((card, index) => (
        <View key={`${card.task}:${card.links[0]?.url ?? index}`} style={{ gap: 2 }}>
          <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
            {merge ? <Text style={[styles.muted, { minWidth: 18 }]}>{`${card.order}.`}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${card.task} ${card.title}`} onPress={() => onOpen(card.task, card.title)}>
              <Text style={[styles.text, { color: theme.colors.accent }]} numberOfLines={2}>{`${card.task} ${card.title}`}</Text>
            </Pressable>
            {card.links.map((link) =>
              isWebUrl(link.url) ? (
                <ExternalLink key={link.url} href={link.url}>
                  <Text style={[styles.text, { color: theme.colors.accent }]}>{link.label}</Text>
                </ExternalLink>
              ) : (
                <Text key={link.url} style={styles.text}>{link.label}</Text>
              ),
            )}
            {merge ? <Text style={[styles.muted, { color: card.ready ? theme.colors.statusSuccess : theme.colors.statusWarning }]}>{card.ready ? "ready" : "blocked"}</Text> : null}
          </View>
          {card.also?.length ? (
            <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
              <Text style={styles.muted}>also named by</Text>
              {card.also.map((task) => (
                <Pressable key={task} accessibilityRole="button" accessibilityLabel={`Open ${task}`} onPress={() => onOpen(task, task)}>
                  <Text style={[styles.muted, { color: theme.colors.accent }]}>{task}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {merge && card.blockers?.length ? card.blockers.map((blocker) => <Text key={blocker} style={styles.muted}>{`  · ${blocker}`}</Text>) : null}
          {!merge ? <Text style={styles.muted}>{`${card.note}${card.source ? ` (${card.source})` : ""}`}</Text> : null}
          {/* A ready row's note says what else the owner should know: work of its card that is not read. */}
          {merge && !card.blockers?.length && card.note !== "ready to merge" ? <Text style={styles.muted}>{card.note}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const MODES = [
  { label: "Off", value: "off" },
  { label: "Report: say what is left, close nothing", value: "report" },
  { label: "Close: also close a card whose work is merged and verified", value: "close" },
] as const;

/**
 * This machine's rule for automatic reconciliation (server/reconcile/rules.ts), per project of each
 * connected space. Off unless switched on here; never reachable from ChatGPT.
 */
export function ReconcileSettings({ styles }: { styles: { error: { color: string } } }) {
  const read = useRpc(reconcileRulesRpc);
  const write = useRpc(reconcileRulesSetRpc);
  const rules = useQuery({ queryKey: ["dashboard", "reconcile", "rules"], queryFn: () => read({}) });
  const saving = useMutation({ mutationFn: (change: Parameters<typeof write>[0]) => write(change), onSettled: () => rules.refetch() });
  const projects = rules.data?.projects ?? [];
  const error = rules.data?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "");
  if (!rules.data && !rules.isError) return null;
  return (
    <SettingsSection title="Automatic closing">
      <SettingsCard>
        {projects.map((p) => {
          const pending = saving.isPending && saving.variables?.space === p.space && saving.variables.project === p.project;
          const mode = pending ? saving.variables!.mode : p.mode;
          return (
            <View key={`${p.space}:${p.project}`}>
              <SettingsSelect
                label={`${p.space_name} · ${p.project}`}
                hint="Looks at the cards of this project whose work is on the forge. Close needs the merged PR/MR to be the card's own, its checks to pass, every acceptance line ticked, and no QA, manual step, decision, claim or scope change left; it is done once and written on the card. Report only says what is left. In a project that is not Off a run's merged PR/MR ends it only the same way, and under Report not by itself at all. This Mac's choice: it is never shared through the plan."
                value={mode}
                options={MODES.map((m) => ({ label: m.label, value: m.value }))}
                disabled={saving.isPending}
                onValueChange={(next) => saving.mutate({ space: p.space, project: p.project, mode: next as (typeof MODES)[number]["value"], no_checks_ok: p.no_checks_ok })}
              />
              {mode !== "off" ? (
                <SettingsSwitch
                  label="A PR/MR with no check at all counts as verified"
                  hint="For a project without CI. Off: a merged PR/MR nothing checked is left to you."
                  value={pending ? saving.variables!.no_checks_ok : p.no_checks_ok}
                  disabled={saving.isPending}
                  onValueChange={(value) => saving.mutate({ space: p.space, project: p.project, mode, no_checks_ok: value })}
                />
              ) : null}
            </View>
          );
        })}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
