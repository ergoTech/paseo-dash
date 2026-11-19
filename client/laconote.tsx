import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { IMPORT_MAX, laconoteImportRpc, laconoteMeetingsRpc, laconotePreviewRpc, laconoteSettingsRpc } from "../shared/laconote.ts";
import { Button, isWebUrl, type Styles } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";
import { PLUGIN_NAME } from "../shared/edition.ts";

/**
 * "Import from Laconote" (04-ux.md, Triage the inbox): a recent meeting from the API when a key is
 * set, or a pasted Markdown export; its action items by topic, new ones ticked; the ticked ones become
 * inbox drafts. The paste goes to the server as text: the client reads no files. From the all-spaces
 * view (`space` empty) it asks which space's inbox they go to.
 */

type Theme = PluginHostProps["theme"];
type Source = { meeting: string } | { text: string };

const given = (label: string, value: string) => `${label}: ${value || "—"}`;

export function LaconoteImport({ space: fixed, spaces = [], open, onClose, styles, theme }: {
  space: string;
  /** The spaces to import into, when `space` is empty (the all-spaces view). */
  spaces?: { key: string; name: string }[];
  open: boolean;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const [picked, setPicked] = useState(spaces.length === 1 ? spaces[0]!.key : "");
  const space = fixed || picked;
  const refresh = useRefresh();
  const readSettings = useRpc(laconoteSettingsRpc);
  const readMeetings = useRpc(laconoteMeetingsRpc);
  const readPreview = useRpc(laconotePreviewRpc);
  const runImport = useRpc(laconoteImportRpc);
  const settings = useQuery({ queryKey: ["dashboard", "laconote", "settings"], queryFn: () => readSettings({}), enabled: open });
  const keySet = settings.data?.key_set === true;
  const meetings = useQuery({ queryKey: ["dashboard", "laconote", "meetings"], queryFn: () => readMeetings({ limit: 20 }), enabled: open && keySet });
  const [paste, setPaste] = useState("");
  const [source, setSource] = useState<Source | undefined>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const preview = useMutation({
    mutationFn: (from: Source) => readPreview(from),
    onSuccess: (answer) => setChosen(new Set(answer.topics.flatMap((t) => t.items.filter((i) => !i.imported).map((i) => i.text)))),
  });
  const importing = useMutation({
    mutationFn: () => runImport({ ...source!, space, items: [...chosen] }),
    onSuccess: (answer) => {
      refresh();
      if (answer.created.length > 0 && source) preview.mutate(source);
    },
  });
  const show = (from: Source) => {
    setSource(from);
    importing.reset();
    preview.mutate(from);
  };
  const back = () => {
    setSource(undefined);
    preview.reset();
    importing.reset();
  };
  const close = () => {
    back();
    onClose();
  };
  const toggle = (text: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });

  const p = preview.data;
  const done = importing.data;
  return (
    <Modal title="Import from Laconote" open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <Modal.Content>
        {!source ? (
          <>
            {settings.data?.error ? <Text style={styles.error}>{settings.data.error}</Text> : null}
            {settings.data && !keySet ? (
              <Text style={styles.muted}>{`No Laconote API key on this machine: set one in Settings → ${PLUGIN_NAME} to pick a meeting here, or paste an export below.`}</Text>
            ) : null}
            {keySet ? (
              <View style={{ gap: 6 }}>
                <Text style={styles.heading}>Recent meetings</Text>
                {meetings.isFetching && !meetings.data ? <Text style={styles.muted}>Loading…</Text> : null}
                {meetings.isError ? <Text style={styles.error}>{`Could not list the meetings: ${String(meetings.error)}`}</Text> : null}
                {meetings.data?.error ? <Text style={styles.error}>{meetings.data.error}</Text> : null}
                {meetings.data && !meetings.data.error && meetings.data.meetings.length === 0 ? <Text style={styles.muted}>No meetings.</Text> : null}
                {meetings.data?.meetings.map((m) => (
                  <Pressable key={m.id} accessibilityRole="button" accessibilityLabel={`Preview meeting ${m.title}`} onPress={() => show({ meeting: m.id })} style={styles.card}>
                    <Text style={styles.text}>{m.title}</Text>
                    <Text style={styles.muted}>{[m.date, m.has_summary ? "" : "no summary yet"].filter(Boolean).join(" · ")}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Field label="Or paste a Laconote Markdown export" value={paste} onChange={setPaste} multiline placeholder="# Meeting title…" styles={styles} theme={theme} />
            <View style={[styles.row, { justifyContent: "flex-end" }]}>
              <Button label="Close" ghost onPress={close} styles={styles} />
              <Button label="Preview" disabled={!paste.trim()} onPress={() => show({ text: paste })} styles={styles} />
            </View>
          </>
        ) : (
          <>
            <View style={styles.row}>
              <Button label="‹ Back" ghost onPress={back} styles={styles} />
            </View>
            {preview.isPending ? <Text style={styles.muted}>Reading the meeting…</Text> : null}
            {preview.isError ? <Text style={styles.error}>{`Could not read the meeting: ${String(preview.error)}`}</Text> : null}
            {p?.error ? <Text style={styles.error}>{p.error}</Text> : null}
            {p && !p.error ? (
              <>
                <Text style={styles.heading}>{p.title}</Text>
                {p.date ? <Text style={styles.muted}>{p.date}</Text> : null}
                {isWebUrl(p.url) ? <ExternalLink href={p.url}>Open in Laconote</ExternalLink> : null}
                {p.topics.length === 0 ? <Text style={styles.muted}>This meeting has no action items.</Text> : null}
                {p.topics.map((topic, t) => (
                  <View key={`${t}-${topic.title}`} style={{ gap: 6 }}>
                    <Text style={styles.heading}>{topic.title}</Text>
                    {topic.items.map((item, i) => {
                      const checked = chosen.has(item.text);
                      return (
                        <Pressable
                          key={`${i}-${item.text}`}
                          accessibilityRole="checkbox"
                          accessibilityLabel={item.text}
                          accessibilityState={{ checked, disabled: item.imported }}
                          disabled={item.imported}
                          onPress={() => toggle(item.text)}
                          style={[styles.row, { alignItems: "flex-start", opacity: item.imported ? 0.6 : 1 }]}
                        >
                          <Text style={[styles.text, { color: checked ? theme.colors.accent : theme.colors.foregroundMuted, minWidth: 18 }]}>{checked ? "☑" : "☐"}</Text>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={styles.text}>{item.text}</Text>
                            <Text style={styles.muted}>
                              {[given("Owner", item.owner), given("Deadline", item.deadline), given("Priority", item.priority), item.imported ? "already imported" : ""].filter(Boolean).join(" · ")}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </>
            ) : null}
            {fixed ? null : (
              <Choice label="Into the inbox of" options={spaces.map((s) => ({ value: s.key, label: `${s.name} (${s.key})` }))} value={picked} onChange={setPicked} styles={styles} />
            )}
            {chosen.size > IMPORT_MAX ? <Text style={styles.error}>{`At most ${IMPORT_MAX} at once: untick some.`}</Text> : null}
            {importing.isError ? <Text style={styles.error}>{`Could not import: ${String(importing.error)}`}</Text> : null}
            {done?.error ? <Text style={styles.error}>{done.error}</Text> : null}
            {done && (done.created.length > 0 || done.skipped.length > 0) ? (
              <Text style={styles.muted}>
                {[
                  `${done.created.length} draft(s) added to the inbox`,
                  done.skipped.length ? `${done.skipped.length} already there` : "",
                ]
                  .filter(Boolean)
                  .join("; ")}
              </Text>
            ) : null}
            <View style={[styles.row, { justifyContent: "flex-end" }]}>
              <Button label="Close" ghost onPress={close} styles={styles} />
              <Button
                label={importing.isPending ? "Importing…" : `Import ${chosen.size} draft${chosen.size === 1 ? "" : "s"}`}
                disabled={importing.isPending || chosen.size === 0 || chosen.size > IMPORT_MAX || !p || Boolean(p.error) || !space}
                onPress={() => importing.mutate()}
                styles={styles}
              />
            </View>
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}
