import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, type SettingsInputHandle, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useChanges } from "./changes.ts";
import { DelegationSettings } from "./delegation.tsx";
import { ManagedQueueSettings } from "./managed-queue.tsx";
import { ReconcileSettings } from "./reconcile.tsx";
import { RunSettings } from "./run-settings.tsx";
import { spacesAddRpc, spacesDisconnectRpc, spacesListRpc, spacesSyncRpc } from "../shared/spaces.ts";
import { PLAN_TOPIC, plansAvailableRpc, spacesCheckRpc } from "../shared/sharing.ts";
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  laconoteConfigureRpc,
  laconoteProjectsRpc,
  laconoteReleasesReadRpc,
  laconoteReleasesSetRpc,
  laconoteSettingsRpc,
} from "../shared/laconote.ts";
import { uiPrefsRpc, uiPrefsSetRpc } from "../shared/ui.ts";
import { planToolsSettingsRpc, planToolsSettingsSetRpc } from "../shared/plan-tools.ts";
import { issuesMirrorReadRpc, issuesMirrorSetRpc } from "../shared/issues.ts";
import { PLUGIN_NAME } from "../shared/edition.ts";

const SPACES_REFRESH_MS = 60_000;
/** Forge answers (plan repositories to connect, setup checks) are asked again only this often or on demand. */
const FORGE_STALE_MS = 10 * 60_000;

