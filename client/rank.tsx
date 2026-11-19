import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { tasksRankRpc } from "../shared/ui.ts";
import { Button, type Styles } from "./common.tsx";
import { useRefresh } from "./forms.tsx";

type Position = "top" | "bottom" | "up" | "down";

/** A task's moves among the tasks of its priority waiting to start (D21), with what a person hears. */
export function useRank(announce = false) {
  const move = useRpc(tasksRankRpc);
  const toast = useToast();
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const go = async (task: string, position: Position) => {
    setBusy(true);
    try {
      const answer = await move({ task, position });
      if (!answer.ok) toast.error(answer.error);
      // A list shows the move; a press that changes nothing is said everywhere.
      else if (!answer.changed) toast.show(`${task} is already there among the tasks of its priority`);
      else if (announce) toast.show(`${task} moved`, { variant: "success" });
      refresh();
    } catch (failure) {
      toast.error(`Unknown whether it moved: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  return { busy, go };
}

/** Up, down and to the top, for a task waiting to start or a draft. `compact`: arrows only. */
export function RankButtons({ task, styles, compact }: { task: string; styles: Styles; compact?: boolean }) {
  const { busy, go } = useRank(!compact);
  return (
    <View style={[styles.row, { gap: 4 }]}>
      {compact ? null : <Button label="To top" accessibilityLabel="Move to the top of its priority" ghost disabled={busy} onPress={() => void go(task, "top")} styles={styles} />}
      <Button label="▲" accessibilityLabel="Move up" ghost disabled={busy} onPress={() => void go(task, "up")} styles={styles} />
      <Button label="▼" accessibilityLabel="Move down" ghost disabled={busy} onPress={() => void go(task, "down")} styles={styles} />
    </View>
  );
}
