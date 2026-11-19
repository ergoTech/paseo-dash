import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ISSUES_IMPORT_MAX, issuesImportRpc, issuesListRpc } from "../shared/issues.ts";
import { Button, isWebUrl, type Styles } from "./common.tsx";
import { Choice, Field, useRefresh } from "./forms.tsx";
import { useSpaceOptions } from "./labels.tsx";

/**
 * "Import from GitHub/GitLab" (04-ux.md, Triage the inbox; 09-forge-issues.md, option a): a project's
 * open issues, optionally only one label's or milestone's; the ticked ones become inbox drafts that
 * carry the issue's URL. An issue some task already carries shows which and cannot be ticked. From
 * the all-spaces view (`space` empty) it asks which space first.
 */

type Theme = PluginHostProps["theme"];
type Filter = { space: string; project: string; label: string; milestone: string };

export function IssueImport({ space: fixed, spaces = [], open, onClose, styles, theme }: {
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
  const options = useSpaceOptions(space, open && Boolean(space));
  const readList = useRpc(issuesListRpc);
  const runImport = useRpc(issuesImportRpc);
  const [project, setProject] = useState("");
  const [label, setLabel] = useState("");
  const [milestone, setMilestone] = useState("");
  // The filter the shown list was read with: the import reads the forge again with the same one.
  const [shown, setShown] = useState<Filter | undefined>();
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const listing = useMutation({
    mutationFn: (filter: Filter) => readList({ space: filter.space, project: filter.project, label: filter.label || undefined, milestone: filter.milestone || undefined }),
    onSuccess: (answer) => setChosen(new Set(answer.issues.filter((i) => !i.imported_as).map((i) => i.number))),
  });
  const importing = useMutation({
    mutationFn: () => runImport({ space: shown!.space, project: shown!.project, label: shown!.label || undefined, milestone: shown!.milestone || undefined, numbers: [...chosen] }),
    onSuccess: (answer) => {
      refresh();
      if (answer.created.length > 0 && shown) listing.mutate(shown);
    },
  });
  const load = () => {
    const filter = { space, project, label: label.trim(), milestone: milestone.trim() };
    setShown(filter);
    importing.reset();
    listing.mutate(filter);
  };
  const toggle = (number: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });

  const list = listing.data;
  const done = importing.data;
  const projects = options.data?.projects ?? [];
  return (
    <Modal title="Import from GitHub/GitLab" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        {fixed ? null : (
          <Choice label="Into the inbox of" options={spaces.map((s) => ({ value: s.key, label: `${s.name} (${s.key})` }))} value={picked} onChange={setPicked} styles={styles} />
        )}
        {options.data?.error ? <Text style={styles.error}>{options.data.error}</Text> : null}
        {space ? (
          <Choice
            label="Project (its repository's open issues)"
            loaded={Boolean(options.data)}
            options={projects.map((p) => ({ value: p.key, label: p.key }))}
            value={project}
            onChange={setProject}
            styles={styles}
          />
        ) : null}
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <View style={{ flexGrow: 1, minWidth: 160 }}>
            <Field label="Only with the forge label" value={label} onChange={setLabel} placeholder="any" styles={styles} theme={theme} />
          </View>
          <View style={{ flexGrow: 1, minWidth: 160 }}>
            <Field label="Only in the milestone" value={milestone} onChange={setMilestone} placeholder="any" styles={styles} theme={theme} />
          </View>
        </View>
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button label={listing.isPending ? "Reading the forge…" : "List open issues"} disabled={!space || !project || listing.isPending} onPress={load} styles={styles} />
        </View>
        {listing.isError ? <Text style={styles.error}>{`Could not list the issues: ${String(listing.error)}`}</Text> : null}
        {list?.error ? <Text style={styles.error}>{list.error}</Text> : null}
        {list && !list.error ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.muted}>
              {list.issues.length === 0
                ? `No open issues in ${list.repository} match.`
                : `${list.issues.length} open issue${list.issues.length === 1 ? "" : "s"} in ${list.repository}${list.more ? " (the newest; narrow the filter to see others)" : ""}. Their text is other people's words: drafts start nothing until someone accepts them.`}
            </Text>
            {list.issues.map((issue) => {
              const taken = Boolean(issue.imported_as);
              const checked = chosen.has(issue.number);
              return (
                <Pressable
                  key={issue.number}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`#${issue.number} ${issue.title}`}
                  accessibilityState={{ checked, disabled: taken }}
                  disabled={taken}
                  onPress={() => toggle(issue.number)}
                  style={[styles.row, { alignItems: "flex-start", opacity: taken ? 0.6 : 1 }]}
                >
                  <Text style={[styles.text, { color: checked ? theme.colors.accent : theme.colors.foregroundMuted, minWidth: 18 }]}>{checked ? "☑" : "☐"}</Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.text}>{`#${issue.number} ${issue.title}`}</Text>
                    <Text style={styles.muted}>
                      {[issue.labels.join(", "), issue.milestone, taken ? `already imported as ${issue.imported_as}` : ""].filter(Boolean).join(" · ")}
                    </Text>
                    {isWebUrl(issue.url) ? <ExternalLink href={issue.url}>Open on the forge</ExternalLink> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {chosen.size > ISSUES_IMPORT_MAX ? <Text style={styles.error}>{`At most ${ISSUES_IMPORT_MAX} at once: untick some.`}</Text> : null}
        {importing.isError ? <Text style={styles.error}>{`Could not import: ${String(importing.error)}`}</Text> : null}
        {done?.error ? <Text style={styles.error}>{done.error}</Text> : null}
        {done && done.created.length > 0 ? <Text style={styles.muted}>{`${done.created.length} draft(s) added to the inbox: ${done.created.map((c) => c.id).join(", ")}`}</Text> : null}
        {done?.skipped.map((s) => (
          <Text key={`${s.title}-${s.id}`} style={styles.muted}>{`«${s.title}»: ${s.reason}`}</Text>
        ))}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button
            label={importing.isPending ? "Importing…" : `Import ${chosen.size} draft${chosen.size === 1 ? "" : "s"}`}
            disabled={importing.isPending || listing.isPending || chosen.size === 0 || chosen.size > ISSUES_IMPORT_MAX || !list || Boolean(list.error) || shown?.space !== space}
            onPress={() => importing.mutate()}
            styles={styles}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
