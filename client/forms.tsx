import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { featuresCreateRpc, milestonesCreateRpc, tasksListRpc, tasksUpdateRpc } from "../shared/api.ts";
import { spaceForTask } from "../shared/across.ts";
import { PRIORITIES } from "../shared/model.ts";
import { autopilotReadRpc, uiOptionsRpc, uiTasksCreateRpc } from "../shared/ui.ts";
import { taskViewRpc } from "../shared/views.ts";
import { Button, Chip, type Styles } from "./common.tsx";
import { useOptionsOf } from "./labels.tsx";

/**
 * The dashboard's forms (04-ux.md, Main flows): a task to create, edit or accept, a release and a
 * feature. Each is a host `Modal`, a bottom sheet on phones.
 */

type Theme = PluginHostProps["theme"];

/** After a write every dashboard read may show something else. */
export function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["dashboard"] });
    // A write may change what a start would do: its facts are read again (actions.tsx, startFacts).
    void client.invalidateQueries({ queryKey: ["dashboard-start"] });
  };
}

export function Field({
  label,
  value,
  onChange,
  styles,
  theme,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  styles: Styles;
  theme: Theme;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        style={[
          styles.text,
          {
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            paddingHorizontal: 10,
            paddingVertical: 8,
            minHeight: multiline ? 96 : undefined,
            textAlignVertical: multiline ? "top" : "center",
          },
        ]}
      />
    </View>
  );
}

/**
 * One value out of a few, as chips; `none` adds a chip for no value. The chosen chip carries a check
 * mark, not only a color; a value no option offers (a closed feature or release) still shows.
 */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  styles,
  none,
  loaded = true,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | "";
  onChange: (value: T | "") => void;
  styles: Styles;
  none?: string;
  /** False until the options are read, so a chosen value is not shown as one no option offers. */
  loaded?: boolean;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>{label}</Text>
      <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: "wrap" }]}>
        {none ? <Chip label={value === "" ? `✓ ${none}` : none} active={value === ""} onPress={() => onChange("")} styles={styles} /> : null}
        {loaded && value && !options.some((o) => o.value === value) ? <Chip label={`✓ ${value} (not offered: closed or unknown)`} active styles={styles} /> : null}
        {options.map((o) => (
          <Chip key={o.value} label={o.value === value ? `✓ ${o.label}` : o.label} active={o.value === value} onPress={() => onChange(o.value)} styles={styles} />
        ))}
      </View>
    </View>
  );
}

