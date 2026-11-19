import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";
import type { ScreenLocation } from "./history.ts";
import { goBack, useBackTarget } from "./nav.ts";

/**
 * "‹ Back" at the top of the dashboard screen at `here`: to the screen it was opened from, else to
 * its parent (`fallback`); nothing when there is neither.
 */
export function BackRow({ here, fallback, theme }: { here: ScreenLocation; fallback?: ScreenLocation; theme: PluginHostProps["theme"] }) {
  const target = useBackTarget(here, fallback);
  if (!target) return null;
  const label = target.title || "Back";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      onPress={() => goBack(here, fallback)}
      hitSlop={8}
      style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingRight: 8 }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 18, lineHeight: 20 }}>‹</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: 14, maxWidth: 320 }}>
        {label}
      </Text>
    </Pressable>
  );
}
