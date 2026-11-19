import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { labelsPutRpc, labelsRemoveRpc, peoplePutRpc, peopleRemoveRpc } from "../shared/labels.ts";
import { uiOptionsRpc } from "../shared/ui.ts";
import { inviteSentence, removeSentence, sharingInviteRpc, sharingReadRpc, sharingRemoveRpc, suggestPersonKey } from "../shared/sharing.ts";
import { Button, Section, type Styles } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";
import { LabelChips, useSpaceOptions } from "./labels.tsx";
import { Problem, Swatches } from "./projects.tsx";

/**
 * The space's label palette and people (03-model.md, `space.yaml`): each change is one commit to
 * space.yaml. A label tasks carry that the palette lacks is listed too, to define with one tap. People
 * are names for display and "mine"; listing someone grants them nothing.
 */

type Theme = PluginHostProps["theme"];
type Options = RpcOutput<typeof uiOptionsRpc>;
type LabelRow = Options["labels"][number];
type PersonRow = Options["people"][number];

export function TeamTab({ space, styles, theme }: { space: string; styles: Styles; theme: Theme }) {
  const options = useSpaceOptions(space);
  const o = options.data;
  const [newLabel, setNewLabel] = useState(false);
  const [newPerson, setNewPerson] = useState(false);
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      {options.isError ? <Text style={styles.error}>{`Could not read the space: ${String(options.error)}`}</Text> : null}
      {o?.error ? <Text style={styles.error}>{o.error}</Text> : null}
      <Section title="Labels" styles={styles} trailing={<Button label="+ Label" ghost onPress={() => setNewLabel(true)} styles={styles} />}>
        <Text style={styles.muted}>
          A label typed on a task joins this palette with the next color. One written into a task file by hand and missing here shows dashed and is listed among the space's problems.
        </Text>
        {newLabel ? <LabelEditor space={space} onDone={() => setNewLabel(false)} styles={styles} theme={theme} /> : null}
        {o && o.labels.length === 0 ? <Text style={styles.muted}>No labels yet.</Text> : null}
        {o?.labels.map((label) => <LabelItem key={label.name} space={space} label={label} styles={styles} theme={theme} />)}
      </Section>
      <Section title="People" styles={styles} trailing={<Button label="+ Person" ghost onPress={() => setNewPerson(true)} styles={styles} />}>
        <Text style={styles.muted}>
          {o?.me.key
            ? `This Mac's git email ${o.me.email} is ${o.me.key}'s: "Mine" shows the tasks assigned to ${o.me.key}.`
            : o?.me.email
              ? `No one below has this Mac's git email ${o.me.email}; add it to yourself for "Mine" to work.`
              : 'This Mac has no git email (git config user.email), so "Mine" cannot tell who you are.'}
        </Text>
        {newPerson ? <PersonEditor space={space} me={o?.me.email ?? ""} onDone={() => setNewPerson(false)} styles={styles} theme={theme} /> : null}
        {o && o.people.length === 0 ? <Text style={styles.muted}>No people yet.</Text> : null}
        {o?.people.map((person) => <PersonItem key={person.key} space={space} person={person} me={o.me.email} styles={styles} theme={theme} />)}
      </Section>
      <ShareSection space={space} people={o?.people ?? []} styles={styles} theme={theme} />
    </ScrollView>
  );
}

function LabelItem({ space, label, styles, theme }: { space: string; label: LabelRow; styles: Styles; theme: Theme }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={[styles.row, { flexShrink: 1 }]}>
          <LabelChips labels={[{ name: label.name, color: label.color, defined: label.defined }]} theme={theme} />
          <Text style={styles.muted}>{[`${label.tasks} task(s)`, label.defined ? label.description : "not defined in space.yaml"].filter(Boolean).join(" · ")}</Text>
        </View>
        <Button label={open ? "Close" : label.defined ? "Edit…" : "Define…"} ghost onPress={() => setOpen(!open)} styles={styles} />
      </View>
      {open ? <LabelEditor space={space} label={label} onDone={() => setOpen(false)} styles={styles} theme={theme} /> : null}
    </View>
  );
}

