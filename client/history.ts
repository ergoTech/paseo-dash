/**
 * Where "‹ Back" leads on the dashboard's screens. Paseo 0.13 gives plugin screens no back
 * navigation, so the dashboard keeps its own: a stack of the screens a person went through by
 * tapping inside the dashboard. Pure, so the cases are tested (server/history.test.ts).
 *
 * - A screen opened from a dashboard screen pushes the screen it was opened from (its own location,
 *   with its tab and filters), never a global "current" screen: a screen the host kept mounted and
 *   shows again (a phone's own back swipe) still pushes itself correctly.
 * - Pushing a location the stack already holds drops everything above it: those steps were left by
 *   other means, so the stack never repeats a place.
 * - A screen that arrives other than through the dashboard (sidebar, Command Center, a composer
 *   pill, a link) starts a fresh stack: earlier steps no longer lead there.
 * - One-shot params (open a form, ask to mark done, show a notice, highlight a project) are not
 *   kept: going back never repeats the action they asked for.
 * - "‹ Back" on a screen never leads to that screen itself. Paseo's own back (the header arrow on a
 *   phone, Close on desktop) pops its stack and reveals the screen below without telling the plugin,
 *   so the top of this stack can be the screen on view; such entries are skipped.
 *
 * Paseo shows plugin screens in a stack it pushes on every `openScreen`, and plugins cannot pop it:
 * "‹ Back" opens the previous screen anew, so the host's own back then walks through those copies.
 */

export type ScreenId = "space" | "line" | "feature" | "task";
export type Params = Record<string, string>;

export interface ScreenLocation {
  screenId: ScreenId;
  params: Params;
  /** What "‹ Back" says: the task's or feature's title, the line's key, the space's tab. */
  title: string;
}

/** Params that ask for something once; a screen reached by "‹ Back" must not ask again. */
export const ONE_SHOT = new Set(["new", "action", "ask", "notice", "add", "search"]);
export const MAX_DEPTH = 50;

export function keptParams(params: Params): Params {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([key, value]) => !ONE_SHOT.has(key) && value !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function sameLocation(a: Pick<ScreenLocation, "screenId" | "params">, b: Pick<ScreenLocation, "screenId" | "params">): boolean {
  return a.screenId === b.screenId && JSON.stringify(keptParams(a.params)) === JSON.stringify(keptParams(b.params));
}

const clean = (location: ScreenLocation): ScreenLocation => ({ ...location, params: keptParams(location.params) });

export class ScreenHistory {
  private stack: ScreenLocation[] = [];
  /** Where the last dashboard navigation (forward or back) was going. */
  private pending: ScreenLocation | undefined;
  /** The screen that came into view last, to tell a repeated arrival from a new one. */
  private lastArrival: Pick<ScreenLocation, "screenId" | "params"> | undefined;
  private listeners = new Set<() => void>();
  private version = 0;

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The screen "‹ Back" on the screen at `own` returns to, if the stack has one. */
  previous(own?: Pick<ScreenLocation, "screenId" | "params">): ScreenLocation | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (!own || !sameLocation(this.stack[i]!, own)) return this.stack[i];
    }
    return undefined;
  }

  depth(): number {
    return this.stack.length;
  }

  /** Opening `to` from the screen at `from` (undefined: from outside a dashboard screen). */
  go(from: ScreenLocation | undefined, to: Pick<ScreenLocation, "screenId" | "params">): void {
    // From a panel, a timeline card or a pill: not a step on the dashboard's own way.
    if (!from) this.stack = [];
    else if (!sameLocation(from, to)) {
      const here = clean(from);
      const at = this.stack.findIndex((entry) => sameLocation(entry, here));
      if (at !== -1) this.stack.splice(at);
      this.stack.push(here);
      if (this.stack.length > MAX_DEPTH) this.stack.splice(0, this.stack.length - MAX_DEPTH);
    }
    this.pending = { ...to, params: keptParams(to.params), title: "" };
    this.changed();
  }

  /** "‹ Back" on the screen at `own`: the previous other screen, else `fallback` (its parent); undefined when neither. */
  back(own?: Pick<ScreenLocation, "screenId" | "params">, fallback?: ScreenLocation): ScreenLocation | undefined {
    while (own && this.stack.length && sameLocation(this.stack[this.stack.length - 1]!, own)) this.stack.pop();
    const target = this.stack.pop() ?? (fallback ? clean(fallback) : undefined);
    if (!target) return undefined;
    this.pending = target;
    this.changed();
    return target;
  }

  /**
   * A dashboard screen came into view with these params. The one the last navigation was going to
   * keeps the stack; any other arrived from outside and starts a fresh one. A repeated arrival of the
   * same screen (a re-render, a development double effect) changes nothing.
   */
  arrive(location: Pick<ScreenLocation, "screenId" | "params">): void {
    const expected = this.pending;
    const repeat = this.lastArrival !== undefined && sameLocation(this.lastArrival, location);
    this.pending = undefined;
    this.lastArrival = { screenId: location.screenId, params: keptParams(location.params) };
    if ((expected && sameLocation(expected, location)) || repeat) return;
    if (this.stack.length) {
      this.stack = [];
      this.changed();
    }
  }
}
