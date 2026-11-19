import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Glyph } from "../shared/map.ts";
import { overviewRpc } from "../shared/overview.ts";
import { GLYPH_CHAR, GLYPH_LABEL, glyphColor } from "./glyphs.ts";

/**
 * The reserve: how often a visible screen reads again whatever the token says. Changes show through
 * the token (client/changes.ts); this catches what it does not cover, like Paseo's own workspaces.
 */
export const REFRESH_MS = 60_000;

type Theme = PluginHostProps["theme"];

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 12 : 20, gap: compact ? 12 : 16 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
      heading: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        gap: 6,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      chip: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      button: {
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
      ghost: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      ghostText: { color: theme.colors.foreground, fontSize: 14 },
    }),
    [theme, compact],
  );
}

export type Styles = ReturnType<typeof useStyles>;

/** A station mark: the glyph character in its color, with a spoken label. */
export function Mark({ glyph, theme, size = 15 }: { glyph: Glyph; theme: Theme; size?: number }) {
  return (
    <Text accessibilityLabel={GLYPH_LABEL[glyph]} style={{ color: glyphColor(theme, glyph), fontSize: size, fontWeight: "700", minWidth: size }}>
      {GLYPH_CHAR[glyph]}
    </Text>
  );
}

export function Chip({
  label,
  active,
  onPress,
  styles,
  accessibilityLabel,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  styles: Styles;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

export function Button({ label, onPress, styles, ghost, disabled, accessibilityLabel }: { label: string; onPress: () => void; styles: Styles; ghost?: boolean; disabled?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[ghost ? styles.ghost : styles.button, disabled ? { opacity: 0.5 } : null]}
    >
      <Text style={ghost ? styles.ghostText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** Underlined tabs: navigation reads differently from filter chips, toggles and status badges. */
export function Tabs<T extends string>({ tabs, value, onChange, styles, theme }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; styles: Styles; theme: Theme }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.id)}
            style={{ paddingVertical: 8, paddingHorizontal: 12, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: active ? theme.colors.accent : "transparent" }}
          >
            <Text style={[styles.text, { color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontWeight: active ? "600" : "400" }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** An on/off view option (labels, finished releases): a small square button with a check mark when on. */
export function Toggle({ label, value, onChange, theme }: { label: string; value: boolean; onChange: (value: boolean) => void; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: value ? theme.colors.surface2 : "transparent" }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          borderWidth: 1.5,
          borderColor: value ? theme.colors.accent : theme.colors.foregroundMuted,
          backgroundColor: value ? theme.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Text style={{ color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700", lineHeight: 12 }}>✓</Text> : null}
      </View>
      <Text style={{ color: value ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** A project's line badge, as on a metro map: its key in white on the line's color. */
export function LineBadge({ project, color, theme, size = "normal" }: { project: string; color: string; theme: Theme; size?: "normal" | "small" }) {
  const small = size === "small";
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 1 : 3, borderRadius: small ? 4 : 6, backgroundColor: color || theme.colors.surface2 }}>
      <Text numberOfLines={1} style={{ color: color ? "#ffffff" : theme.colors.foreground, fontSize: small ? 11 : 12, fontWeight: "700" }}>
        {project}
      </Text>
    </View>
  );
}

/**
 * Needs you, working, review and inbox counts of a space as status badges, not buttons: a zero is
 * muted, "needs you" turns red when something waits. Each opens the Live tab or the inbox.
 */
export function LiveStrip({ space, theme, onOpen }: { space: string; theme: Theme; onOpen: (tab: "live" | "inbox") => void }) {
  const read = useRpc(overviewRpc);
  const overview = useQuery({ queryKey: ["dashboard", "overview", space], queryFn: () => read({ space }), refetchInterval: REFRESH_MS });
  const counts = overview.data?.counts;
  const badges: { label: string; glyph?: Glyph; value: number | undefined; tab: "live" | "inbox"; alarm?: boolean }[] = [
    { label: "needs you", glyph: "needs_you", value: counts?.needs_you, tab: "live", alarm: true },
    { label: "working", glyph: "working", value: counts?.running, tab: "live" },
    { label: "review", glyph: "review", value: counts?.review, tab: "live" },
    { label: "inbox", value: counts?.inbox, tab: "inbox" },
  ];
  return (
    <View accessibilityRole="summary" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {badges.map((b) => {
        // Before the first answer show no number: a zero would read as "all quiet".
        const text = b.value === undefined ? "–" : String(b.value);
        const lit = Boolean(b.value);
        const color = lit && b.alarm ? theme.colors.statusDanger : lit ? theme.colors.foreground : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={b.label}
            accessibilityRole="button"
            accessibilityLabel={`${text} ${b.label}`}
            onPress={() => onOpen(b.tab)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingVertical: 3,
              paddingHorizontal: 8,
              borderRadius: 12,
              backgroundColor: lit && b.alarm ? theme.colors.surface2 : "transparent",
            }}
          >
            {b.glyph ? <Text style={{ color: lit ? glyphColor(theme, b.glyph) : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>{GLYPH_CHAR[b.glyph]}</Text> : null}
            <Text style={{ color, fontSize: 13, fontWeight: lit ? "700" : "400" }}>{text}</Text>
            <Text style={{ color: lit ? color : theme.colors.foregroundMuted, fontSize: 13 }}>{b.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Section({ title, styles, children, trailing }: { title: string; styles: Styles; children: ReactNode; trailing?: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text accessibilityRole="header" style={styles.heading}>
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** A label on a card or a task screen. */
export interface ShownLabel {
  name: string;
  /** Empty: a neutral color. */
  color: string;
  /** False: the palette does not define it. */
  defined: boolean;
}

/** Labels as small chips; one the palette does not define is neutral and dashed, never hidden. */
export function LabelChips({ labels, theme, small }: { labels: ShownLabel[]; theme: Theme; small?: boolean }) {
  if (!labels.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {labels.map((label) => (
        <View
          key={label.name}
          accessibilityLabel={label.defined ? `label ${label.name}` : `label ${label.name}, not defined in the space`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: small ? 5 : 7,
            paddingVertical: small ? 0 : 1,
            borderRadius: 9,
            borderWidth: 1,
            borderStyle: label.defined ? "solid" : "dashed",
            borderColor: label.color || theme.colors.border,
          }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: label.color || theme.colors.foregroundMuted }} />
          <Text numberOfLines={1} style={{ color: label.defined ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: small ? 10 : 11 }}>
            {label.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Which space a row of the all-spaces lists belongs to: its key in a small outlined tag. */
export function SpaceTag({ space, theme }: { space: string; theme: Theme }) {
  return (
    <View accessibilityLabel={`space ${space}`} style={{ paddingHorizontal: 5, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.border, alignSelf: "flex-start", marginTop: 2 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 }}>
        {space}
      </Text>
    </View>
  );
}

/** A pressable list row: a mark, a title and a muted note; in the all-spaces lists, its space's tag. */
export function ItemRow({
  glyph,
  title,
  note,
  quote,
  labels,
  space,
  active,
  onPress,
  theme,
  styles,
}: {
  glyph?: Glyph;
  title: string;
  note?: string;
  /** Where a search found the row: "notes: «…»". */
  quote?: string;
  labels?: ShownLabel[];
  /** The row's space key, shown as a tag (the all-spaces lists only). */
  space?: string;
  /** The row is what the inspector shows. */
  active?: boolean;
  onPress?: () => void;
  theme: Theme;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={[glyph ? GLYPH_LABEL[glyph] : "", space ? `space ${space}` : "", title, note ?? "", quote ?? "", ...(labels ?? []).map((l) => `label ${l.name}`)].filter(Boolean).join(", ")}
      accessibilityState={active ? { selected: true } : undefined}
      onPress={onPress}
      style={[styles.row, { paddingVertical: 6 }, active ? { backgroundColor: theme.colors.surface2, borderRadius: 6, marginHorizontal: -6, paddingHorizontal: 6 } : null]}
    >
      {glyph ? <Mark glyph={glyph} theme={theme} /> : null}
      {space ? <SpaceTag space={space} theme={theme} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text} numberOfLines={2}>
          {title}
        </Text>
        {note ? (
          <Text style={styles.muted} numberOfLines={2}>
            {note}
          </Text>
        ) : null}
        {quote ? (
          <Text style={[styles.muted, { fontStyle: "italic" }]} numberOfLines={2}>
            {quote}
          </Text>
        ) : null}
        {labels?.length ? <LabelChips labels={labels} theme={theme} small /> : null}
      </View>
    </Pressable>
  );
}

/** Plan text is other people's: only http(s) URLs become links; anything else shows as text. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url);
}
