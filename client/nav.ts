import type { PluginClientContext, PluginScreenParams } from "@getpaseo/plugin/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { ScreenHistory, type ScreenId, type ScreenLocation } from "./history.ts";
import { type Peek, peekKey, type Sibling } from "./peek.ts";

/**
 * Screens open each other through the client context `contribute` received: screen props carry
 * only agent and workspace navigation. Paseo 0.13 has no back navigation for plugin screens, so the
 * dashboard keeps its own history (client/history.ts): each screen says where it is (`Here`), opens
 * others with `useOpen`, reports its arrival, and offers "‹ Back".
 */
let client: PluginClientContext | undefined;
export const history = new ScreenHistory();

export function setClient(context: PluginClientContext | undefined): void {
  client = context;
}

/** The screen a component is on: its id, params (tab and filters included) and title. */
const HereContext = createContext<ScreenLocation | undefined>(undefined);
export const Here = HereContext.Provider;

/** Opens a screen; `from` is the dashboard screen it is opened from, if any (then "‹ Back" returns there). */
export function openScreen(screenId: ScreenId, params: PluginScreenParams = {}, from?: ScreenLocation): void {
  history.go(from, { screenId, params });
  client?.openScreen({ screenId, params });
}

/** Opens Settings → Paseo Dash, the settings screen `index.client.tsx` registers as "spaces". */
export function openSettings(): void {
  client?.openSettings("spaces");
}

/**
 * `openScreen` from the screen this component is on: the `Here` around it, else `own` (a screen's
 * top component, which provides `Here` to its children).
 */
export function useOpen(own?: ScreenLocation): (screenId: ScreenId, params?: PluginScreenParams) => void {
  const here = useContext(HereContext) ?? own;
  return useCallback((screenId, params = {}) => openScreen(screenId, params, here), [here]);
}

/** Tells the history this screen came into view with these params. */
export function useArrival(screenId: ScreenId, params: PluginScreenParams): void {
  const key = JSON.stringify(params);
  useEffect(() => {
    history.arrive({ screenId, params: JSON.parse(key) as PluginScreenParams });
  }, [screenId, key]);
}

/** Where "‹ Back" on the screen at `own` leads now: the previous other screen, else `fallback`. */
export function useBackTarget(own: ScreenLocation, fallback?: ScreenLocation): ScreenLocation | undefined {
  useSyncExternalStore(history.subscribe, history.snapshot);
  return history.previous(own) ?? fallback;
}

export function goBack(own: ScreenLocation, fallback?: ScreenLocation): void {
  const target = history.back(own, fallback);
  if (target) client?.openScreen({ screenId: target.screenId, params: target.params });
}

/** The inspector of the space screen around a component (client/peek.ts): what it shows, and how to show another. */
export interface Inspector {
  open(peek: Peek): void;
  on: Peek | undefined;
}
const PeekContext = createContext<Inspector | undefined>(undefined);
export const PeekHere = PeekContext.Provider;

export interface Show {
  /** A task; `list` is the list it was opened from, for previous and next in the inspector. */
  task(id: string, options?: { title?: string; list?: Sibling[] }): void;
  feature(id: string, title?: string): void;
  line(space: string, project: string): void;
  /** Whether the inspector shows this entry now (its row is marked); never off the space screen. */
  shows(peek: Peek): boolean;
}

/**
 * Opens tasks, features and lines from a component: in the inspector when it sits in the space
 * screen (the map stays), else as a screen opened from `own` or the `Here` around it.
 */
export function useShow(own?: ScreenLocation): Show {
  const inspector = useContext(PeekContext);
  const openScreen = useOpen(own);
  return useMemo<Show>(() => {
    if (!inspector) {
      return {
        task: (task) => openScreen("task", { task }),
        feature: (feature) => openScreen("feature", { feature }),
        line: (space, project) => openScreen("line", { space, project }),
        shows: () => false,
      };
    }
    const on = inspector.on ? peekKey(inspector.on) : "";
    return {
      task: (task, options = {}) => inspector.open({ kind: "task", task, title: options.title, list: options.list }),
      feature: (feature, title) => inspector.open({ kind: "feature", feature, title }),
      line: (space, project) => inspector.open({ kind: "line", space, project }),
      shows: (peek) => on !== "" && peekKey(peek) === on,
    };
  }, [inspector, openScreen]);
}

/** The inspector around a component, for what `Show` does not cover (a station of the map); none off the space screen. */
export function useInspector(): Inspector | undefined {
  return useContext(PeekContext);
}