/** Settings → Plugins → Paseo Dash: connected plan repositories, their sync state, adding and disconnecting one. */
export function SpacesSettings({ theme, layout }: PluginSurfaceProps) {
  useChanges();
  const queryClient = useQueryClient();
  const list = useRpc(spacesListRpc);
  const add = useRpc(spacesAddRpc);
  const sync = useRpc(spacesSyncRpc);
  const disconnect = useRpc(spacesDisconnectRpc);
  const spaces = useQuery({ queryKey: ["dashboard", "spaces"], queryFn: () => list({}), refetchInterval: SPACES_REFRESH_MS });
  const [remote, setRemote] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const adding = useMutation({ mutationFn: () => add({ remote: remote.trim(), key: key.trim() || undefined, name: name.trim() || undefined }), onSettled: refresh });
  const syncing = useMutation({ mutationFn: (space: string) => sync({ space }), onSettled: refresh });
  // The space whose disconnect is being confirmed.
  const [confirming, setConfirming] = useState<string | undefined>();
  const disconnecting = useMutation({
    mutationFn: (space: string) => disconnect({ space }),
    onSuccess: (answer) => {
      if (!answer.ok) return;
      setConfirming(undefined);
      // The disconnected repository can be joined again: the list of joinable ones is read anew.
      void queryClient.invalidateQueries({ queryKey: ["dashboard-forge", "plans"] });
    },
    onSettled: refresh,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16, maxWidth: 760 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  const data = spaces.data;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {data && !data.owner ? <Text style={styles.error}>{data.reason}</Text> : null}
      {(data?.warnings ?? []).map((w) => (
        <Text key={w} style={styles.error}>
          {w}
        </Text>
      ))}
      {spaces.isError ? <Text style={styles.error}>{`Could not read the spaces: ${String(spaces.error)}`}</Text> : null}
      {(data?.spaces ?? []).map((space) => (
        <SettingsSection key={space.key} title={`${space.name} (${space.key})`}>
          <SettingsCard>
            <SettingsRow label="Plan repository" hint={`${space.remote} · ${space.branch}`} />
            <SettingsRow
              label="Sync"
              hint={
                space.error
                  ? `Not synced: ${space.error}`
                  : space.pending
                    ? `${space.pending} change(s) waiting to be pushed`
                    : space.last_sync
                      ? `Synced at ${space.last_sync}`
                      : "Not synced yet"
              }
              error={space.error || null}
            />
            <SettingsRow label="Tasks" hint={String(space.tasks)} />
            <SettingsRow label="Projects" hint={`Added, ordered, colored and mapped on the Projects tab of ${PLUGIN_NAME}`} />
            {space.mapping.map((m) => (
              <SettingsRow key={m.project} label={`Project ${m.project}`} hint={m.local ? `mapped to ${m.local}` : "not mapped on this Mac"} />
            ))}
            {space.conflicts.map((c) => (
              <SettingsRow key={`${c.id}-${c.at}`} label={`Conflict on ${c.id}`} hint={c.reason} error={c.reason} />
            ))}
            {space.problems.map((p) => (
              <SettingsRow key={p.path} label={`Problem in ${p.path}`} hint={p.reason} error={p.reason} />
            ))}
            {space.warnings.map((w) => (
              <SettingsRow key={w} label="Warning" hint={w} error={w} />
            ))}
            <SetupCheck space={space.key} />
            <IssueMirrorSettings space={space.key} />
            <ReleaseContextSettings space={space.key} />
            {space.late_claims ? (
              <SettingsRow label="Late claims" hint={`${space.late_claims} start(s) landed after they were reported as not started`} />
            ) : null}
            <SettingsAction label="Sync now" actionLabel="Sync" disabled={syncing.isPending} onPress={() => syncing.mutate(space.key)} />
            {confirming === space.key ? (
              <SettingsRow
                label={`Disconnect ${space.name} from this machine?`}
                hint={
                  "The plan repository and its remote are not touched: nothing is pushed or deleted there, and other machines keep working with it. " +
                  "Only this machine stops syncing it: its local clone is deleted here and the space leaves the sidebar. " +
                  "It is refused while changes are not pushed yet, a start is being decided or created, or a task has a live run on this machine. " +
                  "A start this machine reported as not started may still land later: it then shows on the plan repository as a live run of this machine, which any machine can release. " +
                  "Connecting the same repository again clones it afresh."
                }
              />
            ) : null}
            {confirming === space.key ? (
              <SettingsAction
                label={`Disconnect ${space.key}`}
                actionLabel={disconnecting.isPending ? "Disconnecting…" : "Disconnect"}
                disabled={disconnecting.isPending}
                error={disconnecting.variables === space.key && disconnecting.data && !disconnecting.data.ok ? disconnecting.data.error : null}
                onPress={() => disconnecting.mutate(space.key)}
              />
            ) : null}
            {confirming === space.key ? (
              <SettingsAction label="Keep the space" actionLabel="Cancel" disabled={disconnecting.isPending} onPress={() => setConfirming(undefined)} />
            ) : (
              <SettingsAction
                label="Disconnect from this machine"
                actionLabel="Disconnect…"
                onPress={() => {
                  disconnecting.reset();
                  setConfirming(space.key);
                }}
              />
            )}
          </SettingsCard>
        </SettingsSection>
      ))}
      <AvailablePlans />
      <SettingsSection title="Connect a plan repository">
        <SettingsCard>
          <SettingsInput label="Clone URL" placeholder="git@github.com:org/plan.git" onChangeText={setRemote} />
          <SettingsInput label="Key" hint="Only for a new repository (empty, or with only a README): 2-6 capital letters, the id prefix" placeholder="LAC" onChangeText={setKey} />
          <SettingsInput label="Name" hint="Only for a new repository (empty, or with only a README)" placeholder="Laconote" onChangeText={setName} />
          <SettingsAction
            label="Connect"
            actionLabel={adding.isPending ? "Connecting…" : "Connect"}
            disabled={adding.isPending || !remote.trim()}
            error={adding.data && !adding.data.ok ? adding.data.error : null}
            onPress={() => adding.mutate()}
          />
        </SettingsCard>
        {adding.data?.ok ? <Text style={styles.muted}>{`Connected ${adding.data.key}.`}</Text> : null}
      </SettingsSection>
      <RunSettings />
      {(data?.spaces.length ?? 0) > 1 ? <SidebarSettings onSaved={refresh} /> : null}
      <LaconoteSettings onSaved={refresh} />
      <PlanToolsSettings />
      <DelegationSettings />
      <ManagedQueueSettings />
      <ReconcileSettings styles={styles} />
      <View />
    </ScrollView>
  );
}

/**
 * The setup check of one space (server/spaces/sharing.ts): a fact the forge holds, so it is asked
 * once per FORGE_STALE_MS, not on every poll; it shows only what needs fixing or could not be read.
 */
function SetupCheck({ space }: { space: string }) {
  const check = useRpc(spacesCheckRpc);
  const answer = useQuery({ queryKey: ["dashboard-forge", "check", space], queryFn: () => check({ space }), staleTime: FORGE_STALE_MS });
  const data = answer.data;
  if (answer.isError) return <SettingsRow label="Setup not checked" hint={String(answer.error)} />;
  if (!data) return null;
  if (!data.checked) return <SettingsRow label="Setup not checked" hint={data.error} />;
  return (
    <>
      {data.problems.map((p) => (
        <SettingsRow key={p.problem} label={`Setup: ${p.problem}`} hint={`Fix: ${p.fix}`} error={p.problem} />
      ))}
    </>
  );
}

/**
 * The issue mirror of one space on this machine (09-forge-issues.md, the mirror). Turning it on asks
 * first and names the repositories the forge says are public, since briefs become issue text there.
 */
function IssueMirrorSettings({ space }: { space: string }) {
  const queryClient = useQueryClient();
  const read = useRpc(issuesMirrorReadRpc);
  const write = useRpc(issuesMirrorSetRpc);
  const status = useQuery({ queryKey: ["dashboard", "mirror", space], queryFn: () => read({ space }), refetchInterval: SPACES_REFRESH_MS });
  const [confirming, setConfirming] = useState(false);
  // Read only while a person is deciding: it asks the forge.
  const repos = useQuery({
    queryKey: ["dashboard-forge", "mirror-repos", space],
    queryFn: () => read({ space, visibility: true }),
    enabled: confirming,
    staleTime: FORGE_STALE_MS,
  });
  const saving = useMutation({
    mutationFn: (change: { on: boolean; confirmed?: boolean }) => write({ space, ...change }),
    onSuccess: (answer) => {
      if (answer.ok) setConfirming(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "mirror", space] }),
  });
  const data = status.data;
  if (status.isError) return <SettingsRow label="Mirror issues" hint={String(status.error)} error={String(status.error)} />;
  if (!data) return null;
  const error = data.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "");
  const listed = repos.data?.repositories ?? [];
  // The mirror writes only where this login may push: a public repository it may not is not at risk.
  const open = listed.filter((r) => r.visibility === "public" && r.write);
  const unknown = listed.filter((r) => r.visibility === "unknown");
  const skipped = listed.filter((r) => r.visibility !== "unknown" && !r.write);
  return (
    <>
      <SettingsSwitch
        label="Mirror issues"
        hint={
          data.on
            ? "This machine writes an issue for every accepted task in its project's repository and keeps it equal to the task. Keep it on on one machine only."
            : "Off on this machine: nothing is written to the forge from here. Turn it on on one machine only."
        }
        value={saving.isPending ? Boolean(saving.variables?.on) : data.on || confirming}
        disabled={saving.isPending}
        onValueChange={(value) => {
          saving.reset();
          if (value) setConfirming(true);
          else if (confirming) setConfirming(false);
          else saving.mutate({ on: false });
        }}
        error={error || null}
      />
      {confirming ? (
        <SettingsRow
          label="Mirror this space's tasks as issues?"
          hint={
            "Every task from todo onwards that has no issue gets one in its project's repository, through this machine's gh or glab login; the issue's link is written to the task. " +
            "Its title, brief, labels, assignee (from People) and state follow the task: done or canceled closes the issue, reopening the task reopens it, and edits made on the forge are overwritten by the task's next change. " +
            "Issues linked or imported by hand are never written. In a public repository the brief becomes public. " +
            "Only one machine should mirror a space: two would each make an issue for the same task."
          }
        />
      ) : null}
      {confirming && repos.isPending ? <SettingsRow label="Asking the forges which repositories are public…" /> : null}
      {confirming && repos.isError ? <SettingsRow label="Not checked whether the repositories are public" hint={String(repos.error)} /> : null}
      {confirming && open.length ? (
        <SettingsRow
          label={`Public: ${open.map((r) => r.repository).join(", ")}`}
          hint="Anyone can read the issues the mirror writes there, briefs included."
          error="public repository"
        />
      ) : null}
      {confirming && skipped.length ? (
        <SettingsRow label={`Not mirrored: ${skipped.map((r) => r.repository).join(", ")}`} hint="You cannot push there, so their tasks get no issue." />
      ) : null}
      {confirming && repos.data && !open.length && !unknown.length ? <SettingsRow label="No repository the mirror writes to is public" /> : null}
      {confirming
        ? unknown.map((r) => <SettingsRow key={r.project} label={`Not checked whether ${r.repository} is public`} hint={r.note} />)
        : null}
      {confirming ? (
        <SettingsAction
          label="Mirror issues from this machine"
          actionLabel={saving.isPending ? "Turning on…" : "Turn on"}
          disabled={saving.isPending}
          onPress={() => saving.mutate({ on: true, confirmed: true })}
        />
      ) : null}
      {confirming ? <SettingsAction label="Leave it off" actionLabel="Cancel" disabled={saving.isPending} onPress={() => setConfirming(false)} /> : null}
      {data.on ? (
        <SettingsRow label="Mirrored issues" hint={`${data.mirrored} mirrored${data.waiting ? `, ${data.waiting} waiting to be written` : ""}`} />
      ) : null}
      {data.paused.map((p) => (
        <SettingsRow key={p} label="Forge asked to slow down" hint={`Nothing more is written to ${p}`} />
      ))}
      {data.read_only.map((repo) => (
        <SettingsRow key={repo} label="Not mirrored" hint={`${repo}: you cannot push there, so its tasks get no issue (anyone may open one in a public repository).`} />
      ))}
      {data.problems.map((p) => (
        <SettingsRow key={p.task} label={`Issue of ${p.task} not written yet`} hint={`${p.error} It is tried again.`} error={p.error} />
      ))}
    </>
  );
}

