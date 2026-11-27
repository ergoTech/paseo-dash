import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  DELEGATED_ACTIONS,
  type DelegatedAction,
  type DelegationGrant,
  delegationAgentsRpc,
  delegationEnableRpc,
  delegationGrantRpc,
  delegationLogRpc,
  delegationReadRpc,
  delegationRevokeRpc,
  type ShownDelegationEntry,
} from "../shared/delegation.ts";
import { PLUGIN_NAME } from "../shared/edition.ts";
import { REFRESH_MS, Section, type Styles } from "./common.tsx";

/**
 * Delegated planning (shared/delegation.ts): in Settings, the owner's switch, the permissions with
 * what each allows and the latest changes; on a task, what coordinators changed there.
 */

const ACTION_LABEL: Record<DelegatedAction, string> = {
  drafts: "Write its own drafts",
  priority: "Set priority",
  dependencies: "Set dependencies",
};

const ACTION_HINT: Record<DelegatedAction, string> = {
  drafts: "Add Inbox drafts and edit the brief and acceptance of those it added",
  priority: "Of drafts and todo cards",
  dependencies: "Between cards of the project; it removes one from drafts only",
};

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

function outcome(entry: ShownDelegationEntry): string {
  if (entry.status === "refused") return `refused: ${entry.reason}`;
  if (entry.status === "queued") return "queued";
  return entry.pending ? "written here, waiting to be pushed" : "written";
}

/** Who, under which permission, and what: one entry in words. */
function describeChange(entry: ShownDelegationEntry): { title: string; detail: string } {
  const who = entry.title || entry.agent;
  const changes = entry.changes.map((c) => `${c.field}: ${c.from || "(none)"} → ${c.to || "(none)"}`).join("\n");
  const rule = `Rule: permission ${entry.grant} (${entry.actions.join(", ")} in ${entry.space}/${entry.project}), given ${when(entry.granted_at)}. Agent ${entry.agent}.`;
  return { title: `${when(entry.at)} · ${who} · ${outcome(entry)}`, detail: [changes, rule].filter(Boolean).join("\n") };
}

