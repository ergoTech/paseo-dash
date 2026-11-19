import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, ScrollView, Text, View } from "react-native";
import { liveSpoken } from "../shared/live.ts";
import { type Glyph, type MetroMap, overlapLinks } from "../shared/map.ts";
import { LineBadge } from "./common.tsx";
import { LiveLine } from "./live.tsx";
import { countBadge, geometry } from "./geometry.ts";
import { GLYPH_CHAR, GLYPH_LABEL, glyphColor, stationStatus } from "./glyphs.ts";

type Theme = PluginHostProps["theme"];

/**
 * The metro map drawn with views only (04-ux.md, Rendering and scale): absolutely positioned
 * panels, lines, interchange capsules and stations in a content view of computed size, scrolled
 * horizontally inside a vertical scroll, with the line badges fixed on the left. Each line has its
 * project's color; a station's ring takes the line's color and its mark the status, so status never
 * relies on color alone. Labels on is the near view (titles by the stations), off the far view.
 */

const NAMES_W = 124;
const STATION = 26;
/** Label dots a station shows at most; the task screen and the lists show every label. */
const LABEL_DOTS = 4;
/** Room between a station and its texts; a cluster's count badge ends BADGE_CLEAR before them. */
const LABEL_GAP = 10;
const BADGE_CLEAR = 2;
const TITLE_LH = 15;

function Pulse({ children, active }: { children: React.ReactNode; active: boolean }) {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let loop: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || stopped) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(value, { toValue: 0.45, duration: 800, useNativeDriver: true }),
          Animated.timing(value, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => {
      stopped = true;
      loop?.stop();
      value.setValue(1);
    };
  }, [active, value]);
  return <Animated.View style={{ opacity: value }}>{children}</Animated.View>;
}

export interface MetroProps {
  map: MetroMap;
  theme: Theme;
  labels: boolean;
  /** A station by its key, with the title it shows. */
  onStation(key: string, title: string): void;
  onFeature(feature: string): void;
  onLine(project: string): void;
  /** The line's open Paseo workspaces outside the plan. */
  onActivity(project: string): void;
}

/** A release column is a filled panel; Later and Done are outlined, since they are not releases. */
const isRelease = (id: string) => id !== "later" && id !== "done";

function ColumnHeader({ column, theme }: { column: MetroMap["columns"][number]; theme: Theme }) {
  const c = theme.colors;
  const late = column.days_left !== null && column.days_left < 0;
  const release = isRelease(column.id);
  const subtitle =
    column.id === "later"
      ? "not scheduled"
      : column.id === "done"
        ? "finished releases"
        : [column.due, column.days_left === null ? "" : late ? `${-column.days_left} days late` : column.days_left === 0 ? "due today" : `in ${column.days_left} days`]
            .filter(Boolean)
            .join(" · ") || "no due date";
  const percent = column.total ? Math.round((100 * column.done) / column.total) : 0;
  return (
    <View style={{ position: "absolute", left: 12, right: 10, top: 8, gap: 4 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, fontWeight: "700" }}>
        {column.title}
      </Text>
      <Text numberOfLines={1} style={{ color: late ? c.statusDanger : c.foregroundMuted, fontSize: 11 }}>
        {subtitle}
      </Text>
      {release ? (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: c.border, overflow: "hidden" }}>
          <View style={{ width: `${percent}%`, height: 6, backgroundColor: c.statusSuccess }} />
        </View>
      ) : (
        <View style={{ height: 6 }} />
      )}
      <Text numberOfLines={1} style={{ fontSize: 11, color: c.foregroundMuted }}>
        {release ? `${column.done}/${column.total} done · ${percent}%` : column.id === "done" ? `${column.total} task(s)` : `${column.total} task(s)`}
        {column.needs_you ? <Text style={{ color: c.statusDanger, fontWeight: "700" }}>{`  ! ${column.needs_you}`}</Text> : null}
        {column.blocked ? <Text style={{ color: c.foregroundMuted }}>{`  ⊘ ${column.blocked}`}</Text> : null}
      </Text>
    </View>
  );
}

