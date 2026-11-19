import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonFile } from "./json-file.ts";

/**
 * One writer per daemon home (05-architecture.md, Lifecycle of the server part). The owner rewrites
 * a heartbeat while it runs; a lock whose process is gone or whose heartbeat is old is stale and is
 * taken over. The heartbeat also covers a PID reused by another process, which macOS cannot rule out
 * any other way (no /proc boot identity).
 */
export interface LockOptions {
  heartbeatMs: number;
  staleMs: number;
  now?: () => number;
  /** Whether a process exists; injectable for tests. */
  alive?: (pid: number) => boolean;
  /** Told of a heartbeat that could not be written. */
  log?: (message: string) => void;
}

interface LockFile {
  pid: number;
  token: string;
  heartbeat: number;
}

/** A takeover takes milliseconds; a guard older than this was left by a crash. */
const GUARD_STALE_MS = 10_000;

export type LockResult = { owner: true } | { owner: false; reason: string };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class OwnerLock {
  private readonly token = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly path: string;
  private readonly options: LockOptions;
  private owned = false;

  constructor(path: string, options: LockOptions) {
    this.path = path;
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private read(): LockFile | undefined {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  }

  private stale(lock: LockFile): boolean {
    const alive = (this.options.alive ?? processAlive)(lock.pid);
    return !alive || this.now() - lock.heartbeat > this.options.staleMs;
  }

  acquire(): LockResult {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.create()) return this.own();
    const current = this.read();
    if (current?.token === this.token) return this.own();
    if (current && !this.stale(current)) return this.busy(current);
    // Taking over a stale (or unreadable, so a torn write never locks everyone out) lock: only the
    // holder of the takeover guard may move it aside, so two takers never move each other's fresh lock.
    if (!this.guard()) return { owner: false, reason: "another copy of Paseo Dash is taking this daemon's data at the same moment" };
    try {
      const again = this.read();
      if (again && again.token !== this.token && !this.stale(again)) return this.busy(again);
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.stale-${randomUUID()}`);
      if (!this.create()) return { owner: false, reason: "another copy of Paseo Dash took this daemon's data at the same moment" };
      return this.own();
    } finally {
      rmSync(this.guardPath, { force: true });
    }
  }

  private get guardPath(): string {
    return `${this.path}.takeover`;
  }

  /** An exclusive takeover guard; one left by a taker that crashed is broken after GUARD_STALE_MS. */
  private guard(): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        closeSync(openSync(this.guardPath, "wx", 0o600));
        return true;
      } catch {
        const stat = statSync(this.guardPath, { throwIfNoEntry: false });
        if (!stat || this.now() - stat.mtimeMs <= GUARD_STALE_MS) return false;
        rmSync(this.guardPath, { force: true });
      }
    }
    return false;
  }

  /**
   * Written in full first, then linked into place: nobody ever reads a half-written lock. A file
   * system without hard links falls back to an exclusive create.
   */
  private create(): boolean {
    const content = JSON.stringify({ pid: process.pid, token: this.token, heartbeat: this.now() } satisfies LockFile);
    const temp = `${this.path}.new-${this.token}`;
    try {
      const fd = openSync(temp, "w", 0o600);
      writeSync(fd, content);
      closeSync(fd);
      linkSync(temp, this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      try {
        const fd = openSync(this.path, "wx", 0o600);
        writeSync(fd, content);
        closeSync(fd);
        return true;
      } catch {
        return false;
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private own(): LockResult {
    this.owned = true;
    this.stopTimer();
    this.timer = setInterval(() => this.beat(), this.options.heartbeatMs);
    this.timer.unref?.();
    return { owner: true };
  }

  private busy(lock: LockFile): LockResult {
    return { owner: false, reason: `another copy of Paseo Dash (process ${lock.pid}) owns this daemon's data` };
  }

  /**
   * Rewrites the heartbeat while the lock is still ours; stops when someone took it over. It runs on
   * a timer, where a throw ends the plugin's process and Paseo does not start it again: a heartbeat
   * that cannot be written (a full disk) is reported and the next beat tries again. A lock left
   * unwritten past `staleMs` may be taken over meanwhile, and the next beat sees that.
   */
  beat(): boolean {
    const current = this.read();
    if (!this.owned || current?.token !== this.token) {
      this.owned = false;
      this.stopTimer();
      return false;
    }
    try {
      writeJsonFile(this.path, { pid: process.pid, token: this.token, heartbeat: this.now() } satisfies LockFile);
    } catch (error) {
      this.options.log?.(`the owner lock's heartbeat was not written: ${(error as Error).message}`);
    }
    return true;
  }

  get isOwner(): boolean {
    return this.owned;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  release(): void {
    this.stopTimer();
    if (this.owned && this.read()?.token === this.token && existsSync(this.path)) unlinkSync(this.path);
    this.owned = false;
  }
}
