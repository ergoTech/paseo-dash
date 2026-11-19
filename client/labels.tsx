import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { uiOptionsRpc } from "../shared/ui.ts";
import { Chip, type ShownLabel, type Styles } from "./common.tsx";

export { LabelChips, type ShownLabel } from "./common.tsx";

/**
 * Labels with their palette colors, and the label and "mine" filters of the Tasks and Inbox tabs
 * (09-forge-issues.md, Labels for tasks). The chips themselves are in common.tsx.
 */

/** The space's options (projects, releases, features, labels, people, who this machine is); the forms read the same query. */
export function useSpaceOptions(space: string, enabled = true) {
  const read = useRpc(uiOptionsRpc);
  return useQuery({ queryKey: ["dashboard", "options", space], queryFn: () => read({ space }), enabled: enabled && Boolean(space) });
}

type Options = NonNullable<ReturnType<typeof useSpaceOptions>["data"]>;

/**
 * Several spaces' options at once (the all-spaces lists), by space key; a space not read yet is
 * missing from `of`, `pending` while any is still being read, `error` why one could not be.
 */
export function useOptionsOf(spaces: string[]): { of: Map<string, Options>; pending: boolean; error: string } {
  const read = useRpc(uiOptionsRpc);
  const answers = useQueries({ queries: spaces.map((space) => ({ queryKey: ["dashboard", "options", space], queryFn: () => read({ space }) })) });
  const of = new Map<string, Options>();
  const errors: string[] = [];
  spaces.forEach((space, i) => {
    const answer = answers[i];
    if (answer?.data) of.set(space, answer.data);
    if (answer?.data?.error) errors.push(`${space}: ${answer.data.error}`);
    else if (answer?.isError) errors.push(`${space}: ${String(answer.error)}`);
  });
  return { of, pending: answers.some((a) => a.isPending), error: errors.join("; ") };
}

/** Names to labels with the palette's colors (`ui.options` labels: the palette, then undefined ones in use). */
export function withColors(names: string[], palette: { name: string; color: string; defined: boolean }[] | undefined): ShownLabel[] {
  return names.map((name) => {
    const found = palette?.find((l) => l.name.toLowerCase() === name.toLowerCase());
    // Before the options are read, a label is not called undefined.
    return { name, color: found?.color ?? "", defined: palette ? Boolean(found?.defined) : true };
  });
}

/**
 * "Mine" and one label at a time, as chips; the parent passes them to `tasks.list` / `inbox.list`,
 * whose error says when no person has this machine's git email. With `space` empty (the all-spaces
 * lists) the labels are every space's, once each by name, and "mine" is each space's own person.
 */
export function TaskFilters({
  space,
  spaces = [],
  mine,
  onMine,
  label,
  onLabel,
  styles,
}: {
  space: string;
  /** The spaces of the all-spaces lists, when `space` is empty. */
  spaces?: string[];
  mine: boolean;
  onMine: (mine: boolean) => void;
  label: string;
  onLabel: (label: string) => void;
  styles: Styles;
}) {
  const options = useSpaceOptions(space).data;
  const every = useOptionsOf(space ? [] : spaces).of;
  const all = space ? (options ? [options] : []) : [...every.values()];
  const labels = [...new Map(all.flatMap((o) => o.labels).map((l) => [l.name.toLowerCase(), l] as const)).values()];
  const me = [...new Set(all.map((o) => o.me.key).filter(Boolean))].join(", ");
  return (
    <View style={{ gap: 4 }}>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Chip
          label={mine ? `✓ Mine${me ? ` (${me})` : ""}` : "Mine"}
          active={mine}
          accessibilityLabel="Only tasks assigned to me"
          onPress={() => onMine(!mine)}
          styles={styles}
        />
        {label && !labels.some((l) => l.name.toLowerCase() === label.toLowerCase()) ? (
          <Chip label={`✓ ${label} (not in this space)`} active accessibilityLabel={`Clear label ${label}`} onPress={() => onLabel("")} styles={styles} />
        ) : null}
        {labels.map((l) => (
          <Chip
            key={l.name}
            label={`${label.toLowerCase() === l.name.toLowerCase() ? "✓ " : ""}${l.name}${l.defined ? "" : " (not defined)"}`}
            active={label.toLowerCase() === l.name.toLowerCase()}
            accessibilityLabel={`Only tasks labelled ${l.name}`}
            onPress={() => onLabel(label.toLowerCase() === l.name.toLowerCase() ? "" : l.name)}
            styles={styles}
          />
        ))}
      </View>
    </View>
  );
}

/** The all-spaces lists' space filter: every space, or one. */
export function SpaceFilter({ spaces, value, onChange, styles }: { spaces: { key: string; name: string }[]; value: string; onChange: (space: string) => void; styles: Styles }) {
  if (spaces.length < 2) return null;
  return (
    <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: "wrap" }]}>
      <Chip label={value ? "All spaces" : "✓ All spaces"} active={!value} onPress={() => onChange("")} styles={styles} />
      {spaces.map((s) => (
        <Chip
          key={s.key}
          label={`${value === s.key ? "✓ " : ""}${s.key}`}
          active={value === s.key}
          accessibilityLabel={`Only space ${s.name}`}
          onPress={() => onChange(value === s.key ? "" : s.key)}
          styles={styles}
        />
      ))}
    </View>
  );
}
