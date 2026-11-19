import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  LINE_COLORS,
  projectsAddRpc,
  projectsCloneRpc,
  projectsListRpc,
  projectsMapRpc,
  projectsMoveRpc,
  projectsRemoveRpc,
  projectsUpdateRpc,
  repoNameOf,
  suggestKey,
} from "../shared/projects.ts";
import { Button, LineBadge, Section, type Styles } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";

/**
 * The space's projects, the lines of its map (02-product.md, D18): one plan repository holds every
 * project; this tab lists them with where each lives on this machine, adds this machine's Paseo
 * projects or any repository by URL, orders, colors and groups the lines, maps a line by hand,
 * clones a missing one into Paseo, and removes a line without open tasks.
 */

type Theme = PluginHostProps["theme"];
type List = RpcOutput<typeof projectsListRpc>;
type Line = List["projects"][number];

/** Reading every Paseo project's remote runs git per project: once a minute, and a moved token does not start it (client/changes.ts). */
const PROJECTS_REFRESH_MS = 60_000;

/** "Add all" of a space: while it runs, a candidate's own Add would race it and hear "already lists". */
const addAllKey = (space: string) => ["dashboard", "projects", "add-all", space];

export function Swatches({ value, onPick, theme, what = "Line color" }: { value: string; onPick: (color: string) => void; theme: Theme; what?: string }) {
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {LINE_COLORS.map((color) => {
        const chosen = color === value;
        return (
          <Pressable
            key={color}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={`${what} ${color}`}
            onPress={() => onPick(color)}
            style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: chosen ? theme.colors.foreground : "transparent", alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: color }}>
              {chosen ? <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800", textAlign: "center", lineHeight: 20 }}>✓</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** An action's error under it: the call failing, or the answer saying no; nothing while it is fine. */
export function Problem({ action, styles }: { action: { isError: boolean; error: unknown; data?: { error: string } }; styles: Styles }) {
  const error = action.isError ? String((action.error as Error)?.message ?? action.error) : action.data?.error;
  return error ? <Text style={styles.error}>{error}</Text> : null;
}

function LineEditor({ space, line, list, styles, theme }: { space: string; line: Line; list: List; styles: Styles; theme: Theme }) {
  const refresh = useRefresh();
  const update = useRpc(projectsUpdateRpc);
  const map = useRpc(projectsMapRpc);
  const clone = useRpc(projectsCloneRpc);
  const remove = useRpc(projectsRemoveRpc);
  const [group, setGroup] = useState(line.group);
  const [trunk, setTrunk] = useState(line.trunk);
  const [webHost, setWebHost] = useState(line.web_host);
  useEffect(() => setWebHost(line.web_host), [line.web_host]);
  // A change saved elsewhere ("Move to …", another machine) replaces what the fields show.
  useEffect(() => setGroup(line.group), [line.group]);
  useEffect(() => setTrunk(line.trunk), [line.trunk]);
  const [directory, setDirectory] = useState(list.clone_parent ? `${list.clone_parent}/${repoNameOf(line.remote)}` : "");
  const [confirming, setConfirming] = useState(false);
  const updating = useMutation({ mutationFn: (fields: { color?: string; group?: string; trunk?: string; web_host?: string }) => update({ space, project: line.key, ...fields }), onSettled: refresh });
  const mapping = useMutation({ mutationFn: (local: string) => map({ space, project: line.key, local_project: local }), onSettled: refresh });
  const cloning = useMutation({ mutationFn: () => clone({ space, project: line.key, directory: directory.trim() }), onSettled: refresh });
  const removing = useMutation({ mutationFn: () => remove({ space, project: line.key }), onSettled: refresh });
  const mappedByHand = line.override ? (line.local?.project_id ?? "") : "";

  return (
    <View style={{ gap: 12, paddingTop: 8 }}>
      <View style={{ gap: 6 }}>
        <Text style={styles.muted}>{line.color_set ? "Line color" : "Line color (the default for its place)"}</Text>
        <Swatches value={line.color} onPick={(color) => updating.mutate({ color })} theme={theme} />
        {line.color_set ? <Button label="Back to the default color" ghost onPress={() => updating.mutate({ color: "" })} styles={styles} /> : null}
      </View>
      <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-end" }]}>
        <View style={{ flexGrow: 1, minWidth: 180 }}>
          <Field label="Group (an umbrella such as Laconote; lines of a group stay together)" value={group} onChange={setGroup} styles={styles} theme={theme} placeholder="none" />
        </View>
        <Button label="Save group" ghost disabled={group.trim() === line.group} onPress={() => updating.mutate({ group: group.trim() })} styles={styles} />
      </View>
      {list.groups.length ? (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          {list.groups
            .filter((g) => g !== line.group)
            .map((g) => (
              <Button key={g} label={`Move to ${g}`} ghost onPress={() => updating.mutate({ group: g })} styles={styles} />
            ))}
        </View>
      ) : null}
      <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-end" }]}>
        <View style={{ flexGrow: 1, minWidth: 180 }}>
          <Field label="Base branch for task branches" value={trunk} onChange={setTrunk} styles={styles} theme={theme} placeholder="the repository's default" />
        </View>
        <Button label="Save branch" ghost disabled={trunk.trim() === line.trunk} onPress={() => updating.mutate({ trunk: trunk.trim() })} styles={styles} />
      </View>
      <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-end" }]}>
        <View style={{ flexGrow: 1, minWidth: 180 }}>
          <Field
            label="Web host of its issues and PR/MRs, when the remote's host differs (git-ssh.example.com → git.example.com)"
            value={webHost}
            onChange={setWebHost}
            styles={styles}
            theme={theme}
            placeholder="the remote's host"
          />
        </View>
        <Button label="Save web host" ghost disabled={webHost.trim() === line.web_host} onPress={() => updating.mutate({ web_host: webHost.trim() })} styles={styles} />
      </View>
      <Problem action={updating} styles={styles} />

      <View style={{ gap: 6 }}>
        <Text style={styles.heading}>On this Mac</Text>
        <Text style={styles.muted}>
          {line.local ? `${line.override ? "Mapped by hand to" : "Found by its remote:"} ${line.local.name} · ${line.local.root}` : "No Paseo project here has this remote. Clone it, or pick the checkout it lives in."}
        </Text>
        {list.local.length ? (
          <Choice
            label="Paseo project to start this line's tasks in"
            none="Match by remote"
            value={mappedByHand}
            options={list.local.map((p) => ({ value: p.project_id, label: p.name }))}
            onChange={(value) => mapping.mutate(value)}
            styles={styles}
          />
        ) : null}
        <Problem action={mapping} styles={styles} />
        {!line.local ? (
          <View style={{ gap: 6 }}>
            <Field label="Clone into (a new directory)" value={directory} onChange={setDirectory} styles={styles} theme={theme} placeholder="/Users/me/Development/repo" />
            <Button
              label={cloning.isPending ? "Cloning…" : "Clone and open in Paseo"}
              disabled={cloning.isPending || !directory.trim()}
              onPress={() => cloning.mutate()}
              styles={styles}
            />
            {cloning.data?.ok ? <Text style={styles.muted}>{cloning.data.done ? `Cloned into ${cloning.data.directory}.` : "Still cloning in the background; the line maps itself when Paseo opens it."}</Text> : null}
            <Problem action={cloning} styles={styles} />
          </View>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>
        {line.open_tasks ? (
          <Text style={styles.muted}>{`${line.open_tasks} open task(s) use ${line.key}; finish or move them before removing the line.`}</Text>
        ) : confirming ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.text}>{`Remove ${line.key} from the map? Finished tasks keep its name.`}</Text>
            <View style={styles.row}>
              <Button label="Remove" onPress={() => removing.mutate()} disabled={removing.isPending} styles={styles} />
              <Button label="Cancel" ghost onPress={() => setConfirming(false)} styles={styles} />
            </View>
          </View>
        ) : (
          <Button label="Remove from the map…" ghost onPress={() => setConfirming(true)} styles={styles} />
        )}
        <Problem action={removing} styles={styles} />
      </View>
    </View>
  );
}

function LineRow({ space, line, index, count, list, open, onToggle, styles, theme }: {
  space: string;
  line: Line;
  index: number;
  count: number;
  list: List;
  open: boolean;
  onToggle: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const refresh = useRefresh();
  const move = useRpc(projectsMoveRpc);
  const moving = useMutation({ mutationFn: (offset: -1 | 1) => move({ space, project: line.key, offset }), onSettled: refresh });
  const arrow = (label: string, offset: -1 | 1, disabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Move ${line.key} ${offset < 0 ? "up" : "down"}`}
      disabled={disabled || moving.isPending}
      onPress={() => moving.mutate(offset)}
      style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 1, backgroundColor: theme.colors.surface2 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
  const where = line.local ? `✓ ${line.local.root}` : "not on this Mac";
  return (
    <View style={[styles.card, { borderLeftWidth: 5, borderLeftColor: line.color }]}>
      <View style={[styles.row, { alignItems: "center" }]}>
        <View style={{ gap: 4 }}>
          {arrow("▲", -1, index === 0)}
          {arrow("▼", 1, index === count - 1)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "Close" : "Edit"} ${line.key}`} onPress={onToggle} style={{ flex: 1, gap: 4 }}>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <LineBadge project={line.key} color={line.color} theme={theme} />
            {line.group ? <Text style={styles.muted}>{line.group}</Text> : null}
            <Text style={styles.muted}>{line.trunk ? `base ${line.trunk}` : ""}</Text>
          </View>
          <Text numberOfLines={1} style={styles.muted}>
            {line.remote}
          </Text>
          <Text numberOfLines={1} style={[styles.muted, { color: line.local ? theme.colors.foregroundMuted : theme.colors.statusWarning }]}>
            {`${where}${line.open_tasks ? ` · ${line.open_tasks} open` : ""}`}
          </Text>
          {line.shared_with.length ? (
            <Text style={[styles.muted, { color: theme.colors.statusWarning }]}>
              {`Also a line in ${line.shared_with.join(", ")}: the same repository, with its own tasks in each plan and nothing synced between them. Where this Mac maps them to the same Paseo project, its workspaces count under each line.`}
            </Text>
          ) : null}
        </Pressable>
        <Text style={styles.muted}>{open ? "▾" : "▸"}</Text>
      </View>
      <Problem action={moving} styles={styles} />
      {open ? <LineEditor space={space} line={line} list={list} styles={styles} theme={theme} /> : null}
    </View>
  );
}

function Candidate({ space, candidate, group, highlight, styles, theme }: {
  space: string;
  candidate: List["candidates"][number];
  group: string;
  highlight: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const refresh = useRefresh();
  const add = useRpc(projectsAddRpc);
  const [key, setKey] = useState(candidate.key);
  const addingAll = useIsMutating({ mutationKey: addAllKey(space) }) > 0;
  const adding = useMutation({
    mutationFn: () => add({ space, key: key.trim(), remote: candidate.remote, trunk: candidate.trunk || undefined, group: group.trim() || undefined }),
    onSettled: refresh,
  });
  return (
    <View style={[styles.card, highlight ? { borderColor: theme.colors.accent, borderWidth: 2 } : null]}>
      <Text style={styles.text}>{candidate.name}</Text>
      <Text numberOfLines={1} style={styles.muted}>{`${candidate.remote}${candidate.trunk ? ` · base ${candidate.trunk}` : ""}`}</Text>
      <Text numberOfLines={1} style={styles.muted}>
        {candidate.root}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap", alignItems: "flex-end" }]}>
        <View style={{ flexGrow: 1, minWidth: 140 }}>
          <Field label="Key (tasks name it; it never changes)" value={key} onChange={setKey} styles={styles} theme={theme} />
        </View>
        <Button label={adding.isPending ? "Adding…" : "Add line"} disabled={adding.isPending || addingAll || !key.trim()} onPress={() => adding.mutate()} styles={styles} />
      </View>
      <Problem action={adding} styles={styles} />
    </View>
  );
}

function AddByUrl({ space, taken, group, styles, theme }: { space: string; taken: string[]; group: string; styles: Styles; theme: Theme }) {
  const refresh = useRefresh();
  const add = useRpc(projectsAddRpc);
  const [remote, setRemote] = useState("");
  const [key, setKey] = useState("");
  const [trunk, setTrunk] = useState("");
  const shownKey = key || (remote.trim() ? suggestKey(remote, taken) : "");
  const adding = useMutation({
    mutationFn: () => add({ space, key: shownKey.trim(), remote: remote.trim(), trunk: trunk.trim() || undefined, group: group.trim() || undefined }),
    onSuccess: (answer) => {
      if (!answer.ok) return;
      setRemote("");
      setKey("");
      setTrunk("");
    },
    onSettled: refresh,
  });
  return (
    <View style={styles.card}>
      <Field label="Clone URL" value={remote} onChange={setRemote} styles={styles} theme={theme} placeholder="git@github.com:org/repo.git" />
      <Field label="Key" value={shownKey} onChange={setKey} styles={styles} theme={theme} placeholder="core" />
      <Field label="Base branch (empty: read from the repository)" value={trunk} onChange={setTrunk} styles={styles} theme={theme} placeholder="main" />
      <Button label={adding.isPending ? "Adding…" : "Add line"} disabled={adding.isPending || !remote.trim() || !shownKey.trim()} onPress={() => adding.mutate()} styles={styles} />
      <Problem action={adding} styles={styles} />
    </View>
  );
}

/** Adds every offered Paseo project with its suggested key, one after another, into the chosen group. */
function AddAll({ space, candidates, group, styles }: { space: string; candidates: List["candidates"]; group: string; styles: Styles }) {
  const refresh = useRefresh();
  const add = useRpc(projectsAddRpc);
  const adding = useMutation({
    mutationKey: addAllKey(space),
    mutationFn: async () => {
      const problems: string[] = [];
      for (const c of candidates) {
        const answer = await add({ space, key: c.key, remote: c.remote, trunk: c.trunk || undefined, group: group.trim() || undefined }).catch((error: unknown) => ({
          ok: false,
          error: String((error as Error)?.message ?? error),
        }));
        if (!answer.ok) problems.push(`${c.name}: ${answer.error}`);
      }
      return { ok: problems.length === 0, error: problems.join("; ") };
    },
    onSettled: refresh,
  });
  return (
    <View style={{ gap: 4 }}>
      <Button
        label={adding.isPending ? "Adding…" : `Add all ${candidates.length}${group.trim() ? ` to ${group.trim()}` : " without a group"}`}
        ghost
        disabled={adding.isPending}
        onPress={() => adding.mutate()}
        styles={styles}
      />
      <Problem action={adding} styles={styles} />
    </View>
  );
}

export function ProjectsTab({ space, highlight, styles, theme }: { space: string; highlight?: string; styles: Styles; theme: Theme }) {
  const read = useRpc(projectsListRpc);
  const query = useQuery({ queryKey: ["dashboard", "projects", space], queryFn: () => read({ space }), refetchInterval: PROJECTS_REFRESH_MS });
  const [open, setOpen] = useState<string | undefined>();
  const [group, setGroup] = useState("");
  const list = query.data;
  const listedAs = highlight ? list?.projects.find((p) => p.local?.project_id === highlight) : undefined;
  const candidates = list ? [...list.candidates].sort((a, b) => Number(b.project_id === highlight) - Number(a.project_id === highlight)) : [];
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12, maxWidth: 860 }]}>
      {query.isError ? <Text style={styles.error}>{`Could not read the projects: ${String(query.error)}`}</Text> : null}
      {list?.error ? <Text style={styles.error}>{list.error}</Text> : null}
      {!list ? <Text style={styles.muted}>Loading…</Text> : null}
      {listedAs ? <Text style={styles.text}>{`This Paseo project is already the line ${listedAs.key}.`}</Text> : null}
      {list ? (
        <Section title={`Lines on the map · ${list.projects.length}`} styles={styles}>
          {list.projects.length === 0 ? <Text style={styles.muted}>No projects yet. Add your Paseo projects below; each becomes a line.</Text> : null}
          {list.projects.map((line, index) => (
            <LineRow
              key={line.key}
              space={space}
              line={line}
              index={index}
              count={list.projects.length}
              list={list}
              open={open === line.key}
              onToggle={() => setOpen(open === line.key ? undefined : line.key)}
              styles={styles}
              theme={theme}
            />
          ))}
        </Section>
      ) : null}
      {list ? (
        <Section title="Add projects" styles={styles}>
          <Text style={styles.muted}>Every project in Paseo Dash lives in this one plan repository. A group keeps an umbrella's lines together and lets the map show just them.</Text>
          <Field label="Group for the lines you add here (empty: no group)" value={group} onChange={setGroup} styles={styles} theme={theme} placeholder={list.groups[0] ?? "Laconote"} />
          {list.groups.length ? (
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {list.groups.map((g) => (
                <Button key={g} label={g} ghost onPress={() => setGroup(g)} styles={styles} />
              ))}
            </View>
          ) : null}
          <Text style={styles.heading}>{`From Paseo on this Mac · ${candidates.length}`}</Text>
          {candidates.length === 0 ? <Text style={styles.muted}>Every git project in Paseo with an origin remote is already a line.</Text> : null}
          {candidates.length > 1 ? <AddAll space={space} candidates={candidates} group={group} styles={styles} /> : null}
          {candidates.map((c) => (
            <Candidate key={c.project_id} space={space} candidate={c} group={group} highlight={c.project_id === highlight} styles={styles} theme={theme} />
          ))}
          {list.no_remote.length ? (
            <Text style={styles.muted}>{`Not offered, no origin remote: ${list.no_remote.map((p) => p.name).join(", ")}. Add them by URL below, then map them to their checkout.`}</Text>
          ) : null}
          <Text style={styles.heading}>By URL</Text>
          <AddByUrl space={space} taken={list.projects.map((p) => p.key)} group={group} styles={styles} theme={theme} />
        </Section>
      ) : null}
    </ScrollView>
  );
}
