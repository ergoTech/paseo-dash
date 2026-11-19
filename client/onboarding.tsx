import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { spacesAddRpc, spacesCreateRpc } from "../shared/spaces.ts";
import { Button, Section, type Styles } from "./common.tsx";
import { Field, useRefresh } from "./forms.tsx";
import { openScreen } from "./nav.ts";

/**
 * The dashboard with no space yet (02-product.md, D18): one private plan repository holds every
 * project. Create it on GitHub with `gh`, after saying what will happen, or connect one that exists;
 * either way the Projects tab opens next, to add the lines.
 */

type Theme = PluginHostProps["theme"];

export function Onboarding({ styles, theme }: { styles: Styles; theme: Theme }) {
  const refresh = useRefresh();
  const create = useRpc(spacesCreateRpc);
  const connect = useRpc(spacesAddRpc);
  const [repo, setRepo] = useState("dashboard-plan");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [remote, setRemote] = useState("");
  const opened = (answer: { ok: boolean; key: string }) => {
    if (answer.ok && answer.key) openScreen("space", { space: answer.key, tab: "projects" });
  };
  const creating = useMutation({ mutationFn: () => create({ repo: repo.trim(), key: key.trim().toUpperCase(), name: name.trim() }), onSuccess: opened, onSettled: refresh });
  const connecting = useMutation({
    mutationFn: () => connect({ remote: remote.trim(), key: key.trim().toUpperCase() || undefined, name: name.trim() || undefined }),
    onSuccess: opened,
    onSettled: refresh,
  });
  const ready = Boolean(repo.trim() && /^[A-Za-z]{2,6}$/.test(key.trim()) && name.trim());
  return (
    <View style={{ gap: 20, maxWidth: 640 }}>
      <Text style={styles.text}>
        Paseo Dash keeps its plan in one git repository: every project you connect becomes a line on the map, and everyone you invite to the repository sees the same plan.
      </Text>
      <Section title="Name it" styles={styles}>
        <Field label="Name" value={name} onChange={setName} styles={styles} theme={theme} placeholder="My projects" />
        <Field label="Key: 2-6 letters, the prefix of every task id" value={key} onChange={(text) => setKey(text.toUpperCase())} styles={styles} theme={theme} placeholder="ME" />
      </Section>
      <Section title="Create it on GitHub" styles={styles}>
        <Field label="Repository (owner/name, or a name for your own account)" value={repo} onChange={setRepo} styles={styles} theme={theme} placeholder="dashboard-plan" />
        {confirming ? (
          <View style={[styles.card, { gap: 8 }]}>
            <Text style={styles.text}>{`gh will create the private repository ${repo.trim()} on GitHub, and Paseo Dash will push its first commit there.`}</Text>
            <View style={styles.row}>
              <Button label={creating.isPending ? "Creating…" : "Create"} disabled={creating.isPending} onPress={() => creating.mutate()} styles={styles} />
              <Button label="Cancel" ghost onPress={() => setConfirming(false)} styles={styles} />
            </View>
          </View>
        ) : (
          <Button label="Create on GitHub…" disabled={!ready} onPress={() => setConfirming(true)} styles={styles} />
        )}
        {!ready ? <Text style={styles.muted}>Give a name, a key and a repository first.</Text> : null}
        {creating.data?.error ? <Text style={styles.error}>{creating.data.error}</Text> : null}
      </Section>
      <Section title="Or connect one that exists" styles={styles}>
        <Field label="Clone URL (an empty repository, or one with only a README, becomes the plan with the name and key above)" value={remote} onChange={setRemote} styles={styles} theme={theme} placeholder="git@github.com:me/dashboard-plan.git" />
        <Button label={connecting.isPending ? "Connecting…" : "Connect"} ghost disabled={connecting.isPending || !remote.trim()} onPress={() => connecting.mutate()} styles={styles} />
        {connecting.data?.error ? <Text style={styles.error}>{connecting.data.error}</Text> : null}
      </Section>
    </View>
  );
}