function LabelEditor({ space, label, onDone, styles, theme }: { space: string; label?: LabelRow; onDone: () => void; styles: Styles; theme: Theme }) {
  const refresh = useRefresh();
  const put = useRpc(labelsPutRpc);
  const remove = useRpc(labelsRemoveRpc);
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? "");
  const [description, setDescription] = useState(label?.description ?? "");
  useEffect(() => setColor(label?.color ?? ""), [label?.color]);
  const saving = useMutation({
    mutationFn: () => put({ space, name: name.trim(), color: color || undefined, description: description.trim() }),
    onSuccess: (answer) => (answer.ok ? onDone() : undefined),
    onSettled: refresh,
  });
  const removing = useMutation({ mutationFn: () => remove({ space, name: label!.name }), onSettled: refresh });
  return (
    <View style={{ gap: 10, paddingTop: 6 }}>
      {label ? null : <Field label="Name" value={name} onChange={setName} placeholder="bug" styles={styles} theme={theme} />}
      <View style={{ gap: 6 }}>
        <Text style={styles.muted}>{color ? "Color" : "Color (empty: the next palette color)"}</Text>
        <Swatches value={color} onPick={setColor} theme={theme} what="Label color" />
      </View>
      <Field label="Description" value={description} onChange={setDescription} placeholder="optional" styles={styles} theme={theme} />
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button label={saving.isPending ? "Saving…" : label?.defined ? "Save" : "Define"} disabled={saving.isPending || !name.trim()} onPress={() => saving.mutate()} styles={styles} />
        {label?.defined ? (
          <Button
            label={removing.isPending ? "Removing…" : "Remove from the palette"}
            ghost
            disabled={removing.isPending || label.tasks > 0}
            onPress={() => removing.mutate()}
            styles={styles}
          />
        ) : null}
        {label ? null : <Button label="Cancel" ghost onPress={onDone} styles={styles} />}
      </View>
      {label?.defined && label.tasks > 0 ? <Text style={styles.muted}>Tasks carry it, so it stays in the palette.</Text> : null}
      <Problem action={saving} styles={styles} />
      <Problem action={removing} styles={styles} />
    </View>
  );
}

function PersonItem({ space, person, me, styles, theme }: { space: string; person: PersonRow; me: string; styles: Styles; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const logins = [person.github ? `GitHub ${person.github}` : "", ...person.gitlab.map((g) => `${g.host} ${g.login}`)].filter(Boolean);
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Text style={styles.text}>{person.name ? `${person.name} (${person.key})` : person.key}</Text>
          <Text style={styles.muted}>{[...person.emails, ...logins, `${person.open_tasks} open task(s)`].join(" · ")}</Text>
        </View>
        <Button label={open ? "Close" : "Edit…"} ghost onPress={() => setOpen(!open)} styles={styles} />
      </View>
      {open ? <PersonEditor space={space} person={person} me={me} onDone={() => setOpen(false)} styles={styles} theme={theme} /> : null}
    </View>
  );
}

function PersonEditor({ space, person, me, onDone, styles, theme }: { space: string; person?: PersonRow; me: string; onDone: () => void; styles: Styles; theme: Theme }) {
  const refresh = useRefresh();
  const put = useRpc(peoplePutRpc);
  const remove = useRpc(peopleRemoveRpc);
  const [key, setKey] = useState(person?.key ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [emails, setEmails] = useState(person?.emails.join(", ") ?? "");
  const [github, setGithub] = useState(person?.github ?? "");
  const [gitlab, setGitlab] = useState(person?.gitlab.map((g) => `${g.host} ${g.login}`).join("\n") ?? "");
  const listed = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
  // One "host login" pair per line.
  const pairs = gitlab
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0]);
  const malformed = pairs.some((parts) => parts.length !== 2);
  const saving = useMutation({
    mutationFn: () =>
      put({
        space,
        key: key.trim(),
        name: name.trim() || undefined,
        emails: listed(emails),
        github: github.trim() || undefined,
        gitlab: pairs.map(([host, login]) => ({ host: host!, login: login! })),
      }),
    onSuccess: (answer) => (answer.ok ? onDone() : undefined),
    onSettled: refresh,
  });
  const removing = useMutation({ mutationFn: () => remove({ space, key: person!.key }), onSettled: refresh });
  return (
    <View style={{ gap: 10, paddingTop: 6 }}>
      {person ? null : <Field label="Key (what tasks' assignee holds: lower-case letters, digits, - and _)" value={key} onChange={setKey} placeholder="anna" styles={styles} theme={theme} />}
      <Field label="Name" value={name} onChange={setName} placeholder="Anna" styles={styles} theme={theme} />
      <Field label="Git emails, separated by commas" value={emails} onChange={setEmails} placeholder="anna@example.com" styles={styles} theme={theme} />
      {me && !listed(emails).some((e) => e.toLowerCase() === me.toLowerCase()) ? (
        <Button label={`Add this Mac's email (${me})`} ghost onPress={() => setEmails([...listed(emails), me].join(", "))} styles={styles} />
      ) : null}
      <Field label="GitHub login" value={github} onChange={setGithub} placeholder="optional" styles={styles} theme={theme} />
      <Field label={'GitLab logins, one "host login" per line'} value={gitlab} onChange={setGitlab} multiline placeholder="gitlab.example.com anna" styles={styles} theme={theme} />
      {malformed ? <Text style={styles.error}>Each GitLab line is a host and a login separated by a space.</Text> : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button label={saving.isPending ? "Saving…" : person ? "Save" : "Add"} disabled={saving.isPending || !key.trim() || malformed} onPress={() => saving.mutate()} styles={styles} />
        {person ? (
          <Button label={removing.isPending ? "Removing…" : "Remove"} ghost disabled={removing.isPending || person.open_tasks > 0} onPress={() => removing.mutate()} styles={styles} />
        ) : (
          <Button label="Cancel" ghost onPress={onDone} styles={styles} />
        )}
      </View>
      {person && person.open_tasks > 0 ? <Text style={styles.muted}>Open tasks are assigned to them, so they stay listed.</Text> : null}
      <Problem action={saving} styles={styles} />
      <Problem action={removing} styles={styles} />
    </View>
  );
}