/**
 * The release context of one space on this machine (05-architecture.md, Release context): each project
 * picks the Laconote project whose delivery meetings get its open milestones; what was sent shows below.
 */
function ReleaseContextSettings({ space }: { space: string }) {
  const queryClient = useQueryClient();
  const read = useRpc(laconoteReleasesReadRpc);
  const list = useRpc(laconoteProjectsRpc);
  const write = useRpc(laconoteReleasesSetRpc);
  const status = useQuery({ queryKey: ["dashboard", "releases", space], queryFn: () => read({ space }), refetchInterval: SPACES_REFRESH_MS });
  const keySet = status.data?.key_set === true;
  // Laconote's project list is asked once per FORGE_STALE_MS, not on every poll.
  // Under "dashboard", so saving another key reads the list anew.
  const projects = useQuery({ queryKey: ["dashboard", "laconote", "projects"], queryFn: () => list({}), enabled: keySet, staleTime: FORGE_STALE_MS });
  const saving = useMutation({
    mutationFn: (change: { project: string; laconote: string }) => write({ space, ...change }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "releases", space] }),
  });
  const data = status.data;
  if (status.isError) return <SettingsRow label="Release context" hint={String(status.error)} error={String(status.error)} />;
  if (!data) return null;
  if (data.error) return <SettingsRow label="Release context" hint={data.error} error={data.error} />;
  const known = projects.data?.projects ?? [];
  const nameOf = (id: string) => known.find((p) => p.id === id)?.name ?? id;
  // Laconote takes the set from owners and maintainers only; the others are listed last.
  const writable = (role: string) => role === "owner" || role === "maintainer";
  const listed = [...known].sort((a, b) => Number(writable(b.role)) - Number(writable(a.role)) || a.name.localeCompare(b.name));
  const failed = saving.data && !saving.data.ok ? saving.data.error : saving.isError ? String(saving.error) : "";
  return (
    <>
      <SettingsRow
        label="Release context"
        hint={
          keySet
            ? "Delivery meetings of a Laconote project show the release, its due date and the days left from the open milestones of the projects mapped to it here. Map them on one machine only."
            : "Set a Laconote key below (with the release:write scope) to send this space's releases to Laconote's delivery meetings."
        }
      />
      {keySet && projects.data?.error ? <SettingsRow label="Laconote projects not read" hint={projects.data.error} error={projects.data.error} /> : null}
      {keySet
        ? data.mapping.map((m) => (
            <SettingsSelect
              key={m.project}
              label={`Releases of ${m.project}`}
              hint={m.laconote ? `Sent to ${nameOf(m.laconote)}` : "Not sent to Laconote"}
              value={saving.isPending && saving.variables?.project === m.project ? saving.variables.laconote : m.laconote}
              options={[
                { label: "Not sent", value: "" },
                ...listed.map((p) => ({ label: writable(p.role) ? p.name : `${p.name} (${p.role || "no role"}: cannot write)`, value: p.id })),
                ...(m.laconote && !known.some((p) => p.id === m.laconote) ? [{ label: m.laconote, value: m.laconote }] : []),
              ]}
              disabled={saving.isPending}
              onValueChange={(laconote) => saving.mutate({ project: m.project, laconote })}
            />
          ))
        : null}
      {failed ? <SettingsRow label="Not saved" hint={failed} error={failed} /> : null}
      {data.sets.map((set) => (
        <SettingsRow
          key={set.laconote}
          label={`To ${nameOf(set.laconote)} (${set.projects.join(", ")})`}
          hint={[
            set.releases.length
              ? set.releases.map((r) => `${r.name} due ${r.due}${r.progress === null ? "" : `, ${r.progress}% done`}`).join(" · ")
              : "No open milestone with a due date: an empty set is sent",
            set.undated.length ? `Not sent, no due date: ${set.undated.map((u) => u.title).join(", ")}` : "",
            set.error ? `${set.error.replace(/[.\s]*$/, "")}. It is tried again.` : set.waiting ? "Waiting to be sent" : `Sent at ${set.sent_at}`,
          ]
            .filter(Boolean)
            .join("\n")}
          error={set.error || null}
        />
      ))}
    </>
  );
}