/** Tasks of the space found by words, to pick one or several. */
export function TaskPicker({
  space,
  label,
  picked,
  onPick,
  onUnpick,
  exclude,
  styles,
  theme,
}: {
  space: string;
  label: string;
  picked: { id: string; title: string }[];
  onPick: (task: { id: string; title: string }) => void;
  onUnpick?: (id: string) => void;
  exclude?: string;
  styles: Styles;
  theme: Theme;
}) {
  const [query, setQuery] = useState("");
  const list = useRpc(tasksListRpc);
  const words = query.trim();
  const found = useQuery({
    queryKey: ["dashboard", "pick", space, words],
    queryFn: () => list({ space, query: words, status: "all", limit: 8 }),
    enabled: words.length >= 2,
  });
  const shown = (found.data?.tasks ?? []).filter((t) => t.id !== exclude && !picked.some((p) => p.id === t.id));
  return (
    <View style={{ gap: 6 }}>
      <Field label={label} value={query} onChange={setQuery} placeholder="Words of the title" styles={styles} theme={theme} />
      {picked.length ? (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          {picked.map((p) => (
            <Chip
              key={p.id}
              label={`${p.id} · ${p.title}${onUnpick ? "  ×" : ""}`}
              accessibilityLabel={onUnpick ? `Remove ${p.id}, ${p.title}` : `${p.id}, ${p.title}`}
              active
              onPress={onUnpick ? () => onUnpick(p.id) : undefined}
              styles={styles}
            />
          ))}
        </View>
      ) : null}
      {found.data?.error ? <Text style={styles.error}>{found.data.error}</Text> : null}
      {found.data && !found.data.error && shown.length === 0 ? (
        <Text style={styles.muted}>No other task matches.</Text>
      ) : null}
      {shown.map((t) => (
        <Pressable
          key={t.id}
          accessibilityRole="button"
          accessibilityLabel={`Pick ${t.id}, ${t.title}, ${t.status}`}
          onPress={() => {
            onPick({ id: t.id, title: t.title });
            setQuery("");
          }}
          style={{ paddingVertical: 4 }}
        >
          <Text style={styles.text} numberOfLines={1}>{`${t.id} · ${t.title}`}</Text>
          <Text style={styles.muted}>{[t.status, t.project].filter(Boolean).join(" · ")}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export interface TaskDraft {
  /** Editing an existing task, or accepting a draft when `accept` is set; else creating. */
  id?: string;
  accept?: boolean;
  title?: string;
  brief?: string;
  project?: string;
  feature?: string;
  milestone?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  depends?: { id: string; title: string }[];
  /** The GitHub or GitLab issue's URL the task stands for; empty for none. */
  issue?: string;
  /** Why the project cannot change (the task was started); empty or absent while it can. */
  line?: string;
}

/**
 * A space for a new release or feature from the all-spaces view: the one given, else one picked
 * here, as chips, before anything else (`spaces` holds the choices).
 */
function useSpacePick(space: string, spaces: { key: string; name: string }[], styles: Styles): { target: string; picker: ReactNode } {
  const [picked, setPicked] = useState(spaces.length === 1 ? spaces[0]!.key : "");
  if (space) return { target: space, picker: null };
  return {
    target: picked,
    picker: <Choice label="Space" options={spaces.map((s) => ({ value: s.key, label: `${s.name} (${s.key})` }))} value={picked} onChange={setPicked} styles={styles} />,
  };
}

/**
 * A task to create, edit, or accept from the inbox. Only what the person changed since the form
 * opened is sent, so an edit never overwrites a field someone else changed meanwhile with what the
 * form happened to show. `initial` may follow the live task; the form keeps what it opened with.
 *
 * From the all-spaces view (`space` empty, `spaces` the choices) a new task goes to the space of its
 * project; a project key several spaces hold, or no project, asks which space (shared/across.ts).
 */
export function TaskForm({
  space: given,
  spaces = [],
  initial,
  open,
  onClose,
  styles,
  theme,
}: {
  space: string;
  /** The spaces to create in, when `space` is empty (the all-spaces view). */
  spaces?: { key: string; name: string }[];
  initial: TaskDraft;
  open: boolean;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const create = useRpc(uiTasksCreateRpc);
  const readAutopilot = useRpc(autopilotReadRpc);
  const update = useRpc(tasksUpdateRpc);
  const readOptions = useRpc(uiOptionsRpc);
  const [base] = useState(initial);
  const [title, setTitle] = useState(base.title ?? "");
  const [brief, setBrief] = useState(base.brief ?? "");
  const [acceptance, setAcceptance] = useState("");
  const [project, setProject] = useState(base.project ?? "");
  // The all-spaces view: projects of every space, and the space the task goes to.
  const reading = useOptionsOf(given ? [] : spaces.map((s) => s.key));
  const every = reading.of;
  const [picked, setPicked] = useState("");
  const holding = spaces.map((s) => ({ space: s.key, projects: (every.get(s.key)?.projects ?? []).map((p) => p.key) }));
  const target = given ? { space: given, choices: [given] } : spaceForTask(holding, project, picked);
  const space = target.space;
  const options = useQuery({ queryKey: ["dashboard", "options", space], queryFn: () => readOptions({ space }), enabled: open && Boolean(space) });
  const [feature, setFeature] = useState(base.feature ?? "");
  const [milestone, setMilestone] = useState(base.milestone ?? "");
  const [priority, setPriority] = useState(base.priority ?? "");
  const [assignee, setAssignee] = useState(base.assignee ?? "");
  const [labels, setLabels] = useState(base.labels ?? []);
  const [depends, setDepends] = useState(base.depends ?? []);
  const [issue, setIssue] = useState(base.issue ?? "");
  // A new task in To Do: start it once ready, keep it in To Do only, or (none) this Mac's setting.
  const [startChoice, setStartChoice] = useState<"start" | "todo" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = Boolean(base.id);
  // Features, releases, labels and tasks to wait for are the space's own: another space's do not carry over.
  const [shownSpace, setShownSpace] = useState(space);
  useEffect(() => {
    if (given || space === shownSpace) return;
    setShownSpace(space);
    setFeature("");
    setMilestone("");
    setLabels([]);
    setDepends([]);
  }, [given, space, shownSpace]);
  // Fields someone else changed since the form opened: they keep their new value unless edited here.
  const keys = ["title", "brief", "project", "feature", "milestone", "priority", "assignee", "labels", "depends", "issue"] as const;
  const drifted = editing ? keys.filter((key) => JSON.stringify(initial[key] ?? "") !== JSON.stringify(base[key] ?? "")) : [];
  const o = options.data;
  // This Mac's start defaults, to say what "this Mac's setting" does for a new task.
  const autopilot = useQuery({ queryKey: ["dashboard", "autopilot"], queryFn: () => readAutopilot({}), enabled: open && !editing });
  const macStart = autopilot.data && !autopilot.data.error ? autopilot.data.start : undefined;

  const changed = <T,>(now: T, before: T | undefined) => (JSON.stringify(now) !== JSON.stringify(before ?? (Array.isArray(now) ? [] : "")) ? now : undefined);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const lines = acceptance
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      // Labels go as what was added and taken off here, so labels someone else changed meanwhile stay.
      const had = (list: string[], label: string) => list.some((l) => l.toLowerCase() === label.toLowerCase());
      const addLabels = labels.filter((l) => !had(base.labels ?? [], l));
      const removeLabels = (base.labels ?? []).filter((l) => !had(labels, l));
      const answer = editing
        ? await update({
            task: base.id!,
            title: changed(title.trim(), base.title),
            brief: changed(brief, base.brief),
            project: changed(project, base.project) || undefined,
            feature: changed(feature, base.feature) || undefined,
            milestone: changed(milestone, base.milestone) || undefined,
            priority: (changed(priority, base.priority) || undefined) as (typeof PRIORITIES)[number] | undefined,
            assignee: changed(assignee, base.assignee) || undefined,
            add_labels: addLabels.length ? addLabels : undefined,
            remove_labels: removeLabels.length ? removeLabels : undefined,
            depends_on: changed(
              depends.map((d) => d.id),
              base.depends?.map((d) => d.id),
            ),
            // Empty takes the link off.
            issue: changed(issue.trim(), base.issue),
            status: base.accept ? "todo" : undefined,
          })
        : await create({
            space,
            title: title.trim(),
            brief: brief.trim() || undefined,
            project: project || undefined,
            feature: feature || undefined,
            milestone: milestone || undefined,
            priority: (priority || undefined) as (typeof PRIORITIES)[number] | undefined,
            labels: labels.length ? labels : undefined,
            depends_on: depends.length ? depends.map((d) => d.id) : undefined,
            acceptance: lines.length ? lines : undefined,
            issue: issue.trim() || undefined,
            start: startChoice === "start" ? true : startChoice === "todo" ? false : undefined,
          });
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      refresh();
      const started = "start_note" in answer && answer.start_note ? `; ${answer.start_note}` : "";
      toast.show(editing ? (base.accept ? `Accepted ${answer.id}` : `Saved ${answer.id}`) : `Created ${answer.id} (${answer.status})${started}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Not saved: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const heading = base.accept ? "Accept draft" : editing ? "Edit task" : "New task";
  // A cleared value cannot be sent as "no feature", "no release" or "default priority": the API takes
  // names and values, not blanks.
  const clearing =
    editing && ((base.feature && !feature) || (base.milestone && !milestone) || (base.project && !project) || (base.priority && !priority) || (base.assignee && !assignee));
  return (
    <Modal title={heading} open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Field label="Title" value={title} onChange={setTitle} styles={styles} theme={theme} />
        {o?.error ? <Text style={styles.error}>{o.error}</Text> : null}
        {reading.error ? <Text style={styles.error}>{`Could not read a space's projects: ${reading.error}`}</Text> : null}
        {given ? null : (
          <Choice
            label="Project"
            loaded={!reading.pending}
            options={[...new Set(holding.flatMap((h) => h.projects))].map((key) => {
              const of = holding.filter((h) => h.projects.includes(key)).map((h) => h.space);
              return { value: key, label: of.length > 1 ? `${key} (${of.join(", ")})` : `${key} · ${of[0]}` };
            })}
            value={project}
            onChange={setProject}
            none="None (inbox)"
            styles={styles}
          />
        )}
        {given || target.choices.length < 2 ? null : (
          <View style={{ gap: 4 }}>
            <Choice
              label={project ? `Space: ${project} is a project of several spaces` : "Space"}
              options={target.choices.map((key) => ({ value: key, label: `${spaces.find((s) => s.key === key)?.name ?? key} (${key})` }))}
              value={space}
              onChange={setPicked}
              styles={styles}
            />
            {space ? null : <Text style={styles.muted}>Pick the space the task goes to.</Text>}
          </View>
        )}
        {!given ? null : base.line ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.muted}>Project</Text>
            <Text style={styles.text}>{base.project}</Text>
            <Text style={styles.muted}>{base.line}</Text>
          </View>
        ) : (
          <Choice
            label="Project"
            loaded={Boolean(o)} options={(o?.projects ?? []).map((p) => ({ value: p.key, label: p.mapped ? p.key : `${p.key} (not on this Mac)` }))}
            value={project}
            onChange={setProject}
            none={editing ? undefined : "None (inbox)"}
            styles={styles}
          />
        )}
        <Choice
          label="Feature"
          loaded={Boolean(o)} options={(o?.features ?? []).map((f) => ({ value: f.id, label: f.title }))}
          value={feature}
          onChange={setFeature}
          none="None"
          styles={styles}
        />
        {/* A task without its own release follows its feature's, so "None" is the usual choice with a feature. */}
        <Choice
          label="Release"
          loaded={Boolean(o)} options={(o?.milestones ?? []).map((m) => ({ value: m.id, label: m.due ? `${m.title} · ${m.due}` : m.title }))}
          value={milestone}
          onChange={setMilestone}
          none={feature ? "The feature's" : "None"}
          styles={styles}
        />
        <Choice label="Priority" options={PRIORITIES.map((p) => ({ value: p, label: p }))} value={priority as (typeof PRIORITIES)[number] | ""} onChange={setPriority} none="Default" styles={styles} />
        {/* Only a new task with a project goes to To Do; a draft never starts. */}
        {editing || !project ? null : (
          <View style={{ gap: 4 }}>
            <Choice
              label="Start"
              options={[
                { value: "start" as const, label: "Start once ready" },
                { value: "todo" as const, label: "To Do only" },
              ]}
              value={startChoice}
              onChange={setStartChoice}
              none={macStart ? `This Mac's setting (${macStart.new_tasks ? "start once ready" : "To Do only"})` : "This Mac's setting"}
              styles={styles}
            />
            <Text style={styles.muted}>
              {startChoice === "todo" || (startChoice === "" && macStart && !macStart.new_tasks)
                ? "Saved in To Do; nothing starts it until you do."
                : `Once a slot of the autopilot is free, it starts once${macStart ? ` in mode ${macStart.mode}, effort ${macStart.effort} unless its agent profile or the space names others` : ""}. Not when it waits for other tasks, its brief lists open questions or a label marks it as a person's work: start such a task yourself when it is ready.`}
            </Text>
          </View>
        )}
        {/* A new task gets its assignee by an edit: create_task takes none. */}
        {editing ? (
          <Choice
            label="Assignee"
            loaded={Boolean(o)}
            options={(o?.people ?? []).map((p) => ({ value: p.key, label: p.name ? `${p.name} (${p.key})` : p.key }))}
            value={assignee}
            onChange={setAssignee}
            none="Nobody"
            styles={styles}
          />
        ) : null}
        <LabelPicker labels={labels} onChange={setLabels} palette={o?.labels ?? []} styles={styles} theme={theme} />
        <Field
          label="Issue it stands for (GitHub or GitLab URL; its PR/MR closes it on merge)"
          value={issue}
          onChange={setIssue}
          placeholder="https://github.com/owner/repo/issues/12"
          styles={styles}
          theme={theme}
        />
        <Field label="Brief (Markdown; becomes the agent's first prompt)" value={brief} onChange={setBrief} multiline styles={styles} theme={theme} />
        {editing ? null : (
          <Field label="Acceptance, one line each" value={acceptance} onChange={setAcceptance} multiline placeholder={"Works on iOS\nTests pass"} styles={styles} theme={theme} />
        )}
        {space ? (
          <TaskPicker
            space={space}
            label="Waits for"
            picked={depends}
            exclude={base.id}
            onPick={(t) => setDepends([...depends, t])}
            onUnpick={(id) => setDepends(depends.filter((d) => d.id !== id))}
            styles={styles}
            theme={theme}
          />
        ) : null}
        {clearing ? (
          <Text style={styles.error}>Clearing a project, feature, release, priority or assignee is not possible here; that change is not saved. Edit the task file to remove it.</Text>
        ) : null}
        {drifted.length ? (
          <Text style={styles.error}>{`Changed by someone else since you opened this: ${drifted.join(", ")}. Saving keeps their version of what you did not change here.`}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Saving…" : base.accept ? "Accept" : editing ? "Save" : "Create"} disabled={busy || !title.trim() || !space || (!given && (reading.pending || every.size < spaces.length))} onPress={() => void save()} styles={styles} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/**
 * A task's labels: tap one to take it off, tap a palette label to add it, or type a new one, which
 * joins the palette with the next color when the task is saved.
 */
function LabelPicker({
  labels,
  onChange,
  palette,
  styles,
  theme,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
  palette: { name: string; color: string; defined: boolean }[];
  styles: Styles;
  theme: Theme;
}) {
  const [typed, setTyped] = useState("");
  const has = (name: string) => labels.some((l) => l.toLowerCase() === name.toLowerCase());
  const add = (name: string) => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || has(clean)) return;
    // The palette's spelling wins over the typed one.
    onChange([...labels, palette.find((p) => p.name.toLowerCase() === clean.toLowerCase())?.name ?? clean]);
  };
  const offered = palette.filter((p) => p.defined && !has(p.name));
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>Labels</Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {labels.map((name) => (
          <Chip key={name} label={`✓ ${name} ✕`} active accessibilityLabel={`Remove label ${name}`} onPress={() => onChange(labels.filter((l) => l !== name))} styles={styles} />
        ))}
        {offered.map((p) => (
          <Chip key={p.name} label={`+ ${p.name}`} accessibilityLabel={`Add label ${p.name}`} onPress={() => add(p.name)} styles={styles} />
        ))}
      </View>
      <View style={[styles.row, { alignItems: "flex-end" }]}>
        <View style={{ flex: 1 }}>
          <Field label="A new label" value={typed} onChange={setTyped} placeholder="bug" styles={styles} theme={theme} />
        </View>
        <Button
          label="Add"
          ghost
          disabled={!typed.trim()}
          onPress={() => {
            add(typed);
            setTyped("");
          }}
          styles={styles}
        />
      </View>
    </View>
  );
}

/** A release: title, due date and whether it is already under way. */
export function ReleaseForm({ space: given, spaces = [], open, onClose, styles, theme }: {
  space: string;
  /** The spaces to create in, when `space` is empty (the all-spaces view). */
  spaces?: { key: string; name: string }[];
  open: boolean;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { target: space, picker } = useSpacePick(given, spaces, styles);
  const toast = useToast();
  const refresh = useRefresh();
  const create = useRpc(milestonesCreateRpc);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [status, setStatus] = useState<"planned" | "active" | "">("planned");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await create({ space, title: title.trim(), due: due.trim() || undefined, status: status || undefined });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(`Created ${answer.id}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Not saved: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New release" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        {picker}
        <Field label="Title" value={title} onChange={setTitle} placeholder="Release 2.3" styles={styles} theme={theme} />
        <Field label="Due date (YYYY-MM-DD)" value={due} onChange={setDue} placeholder="2026-11-30" styles={styles} theme={theme} />
        <Choice label="Status" options={[{ value: "planned", label: "planned" }, { value: "active", label: "active" }]} value={status} onChange={setStatus} styles={styles} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Saving…" : "Create"} disabled={busy || !title.trim() || !space} onPress={() => void save()} styles={styles} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** A feature: its release, shared branch and the projects it spans. */
export function FeatureForm({ space: given, spaces = [], open, onClose, styles, theme }: {
  space: string;
  /** The spaces to create in, when `space` is empty (the all-spaces view). */
  spaces?: { key: string; name: string }[];
  open: boolean;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { target: space, picker } = useSpacePick(given, spaces, styles);
  const toast = useToast();
  const refresh = useRefresh();
  const create = useRpc(featuresCreateRpc);
  const readOptions = useRpc(uiOptionsRpc);
  const options = useQuery({ queryKey: ["dashboard", "options", space], queryFn: () => readOptions({ space }), enabled: open && Boolean(space) });
  const [title, setTitle] = useState("");
  const [milestone, setMilestone] = useState("");
  const [branch, setBranch] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A release and projects picked in one space do not carry over to another.
  useEffect(() => {
    setMilestone("");
    setProjects([]);
  }, [space]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const answer = await create({
        space,
        title: title.trim(),
        milestone: milestone || undefined,
        branch: branch.trim() || undefined,
        projects: projects.length ? projects : undefined,
        brief: brief.trim() || undefined,
      });
      if (!answer.ok) return setError(answer.error);
      refresh();
      toast.show(`Created ${answer.id}`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(`Not saved: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  const o = options.data;
  return (
    <Modal title="New feature" open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        {picker}
        <Field label="Title" value={title} onChange={setTitle} placeholder="TOTP 2FA" styles={styles} theme={theme} />
        {o?.error ? <Text style={styles.error}>{o.error}</Text> : null}
        <Choice label="Release" loaded={Boolean(o)} options={(o?.milestones ?? []).map((m) => ({ value: m.id, label: m.title }))} value={milestone} onChange={setMilestone} none="Later" styles={styles} />
        <Field label="Shared branch" value={branch} onChange={setBranch} placeholder="feat/totp-2fa" styles={styles} theme={theme} />
        <View style={{ gap: 4 }}>
          <Text style={styles.muted}>Projects</Text>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {(o?.projects ?? []).map((p) => (
              <Chip
                key={p.key}
                label={projects.includes(p.key) ? `✓ ${p.key}` : p.key}
                active={projects.includes(p.key)}
                onPress={() => setProjects(projects.includes(p.key) ? projects.filter((k) => k !== p.key) : [...projects, p.key])}
                styles={styles}
              />
            ))}
          </View>
        </View>
        <Field label="What it is for" value={brief} onChange={setBrief} multiline styles={styles} theme={theme} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button label="Close" ghost onPress={onClose} styles={styles} />
          <Button label={busy ? "Saving…" : "Create"} disabled={busy || !title.trim() || !space} onPress={() => void save()} styles={styles} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** The task form for an existing task, filled from its full read so no field shows blank by mistake. */
export function TaskFormFor({ task, accept, onClose, styles, theme }: { task: string; accept?: boolean; onClose: () => void; styles: Styles; theme: Theme }) {
  const read = useRpc(taskViewRpc);
  const view = useQuery({ queryKey: ["dashboard", "task", task], queryFn: () => read({ task }) });
  const t = view.data;
  if (!t?.found) {
    return (
      <Modal title={accept ? "Accept draft" : "Edit task"} open onOpenChange={(next) => (next ? undefined : onClose())}>
        <Modal.Content>
          <Text style={t?.error || view.isError ? styles.error : styles.muted}>{t?.error || (view.isError ? `Could not read the task: ${String(view.error)}` : "Reading the task…")}</Text>
        </Modal.Content>
      </Modal>
    );
  }
  return (
    <TaskForm
      space={t.space}
      initial={{
        id: t.id,
        accept,
        title: t.title,
        brief: t.brief,
        project: t.project,
        feature: t.feature?.id ?? "",
        milestone: t.own_milestone,
        priority: t.priority,
        assignee: t.assignee,
        labels: t.labels.map((l) => l.name),
        depends: t.dependencies.map((d) => ({ id: d.id, title: d.title })),
        issue: t.issue?.url ?? "",
        line: t.actions.line,
      }}
      open
      onClose={onClose}
      styles={styles}
      theme={theme}
    />
  );
}