type Sharing = RpcOutput<typeof sharingReadRpc>;

/**
 * "Share this space" (09-forge-issues.md, F4): who can reach the plan repository, inviting someone
 * and taking access away, through this machine's own gh or glab login. Each asks first, with the
 * sentence saying what the person gets; the forge is asked only once the section is opened, and again
 * only after an invitation or a removal, not after every plan edit.
 */
function ShareSection({ space, people, styles, theme }: { space: string; people: PersonRow[]; styles: Styles; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const read = useRpc(sharingReadRpc);
  const sharing = useQuery({ queryKey: ["dashboard-forge", "sharing", space], queryFn: () => read({ space }), enabled: open, staleTime: 60_000 });
  const s = sharing.data;
  return (
    <Section title="Share this space" styles={styles} trailing={<Button label={open ? "Close" : "Who has access…"} ghost onPress={() => setOpen(!open)} styles={styles} />}>
      <Text style={styles.muted}>
        Access to the plan is access to its repository. Someone who can push to it writes briefs that become the first prompts of your agents: invite only people you would let run commands through them.
      </Text>
      {open && sharing.isPending ? <Text style={styles.muted}>Asking the forge…</Text> : null}
      {sharing.isError ? <Text style={styles.error}>{String(sharing.error)}</Text> : null}
      {s?.error ? <Text style={s.ok ? styles.muted : styles.error}>{s.error}</Text> : null}
      {open && s?.ok ? (
        <>
          {s.members.map((m) => (
            <MemberItem key={`${m.kind}-${m.who}`} space={space} sharing={s} member={m} styles={styles} />
          ))}
          <InviteForm space={space} sharing={s} people={people} styles={styles} theme={theme} />
        </>
      ) : null}
    </Section>
  );
}

/** After an invitation or a removal: the plan reads, and who has access on the forge. */
function useShared(space: string) {
  const refresh = useRefresh();
  const client = useQueryClient();
  return () => {
    refresh();
    void client.invalidateQueries({ queryKey: ["dashboard-forge", "sharing", space] });
  };
}

function MemberItem({ space, sharing, member, styles }: { space: string; sharing: Sharing; member: Sharing["members"][number]; styles: Styles }) {
  const refresh = useShared(space);
  const remove = useRpc(sharingRemoveRpc);
  const [confirming, setConfirming] = useState(false);
  const removing = useMutation({ mutationFn: () => remove({ space, kind: member.kind, who: member.who, confirmed: true }), onSettled: refresh });
  const forge = sharing.forge || "github";
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Text style={styles.text}>{member.name ? `${member.name} (${member.who})` : member.who}</Text>
          <Text style={styles.muted}>{[member.role, member.kind === "invitation" ? "invitation not accepted yet" : ""].filter(Boolean).join(" · ")}</Text>
        </View>
        {member.removable && !confirming ? <Button label={member.kind === "invitation" ? "Withdraw…" : "Remove…"} ghost onPress={() => setConfirming(true)} styles={styles} /> : null}
      </View>
      {confirming ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.text}>{removeSentence({ forge, repo: sharing.repo, who: member.who, kind: member.kind })}</Text>
          <View style={styles.row}>
            <Button label={removing.isPending ? "Removing…" : member.kind === "invitation" ? "Withdraw" : "Remove"} disabled={removing.isPending} onPress={() => removing.mutate()} styles={styles} />
            <Button label="Cancel" ghost onPress={() => setConfirming(false)} styles={styles} />
          </View>
        </View>
      ) : null}
      <Problem action={removing} styles={styles} />
    </View>
  );
}

