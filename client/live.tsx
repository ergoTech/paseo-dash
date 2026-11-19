import { useEffect, useState } from "react";
import { Text, type TextStyle } from "react-native";
import { type LiveNow, liveGlow, liveSpoken, liveText } from "../shared/live.ts";

/** When this app first saw each call: a card mounted again (a new screen, a scroll) does not glow again. */
const firstSeen = new Map<string, number>();
/** Calls remembered at most; the oldest go first. */
const FIRST_SEEN_MAX = 500;

function firstSeenOf(now: LiveNow): number {
  // By its start only: a Claude call whose path arrives later (op and target change) is the same call.
  const key = now.at;
  const known = firstSeen.get(key);
  if (known !== undefined) return known;
  const seen = Date.now();
  firstSeen.set(key, seen);
  if (firstSeen.size > FIRST_SEEN_MAX) firstSeen.delete(firstSeen.keys().next().value!);
  return seen;
}

/**
 * The clock a live line reads its age from, and whether the call glows (shared/live.ts `liveGlow`).
 * The clock ticks every second while the age is under a minute, then every 15 s.
 */
export function useLiveClock(now: LiveNow): { clock: number; glowing: boolean } {
  const [clock, setClock] = useState(() => Date.now());
  const seen = firstSeenOf(now);
  const start = Date.parse(now.at);
  const recent = Number.isFinite(start) && clock - start < 60_000;
  useEffect(() => {
    // A new call starts its glow at once, not at the next tick.
    setClock(Date.now());
  }, [now.at]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), recent ? 1_000 : 15_000);
    return () => clearInterval(timer);
  }, [recent]);
  return { clock, glowing: liveGlow(now, clock, seen) };
}

/**
 * "✎ src/a.ts · 12 s": the latest call of a running task's agent, in the accent color while it
 * glows, then muted.
 */
export function LiveLine({ now, short, style, accent, muted }: { now: LiveNow; short?: boolean; style?: TextStyle; accent: string; muted: string }) {
  const { clock, glowing } = useLiveClock(now);
  return (
    <Text numberOfLines={1} ellipsizeMode="middle" style={[style, { color: glowing ? accent : muted }]} accessibilityLabel={`The agent is ${liveSpoken(now, clock)}`}>
      {liveText(now, clock, short)}
    </Text>
  );
}