export function MetroView({ map, theme, labels, onStation, onFeature, onLine, onActivity }: MetroProps) {
  const [available, setAvailable] = useState(0);
  const g = useMemo(() => geometry(map, labels, available), [map, labels, available]);
  const c = theme.colors;
  const lineColor = (row: number) => map.lines[row]?.color || c.foregroundMuted;
  // A group starts at its first line; its name sits above that line's badge.
  const groupStarts = map.groups.length ? map.lines.filter((line, i) => i === 0 || map.lines[i - 1]!.group !== line.group) : [];
  const panel = (column: number) => (isRelease(map.columns[column]?.id ?? "") ? c.surface1 : c.surface0);
  // Project keys and the Later and Done column ids recur in every space's band of the all-spaces
  // map; React keys carry the space, so bands drawn side by side in one tree never share a key.
  const own = `${map.space.key}/`;
  return (
    <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: "row" }} onLayout={(e) => setAvailable(Math.max(0, e.nativeEvent.layout.width - NAMES_W))}>
      <View style={{ width: NAMES_W, height: g.height }}>
        {groupStarts.map((line) => (
          <Text
            key={`${own}group:${line.project}`}
            numberOfLines={1}
            style={{ position: "absolute", left: 0, width: NAMES_W - 10, top: g.y(line.row) - g.rowH / 2 + 2, color: c.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 }}
          >
            {(line.group || "No group").toUpperCase()}
          </Text>
        ))}
        {map.lines.map((line) => (
          <Pressable
            key={`${own}badge:${line.project}`}
            accessibilityRole="button"
            accessibilityLabel={`Line ${line.project}${line.empty ? ", no tasks yet" : ""}`}
            onPress={() => onLine(line.project)}
            style={{ position: "absolute", left: 0, width: NAMES_W - 12, top: g.y(line.row) - 12, height: 24, justifyContent: "center", opacity: line.empty ? 0.6 : 1 }}
          >
            <LineBadge project={line.project} color={line.color} theme={theme} size={labels ? "normal" : "small"} />
          </Pressable>
        ))}
        {map.lines
          .filter((line) => line.open > 0 || line.shared_with.length > 0)
          .map((line) => {
            // Under the badge: the line's work in Paseo outside the plan; busy (working or waiting) in
            // color. Dimmed while Paseo could not be read: the sheet says when the counts are from.
            // A repository that is a line in other spaces too says so, briefly in this narrow column (the
            // Projects tab names the spaces). To keep "shared" in view, the busy count is then left to
            // the dot and the accessibility label.
            const isShared = line.shared_with.length > 0;
            const counts = line.open > 0 ? (line.busy && !isShared ? `${line.busy} · ${line.open} in Paseo` : `${line.open} in Paseo`) : "";
            const shared = !isShared ? "" : counts ? "shared" : `also in ${line.shared_with.join(", ")}`;
            return (
              <Pressable
                key={`${own}activity:${line.project}`}
                accessibilityRole={line.open > 0 ? "button" : "text"}
                accessibilityLabel={[
                  line.open > 0 ? `${line.project} in Paseo: ${line.busy} busy, ${line.open} open${line.stale ? ", from an earlier read" : ""}` : line.project,
                  shared ? `also a line in ${line.shared_with.join(", ")}, with its own tasks there` : "",
                ]
                  .filter(Boolean)
                  .join("; ")}
                disabled={line.open === 0}
                onPress={() => onActivity(line.project)}
                hitSlop={4}
                // Inside the line's own row in both views: the next row may start with a group caption.
                // Dimmed only for the counts: which spaces share the repository does not come from Paseo.
                style={{ position: "absolute", left: 2, width: NAMES_W - 4, top: g.y(line.row) + (labels ? 12 : 9), height: labels ? 15 : 12, flexDirection: "row", alignItems: "center", gap: 3, opacity: line.stale && counts ? 0.45 : 1 }}
              >
                {line.busy ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: line.stale ? c.foregroundMuted : c.accent }} /> : null}
                <Text numberOfLines={1} style={{ flexShrink: 1, color: line.busy ? c.foreground : c.foregroundMuted, fontSize: labels ? 10 : 9, fontWeight: "600" }}>
                  {[counts, shared].filter(Boolean).join(" · ")}
                </Text>
              </Pressable>
            );
          })}
      </View>
      <ScrollView horizontal style={{ flex: 1 }}>
        <View style={{ width: g.width, height: g.height }}>
          {map.columns.map((col, i) => (
            <View
              key={`${own}column:${col.id}`}
              style={{
                position: "absolute",
                left: g.columnX[i],
                top: 0,
                width: g.columnW[i],
                height: g.height,
                borderRadius: 10,
                backgroundColor: panel(i),
                borderWidth: isRelease(col.id) ? 0 : 1,
                borderStyle: "dashed",
                borderColor: c.border,
              }}
            >
              <ColumnHeader column={col} theme={theme} />
            </View>
          ))}
          {groupStarts
            .filter((line) => line.row > 0)
            .map((line) => (
              <View key={`${own}divider:${line.project}`} style={{ position: "absolute", left: 0, width: g.width, top: g.y(line.row) - g.rowH / 2, height: 1, backgroundColor: c.border }} />
            ))}
          {map.lines.map((line) => (
            <View
              key={`${own}line:${line.project}`}
              // A line with no station yet is drawn faint: it is there, nothing runs on it.
              style={{ position: "absolute", left: 6, width: g.width - 12, top: g.y(line.row) - 2.5, height: 5, borderRadius: 3, backgroundColor: lineColor(line.row), opacity: line.empty ? 0.3 : 1 }}
            />
          ))}
          {map.interchanges.map((ic) => {
            const x = g.x(ic.column, ic.slot);
            const w = STATION + 10;
            return (
              <Pressable
                key={`${own}${ic.key}`}
                accessibilityRole="button"
                accessibilityLabel={`Feature ${ic.title}`}
                onPress={() => onFeature(ic.feature)}
                style={{
                  position: "absolute",
                  left: x - w / 2,
                  top: g.y(ic.top) - w / 2,
                  width: w,
                  height: g.y(ic.bottom) - g.y(ic.top) + w,
                  borderRadius: w / 2,
                  borderWidth: 2,
                  borderColor: c.foreground,
                  backgroundColor: c.surface0,
                }}
              />
            );
          })}
          {labels
            ? map.interchanges.map((ic) => {
                const own = map.stations.filter((s) => s.column === ic.column && s.feature === ic.feature).flatMap((s) => s.tasks);
                const done = own.filter((t) => t.glyph === "done").length;
                const width = g.slotW(ic.column) - 8;
                return (
                  <Pressable
                    key={`${own}${ic.key}:title`}
                    accessibilityRole="button"
                    onPress={() => onFeature(ic.feature)}
                    style={{
                      position: "absolute",
                      left: g.slotX(ic.column, ic.slot) + 4,
                      width,
                      top: g.y(ic.top) - (STATION + 10) / 2 - 24,
                      alignItems: "flex-start",
                    }}
                  >
                    <View style={{ flexDirection: "row", maxWidth: width, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: c.surface2, gap: 5 }}>
                      <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: 11, fontWeight: "700" }}>
                        {ic.title}
                      </Text>
                      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{`${done}/${own.length}`}</Text>
                    </View>
                  </Pressable>
                );
              })
            : null}
          {overlapLinks(map).map(({ key, from, to }) => {
            // A red link between two stations whose tasks' runs here change the same files.
            const x1 = g.x(from.column, from.slot);
            const y1 = g.y(from.row);
            const x2 = g.x(to.column, to.slot);
            const y2 = g.y(to.row);
            const length = Math.hypot(x2 - x1, y2 - y1);
            return (
              <View
                key={`${own}overlap:${key}`}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: (x1 + x2) / 2 - length / 2,
                  top: (y1 + y2) / 2 - 1.5,
                  width: length,
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: c.statusDanger,
                  opacity: 0.75,
                  transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
                }}
              />
            );
          })}
          {map.stations.map((s) => {
            const color = glyphColor(theme, s.glyph);
            // Named after the task that gives the station its mark; the tasks themselves are in start order.
            const first = s.tasks.find((t) => t.glyph === s.glyph) ?? s.tasks[0]!;
            const title = s.tasks.length === 1 ? first.title : `${first.title} +${s.tasks.length - 1}`;
            const status = stationStatus(s.tasks.map((t) => t.glyph));
            // While the station's marking task is working on this machine, its latest call replaces the
            // status under the line; a station marked by a task that needs you keeps saying so.
            const live = s.glyph === "working" ? first.live : undefined;
            const shares = s.tasks.some((t) => t.overlaps?.length);
            const halo = s.glyph === "needs_you" || s.glyph === "failed" ? c.statusDanger : s.glyph === "working" ? c.accent : undefined;
            // The labels of the station's tasks, once each, as dots after the status (near view only).
            const tags = [...new Map(s.tasks.flatMap((t) => t.labels).map((l) => [l.name.toLowerCase(), l] as const)).values()];
            // Near view: the title sits above the line and the status below it, right of the station
            // (clear of a cluster's count badge), so the line runs on unbroken; both may take up to the
            // rest of the slot. The pressable covers the station and both texts.
            const x = g.x(s.column, s.slot);
            const y = g.y(s.row);
            const textLeft = STATION + LABEL_GAP;
            const labelW = Math.max(56, g.slotX(s.column, s.slot) + g.slotW(s.column) - (x - STATION / 2 + textLeft) - 6);
            // From just above the title: the interchange's tag above the top row stays the feature's.
            const top = labels ? y - 5 - TITLE_LH - 2 : y - STATION / 2;
            const ringTop = y - STATION / 2 - top;
            return (
              <Pressable
                key={`${own}${s.key}`}
                accessibilityRole="button"
                accessibilityLabel={[`${map.lines[s.row]?.project}, ${title}, ${live ? `the agent is ${liveSpoken(live, 0, false)}` : status}`, ...overlapSpoken(s.tasks), ...tags.map((l) => `label ${l.name}`)].join(", ")}
                onPress={() => onStation(s.key, title)}
                style={{ position: "absolute", left: x - STATION / 2, top, width: labels ? textLeft + labelW : STATION, height: labels ? 2 * (y - top) : STATION }}
              >
                <View style={{ position: "absolute", left: 0, top: ringTop }}>
                  <Pulse active={s.glyph === "working"}>
                    <View
                      style={{
                        width: STATION,
                        height: STATION,
                        borderRadius: STATION / 2,
                        borderWidth: 3,
                        borderColor: lineColor(s.row),
                        backgroundColor: c.surface0,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color, fontSize: 12, fontWeight: "800" }}>{GLYPH_CHAR[s.glyph]}</Text>
                    </View>
                    {halo ? (
                      <View
                        pointerEvents="none"
                        style={{ position: "absolute", left: -4, top: -4, width: STATION + 8, height: STATION + 8, borderRadius: (STATION + 8) / 2, borderWidth: 2, borderColor: halo }}
                      />
                    ) : null}
                    {shares ? (
                      // Its own ring, dashed and wider than the status halo: a collision is not a request for you.
                      <View
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          left: -9,
                          top: -9,
                          width: STATION + 18,
                          height: STATION + 18,
                          borderRadius: (STATION + 18) / 2,
                          borderWidth: 2,
                          borderStyle: "dashed",
                          borderColor: c.statusDanger,
                        }}
                      />
                    ) : null}
                  </Pulse>
                </View>
                {s.tasks.length > 1 ? (
                  // The badge's right edge is fixed short of the texts: a longer count grows over the ring.
                  <View pointerEvents="none" style={{ position: "absolute", left: 0, width: textLeft - BADGE_CLEAR, top: ringTop - 8, alignItems: "flex-end" }}>
                    <View style={{ minWidth: 16, height: 16, paddingHorizontal: 3, borderRadius: 8, backgroundColor: c.foreground, alignItems: "center", justifyContent: "center" }}>
                      <Text numberOfLines={1} style={{ color: c.surface0, fontSize: 10, fontWeight: "800" }}>
                        {countBadge(s.tasks.length)}
                      </Text>
                    </View>
                  </View>
                ) : null}
                {labels ? (
                  <>
                    <Text numberOfLines={1} style={{ position: "absolute", left: textLeft, top: y - 5 - TITLE_LH - top, maxWidth: labelW, color: c.foreground, fontSize: 12, lineHeight: TITLE_LH, fontWeight: "500" }}>
                      {title}
                    </Text>
                    <View style={{ position: "absolute", left: textLeft, top: y + 5 - top, maxWidth: labelW, flexDirection: "row", alignItems: "center", gap: 3 }}>
                      {live ? (
                        <LiveLine now={live} short style={{ flexShrink: 1, fontSize: 10, lineHeight: 13 }} accent={c.accent} muted={c.foregroundMuted} />
                      ) : (
                        <Text numberOfLines={1} style={{ flexShrink: 1, color: color === c.foregroundMuted ? c.foregroundMuted : color, fontSize: 10, lineHeight: 13 }}>
                          {status}
                        </Text>
                      )}
                      {tags.slice(0, LABEL_DOTS).map((l) => (
                        <View
                          key={l.name}
                          style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: l.defined ? l.color || c.foregroundMuted : "transparent", borderWidth: l.defined ? 0 : 1, borderColor: c.foregroundMuted }}
                        />
                      ))}
                    </View>
                  </>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const LEGEND: Glyph[] = ["todo", "working", "review", "done", "blocked", "needs_you", "failed", "elsewhere"];

/** What the marks mean, in one muted row under the map. */
export function MetroLegend({ theme }: { theme: Theme }) {
  return (
    <View accessibilityLabel="Legend" style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
      {LEGEND.map((glyph) => (
        <View key={glyph} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: glyphColor(theme, glyph), fontSize: 12, fontWeight: "800" }}>{GLYPH_CHAR[glyph]}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{GLYPH_LABEL[glyph]}</Text>
        </View>
      ))}
    </View>
  );
}

/** One line's marks across the releases, releases split by `┆`: the phone's line list and the feature cards. */
export function glyphStrip(map: MetroMap, row: number): string {
  return map.columns
    .map((_, column) =>
      map.stations
        .filter((s) => s.row === row && s.column === column)
        .map((s) => GLYPH_CHAR[s.glyph])
        .join(" "),
    )
    .join(" ┆ ");
}

type Station = MetroMap["stations"][number];

/** "shares files with ERG-X", once per other task, for a station's accessibility label. */
function overlapSpoken(tasks: Station["tasks"]): string[] {
  return [...new Set(tasks.flatMap((t) => (t.overlaps ?? []).map((o) => o.task)))].map((task) => `shares files with ${task}`);
}