/** Who in People holds this login (or email) on the repository's forge already. */
function holderOf(people: PersonRow[], sharing: Sharing, who: string): string | undefined {
  const wanted = who.trim().toLowerCase();
  if (!wanted) return undefined;
  return people.find((p) =>
    p.emails.some((e) => e.toLowerCase() === wanted) ||
    (sharing.forge === "github" ? p.github?.toLowerCase() === wanted : p.gitlab.some((g) => g.host.toLowerCase() === sharing.host.toLowerCase() && g.login.toLowerCase() === wanted)),
  )?.key;
}

function InviteForm({ space, sharing, people, styles, theme }: { space: string; sharing: Sharing; people: PersonRow[]; styles: Styles; theme: Theme }) {
  const refresh = useShared(space);
  const send = useRpc(sharingInviteRpc);
  const [who, setWho] = useState("");
  const [role, setRole] = useState(sharing.roles.find((r) => r.writes)?.value ?? "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const held = holderOf(people, sharing, who);
  const person = held ?? (key.trim() || suggestPersonKey(who));
  const listed = held ? ("held" as const) : people.some((p) => p.key === person) ? ("extended" as const) : undefined;
  const chosen = sharing.roles.find((r) => r.value === role);
  const forge = sharing.forge || "github";
  const inviting = useMutation({
    mutationFn: () => send({ space, who: who.trim(), role, person_key: person, person_name: name.trim(), confirmed: true }),
    onSuccess: (answer) => {
      setConfirming(false);
      if (answer.ok) setWho("");
    },
    onSettled: refresh,
  });
  const ready = Boolean(who.trim() && (sharing.roles.length === 0 || chosen));
  const done = inviting.data?.ok ? inviting.data : undefined;
  return (
    <View style={[styles.card, { gap: 10 }]}>
      <Text style={styles.heading}>Invite someone</Text>
      <Field
        label={sharing.by_email ? `${sharing.host} username, or an email for someone without an account` : "GitHub login"}
        value={who}
        onChange={setWho}
        placeholder={sharing.by_email ? "anna or anna@example.com" : "anna"}
        styles={styles}
        theme={theme}
      />
      {sharing.roles.length ? (
        <Choice label="Role" options={sharing.roles.map((r) => ({ value: r.value, label: r.label }))} value={role} onChange={setRole} styles={styles} />
      ) : (
        <Text style={styles.muted}>A repository owned by a user has no read-only collaborators: everyone invited can push.</Text>
      )}
      <Field label="Add to People as (key)" value={key} onChange={setKey} placeholder={suggestPersonKey(who) || "anna"} styles={styles} theme={theme} />
      <Field label="Name" value={name} onChange={setName} placeholder="optional" styles={styles} theme={theme} />
      {confirming ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.text}>{inviteSentence({ forge, repo: sharing.repo, who: who.trim(), role: chosen, person, listed })}</Text>
          <View style={styles.row}>
            <Button label={inviting.isPending ? "Inviting…" : "Invite"} disabled={inviting.isPending} onPress={() => inviting.mutate()} styles={styles} />
            <Button label="Cancel" ghost onPress={() => setConfirming(false)} styles={styles} />
          </View>
        </View>
      ) : (
        <Button label="Invite…" disabled={!ready} onPress={() => setConfirming(true)} styles={styles} />
      )}
      {done ? (
        <Text style={styles.muted}>
          {[
            done.sent === "invited" ? "Invitation sent; they accept it on the forge." : "They have access now.",
            done.person ? `Listed in People as ${done.person}.` : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </Text>
      ) : null}
      {done?.warning ? <Text style={styles.error}>{done.warning}</Text> : null}
      <Problem action={inviting} styles={styles} />
    </View>
  );
}
