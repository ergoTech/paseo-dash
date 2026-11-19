import { useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { changesRpc } from "../shared/changes.ts";
import { pollChanges, sharedPoll } from "./changes-poll.ts";

/** Whether the app is on screen: a state not known yet counts as on screen. */
export function appVisible(): boolean {
  return AppState.currentState !== "background" && AppState.currentState !== "inactive";
}

const polls = new WeakMap<QueryClient, { users: number; stop: () => void }>();
const listeners = new Set<() => void>();

/** Calls back whenever a poll sees the token move; returns the cleanup. For what is not a query. */
export function onChangesSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Queries under "dashboard" a moved token leaves to their reserve read or a mutation, because each read
 * costs more than a look at memory: a call to Laconote's service, git per project (the projects list,
 * and hello's mapping of this machine's checkouts), the plan's history.
 */
const COSTLY_READS = new Set<unknown>(["laconote", "projects", "recap", "hello"]);

/**
 * How long the next token request waits for the reads a moved token caused: a read that keeps failing
 * goes through its retries, and the poll does not wait them out.
 */
const REFRESH_WAIT_MS = 5_000;

/**
 * While a surface using this is mounted and the app is on screen, polls `dashboard.changes` and
 * refreshes the open queries when the token moves. One poll per host's query client, however many
 * surfaces are mounted.
 */
export function useChanges(): void {
  const queryClient = useQueryClient();
  const read = useRpc(changesRpc);
  useEffect(
    () =>
      sharedPoll(polls, queryClient, () =>
        pollChanges({
          read: () => read({}),
          changed: () => {
            for (const listener of listeners) listener();
            const refresh = queryClient.invalidateQueries({ queryKey: ["dashboard"], predicate: (query) => !COSTLY_READS.has(query.queryKey[1]) });
            return Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS))]);
          },
          visible: appVisible,
          onVisibility: (listener) => {
            const subscription = AppState.addEventListener("change", listener);
            return () => subscription.remove();
          },
        }),
      ),
    [queryClient, read],
  );
}