/**
 * Plan repositories this machine's gh and glab logins can read, with the plan topic, that are not
 * connected yet: one tap connects one (09-forge-issues.md, F4).
 */
function AvailablePlans() {
  const queryClient = useQueryClient();
  const available = useRpc(plansAvailableRpc);
  const add = useRpc(spacesAddRpc);
  const plans = useQuery({ queryKey: ["dashboard-forge", "plans"], queryFn: () => available({}), staleTime: FORGE_STALE_MS });
  const connecting = useMutation({
    mutationFn: (remote: string) => add({ remote }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard-forge", "plans"] });
    },
  });
  const data = plans.data;
  const failed = connecting.data && !connecting.data.ok ? connecting.data.error : null;
  return (
    <SettingsSection title="Plan repositories you can join">
      <SettingsCard>
        {plans.isError ? <SettingsRow label="Not searched" hint={String(plans.error)} error={String(plans.error)} /> : null}
        {plans.isPending ? <SettingsRow label="Searching GitHub and GitLab…" /> : null}
        {data && data.plans.length === 0 ? (
          <SettingsRow
            label="None to connect"
            hint={`Plan repositories carry the topic ${PLAN_TOPIC}. One you were invited to shows here once you accept the invitation on GitHub or GitLab.`}
          />
        ) : null}
        {data?.plans.map((plan) => (
          <SettingsAction
            key={plan.web_url || plan.remote}
            label={`${plan.path} · ${plan.host}`}
            hint={[plan.description, plan.remote].filter(Boolean).join(" · ")}
            actionLabel={connecting.isPending && connecting.variables === plan.remote ? "Connecting…" : "Connect"}
            disabled={connecting.isPending}
            onPress={() => connecting.mutate(plan.remote)}
          />
        ))}
        {data?.notes.map((note) => (
          <SettingsRow key={note} label="Not searched" hint={note} />
        ))}
        {failed ? <SettingsRow label="Not connected" hint={failed} error={failed} /> : null}
        <SettingsAction label="Search again" actionLabel="Search" disabled={plans.isFetching} onPress={() => void plans.refetch()} />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * With several spaces the sidebar has one "Paseo Dash" row for all of them (04-ux.md, Surfaces); a row
 * per space next to it is this machine's choice, off unless turned on here.
 */
function SidebarSettings({ onSaved }: { onSaved: () => void }) {
  const read = useRpc(uiPrefsRpc);
  const write = useRpc(uiPrefsSetRpc);
  const prefs = useQuery({ queryKey: ["dashboard", "prefs"], queryFn: () => read({}) });
  const saving = useMutation({ mutationFn: (space_rows: boolean) => write({ space_rows }), onSettled: onSaved });
  const error = prefs.data?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "");
  return (
    <SettingsSection title="Sidebar">
      <SettingsCard>
        <SettingsSwitch
          label="A row per space"
          hint={`Besides the ${PLUGIN_NAME} row, which shows every space`}
          value={saving.isPending ? Boolean(saving.variables) : saving.data?.ok ? saving.data.space_rows : prefs.data?.space_rows === true}
          disabled={!prefs.data || saving.isPending}
          onValueChange={(value) => saving.mutate(value)}
          error={error || null}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Whether every agent on this machine whose repository is a project of a connected space gets the
 * plan tools (server/agent-tools/plan.ts). Off by default.
 */
function PlanToolsSettings() {
  const read = useRpc(planToolsSettingsRpc);
  const write = useRpc(planToolsSettingsSetRpc);
  const settings = useQuery({ queryKey: ["dashboard", "plan-tools", "settings"], queryFn: () => read({}) });
  const saving = useMutation({ mutationFn: (enabled: boolean) => write({ enabled }), onSettled: () => settings.refetch() });
  const error = settings.data?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "");
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSwitch
          label="Plan tools for every agent"
          hint="Agents on this Mac working in a repository of a connected space can search its plan, read a task and add a draft to the Inbox. They cannot start, move or edit tasks. Takes effect when an agent's session next opens; needs Paseo 0.14 and a Claude, Codex, Copilot or OpenCode agent."
          value={saving.isPending || (saving.isSuccess && settings.isFetching) ? Boolean(saving.variables) : settings.data?.enabled === true}
          disabled={!settings.data || saving.isPending}
          onValueChange={(value) => saving.mutate(value)}
          error={error || null}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * This machine's Laconote connection (05-architecture.md, Laconote import). The key goes to the
 * daemon once and is never shown again: the screen knows only whether one is set.
 */
function LaconoteSettings({ onSaved }: { onSaved: () => void }) {
  const read = useRpc(laconoteSettingsRpc);
  const configure = useRpc(laconoteConfigureRpc);
  const settings = useQuery({ queryKey: ["dashboard", "laconote", "settings"], queryFn: () => read({}) });
  const [apiUrl, setApiUrl] = useState<string | undefined>();
  const [webUrl, setWebUrl] = useState<string | undefined>();
  const [key, setKey] = useState("");
  const keyInput = useRef<SettingsInputHandle>(null);
  const saving = useMutation({
    mutationFn: (change: { api_url?: string; web_url?: string; key?: string; clear_key?: boolean }) => configure(change),
    onSuccess: (answer) => {
      if (!answer.ok) return;
      // What the daemon stored (normalised) is the value now; the typed text no longer counts as a change.
      setApiUrl(undefined);
      setWebUrl(undefined);
      // The typed key does not stay on screen once the daemon has it.
      setKey("");
      keyInput.current?.replaceText("");
    },
    onSettled: onSaved,
  });
  const data = settings.data;
  if (!data) return settings.isError ? <SettingsSection title="Laconote"><SettingsCard><SettingsRow label="Laconote" hint={String(settings.error)} error={String(settings.error)} /></SettingsCard></SettingsSection> : null;
  const urlsChanged = (apiUrl !== undefined && apiUrl.trim() !== data.api_url) || (webUrl !== undefined && webUrl.trim() !== data.web_url);
  const error = saving.data && !saving.data.ok ? saving.data.error : null;
  return (
    <SettingsSection title="Laconote">
      <SettingsCard>
        {data.error ? <SettingsRow label="Unavailable" hint={data.error} error={data.error} /> : null}
        <SettingsInput
          label="API URL"
          hint={`Where meetings are read from; empty: ${DEFAULT_API_URL}. Moving to another server drops the stored key: set the key again after saving the URL.`}
          initialValue={data.api_url}
          placeholder={DEFAULT_API_URL}
          onChangeText={setApiUrl}
        />
        <SettingsInput
          label="Web URL"
          hint={`For a draft's meeting link, <web URL>/meeting/<id>; empty: ${DEFAULT_WEB_URL}`}
          initialValue={data.web_url}
          placeholder={DEFAULT_WEB_URL}
          onChangeText={setWebUrl}
        />
        <SettingsAction
          label="Save the URLs"
          actionLabel="Save"
          disabled={saving.isPending || !urlsChanged}
          onPress={() => saving.mutate({ api_url: apiUrl, web_url: webUrl })}
        />
        <SettingsRow label="API key" hint={data.key_set ? "A key is set on this machine" : "No key is set: the import reads pasted exports only"} />
        <SettingsInput
          label={data.key_set ? "Replace the key" : "Set a key"}
          hint="A read-only key is enough for the import; sending release context also needs the release:write scope. It stays on this machine and is never shown again."
          placeholder="lac_…"
          secureTextEntry
          ref={keyInput}
          onChangeText={setKey}
        />
        <SettingsAction label="Save the key" actionLabel="Set key" disabled={saving.isPending || !key.trim()} onPress={() => saving.mutate({ key })} />
        {data.key_set ? (
          <SettingsAction label="Remove the key from this machine" actionLabel="Clear key" disabled={saving.isPending} onPress={() => saving.mutate({ clear_key: true })} />
        ) : null}
        {error ? <SettingsRow label="Not saved" hint={error} error={error} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