export function DelegationSettings() {
  const queryClient = useQueryClient();
  const read = useRpc(delegationReadRpc);
  const enable = useRpc(delegationEnableRpc);
  const grant = useRpc(delegationGrantRpc);
  const revoke = useRpc(delegationRevokeRpc);
  const state = useQuery({ queryKey: ["dashboard", "delegation"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  const saving = useMutation({
    mutationFn: (change: () => Promise<{ ok: boolean; error: string }>) => change(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "delegation"] }),
  });
  const data = state.data;
  const error =
    data?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "") || (state.isError ? String(state.error) : "");
  const toggle = (own: DelegationGrant, action: DelegatedAction, on: boolean) =>
    saving.mutate(() =>
      on
        ? grant({ agent: own.agent, space: own.space, project: own.project, actions: [...own.actions, action], revision: data?.revision ?? 0 })
        : revoke({ grant: own.id, action }),
    );
  return (
    <>
      <SettingsSection title="Delegated planning (pilot)">
        <SettingsCard>
          <SettingsSwitch
            label="Let appointed agents prepare cards"
            hint={`Off by default. An agent you appoint below gets tools to prepare the cards of one project; other agents keep what they had. It cannot start, move or mark tasks, or change a card with a live run or marked as a person's work. Needs Paseo 0.14 and a Claude, Codex, Copilot or OpenCode agent. The limit is on the tools ${PLUGIN_NAME} gives: an agent with an unrestricted shell on this Mac can reach Paseo's files and the plan repository itself.`}
            value={data?.enabled === true}
            disabled={!data || Boolean(data.error) || saving.isPending}
            onValueChange={(value) => saving.mutate(() => enable({ enabled: value }))}
            error={error || null}
          />
          {data?.paused ? <SettingsRow label="Paused" hint={data.paused} error={data.paused} /> : null}
          {data && !data.grants.length ? <SettingsRow label="No agent is appointed" /> : null}
        </SettingsCard>
      </SettingsSection>
      {(data?.grants ?? []).map((own) => (
        <SettingsSection key={own.id} title={`${own.title || own.agent} · ${own.space}/${own.project}`}>
          <SettingsCard>
            <SettingsRow label="Permission" hint={`${own.id} · agent ${own.agent} · given ${when(own.granted_at)}`} />
            {DELEGATED_ACTIONS.map((action) => (
              <SettingsSwitch
                key={action}
                label={ACTION_LABEL[action]}
                hint={ACTION_HINT[action]}
                value={own.actions.includes(action)}
                disabled={saving.isPending}
                onValueChange={(value) => toggle(own, action, value)}
              />
            ))}
            <SettingsAction
              label="Take the whole permission back"
              actionLabel="Revoke"
              disabled={saving.isPending}
              onPress={() => saving.mutate(() => revoke({ grant: own.id }))}
            />
          </SettingsCard>
        </SettingsSection>
      ))}
      {data?.enabled ? (
        <Appoint projects={data.projects} saving={saving.isPending} onGive={(input) => saving.mutate(() => grant({ ...input, revision: data.revision }))} />
      ) : null}
      {data?.changes.length ? (
        <SettingsSection title="Delegated changes, newest first">
          <SettingsCard>
            {data.changes.map((entry) => {
              const text = describeChange(entry);
              return <SettingsRow key={entry.op_id} label={`${entry.task || "new draft"} «${entry.task_title}»`} hint={`${text.title}\n${text.detail}`} />;
            })}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

interface Appointment {
  agent: string;
  space: string;
  project: string;
  actions: DelegatedAction[];
}

/** The form that appoints an agent: a project, an agent working in its repository, the actions. */
function Appoint({
  projects,
  saving,
  onGive,
}: {
  projects: { space: string; name: string; project: string }[];
  saving: boolean;
  onGive: (input: Appointment) => void;
}) {
  const list = useRpc(delegationAgentsRpc);
  const [chosen, setChosen] = useState("");
  const [agent, setAgent] = useState("");
  const [actions, setActions] = useState<DelegatedAction[]>([]);
  const [space = "", project = ""] = chosen.split("/");
  const agents = useQuery({
    queryKey: ["dashboard", "delegation", "agents", chosen],
    queryFn: () => list({ space, project }),
    enabled: Boolean(project),
  });
  const found = agents.data?.agents ?? [];
  const problem = agents.data?.error || (agents.isError ? String(agents.error) : "");
  return (
    <SettingsSection title="Appoint a coordinator">
      <SettingsCard>
        <SettingsSelect
          label="Project"
          value={chosen}
          options={projects.map((p) => ({ label: `${p.name} (${p.space}) · ${p.project}`, value: `${p.space}/${p.project}` }))}
          onValueChange={(value) => {
            setChosen(value);
            setAgent("");
          }}
        />
        <SettingsSelect
          label="Agent"
          hint={
            project && agents.data && !found.length
              ? "No open agent works in this project's repository. Create one there, then search again."
              : "Open agents working in the project's repository, with their permission mode; an agent in a mode that skips permission prompts is not held to this limit if it runs shell commands. Giving a permission replaces the one the agent had. Reload the agent afterwards: its tools come with the session's open."
          }
          value={agent}
          options={found.map((a) => ({ label: `${a.title || a.id} · ${[a.provider, a.mode].filter(Boolean).join(" ")} · ${a.id.slice(0, 8)}`, value: a.id }))}
          disabled={!project || !found.length}
          onValueChange={setAgent}
          error={problem || null}
        />
        <SettingsAction label="Search for agents again" actionLabel="Search" disabled={!project || agents.isFetching} onPress={() => void agents.refetch()} />
        {DELEGATED_ACTIONS.map((action) => (
          <SettingsSwitch
            key={action}
            label={ACTION_LABEL[action]}
            hint={ACTION_HINT[action]}
            value={actions.includes(action)}
            onValueChange={(value) => setActions((own) => (value ? [...own, action] : own.filter((other) => other !== action)))}
          />
        ))}
        <SettingsAction
          label="Give this permission"
          actionLabel="Give"
          disabled={saving || !agent || !project || !actions.length}
          onPress={() => onGive({ agent, space, project, actions })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** What coordinators changed, or asked to change, on one task; nothing at all when none did. */
export function DelegatedChanges({ task, styles }: { task: string; styles: Styles }) {
  const read = useRpc(delegationLogRpc);
  const log = useQuery({ queryKey: ["dashboard", "delegation", "task", task], queryFn: () => read({ task }), refetchInterval: REFRESH_MS });
  const changes = log.data?.changes ?? [];
  if (!changes.length) return null;
  return (
    <Section title="Delegated changes" styles={styles}>
      <Text style={styles.muted}>Made or asked for on this Mac, newest first</Text>
      {changes.map((entry) => {
        const text = describeChange(entry);
        return (
          <View key={entry.op_id}>
            <Text style={styles.text}>{text.title}</Text>
            <Text style={styles.muted}>{text.detail}</Text>
          </View>
        );
      })}
    </Section>
  );
}
