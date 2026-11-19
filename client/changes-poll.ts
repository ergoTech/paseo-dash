/**
 * The token poll behind `useChanges` (client/changes.ts), without React or React Native, so its
 * timing can be tested. One request at a time: the next one is scheduled after the answer and after
 * the reads it caused, so neither a slow daemon nor a burst of changes piles requests up.
 */

/**
 * The pause between an answer and the next request. A change waits at most this, then one token
 * answer and one read: below 3 s, while those two take under half a second together.
 */
export const POLL_PAUSE_MS = 2_500;

export interface ChangesPollOptions {
  read: () => Promise<{ token: string }>;
  /** The token moved; the next request waits until this settles. */
  changed: () => Promise<unknown>;
  visible: () => boolean;
  /** Calls back when `visible()` may have changed; returns the cleanup. */
  onVisibility: (listener: () => void) => () => void;
  pauseMs?: number;
}

export function pollChanges({ read, changed, visible, onVisibility, pauseMs = POLL_PAUSE_MS }: ChangesPollOptions): () => void {
  let stopped = false;
  let busy = false;
  let last: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const tick = async () => {
    cancel();
    if (stopped || busy || !visible()) return;
    busy = true;
    try {
      const { token } = await read();
      const moved = last !== undefined && token !== last;
      last = token;
      if (moved && !stopped) await changed();
    } catch {
      // The daemon is out of reach for now: the screens keep what they have, and the next pass asks again.
    } finally {
      busy = false;
    }
    // Hidden meanwhile: nothing is scheduled, and coming back asks at once.
    if (!stopped && visible()) timer = setTimeout(() => void tick(), pauseMs);
  };

  const off = onVisibility(() => {
    if (visible()) void tick();
    else cancel();
  });
  void tick();
  return () => {
    stopped = true;
    cancel();
    off();
  };
}

/** One poll per key however many surfaces use it: the first user starts it, the last one stops it. */
export function sharedPoll<K extends object>(polls: WeakMap<K, { users: number; stop: () => void }>, key: K, start: () => () => void): () => void {
  let poll = polls.get(key);
  if (!poll) {
    poll = { users: 0, stop: start() };
    polls.set(key, poll);
  }
  poll.users++;
  const held = poll;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.users === 0) {
      held.stop();
      polls.delete(key);
    }
  };
}
