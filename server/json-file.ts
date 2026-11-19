import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

/**
 * Runtime state files: written atomically (unique temp file, fsync, rename) with owner-only
 * permissions; a file that fails validation is moved aside and reported, never silently reset.
 */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    // A failed write leaves nothing behind: the temp file may hold a secret.
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface ReadResult<T> {
  value: T;
  /** Set when the file existed but could not be used; it was moved to this path. */
  movedAside?: string;
}

export function readJsonFile<T>(path: string, schema: ZodType<T>, fallback: () => T): ReadResult<T> {
  if (!existsSync(path)) return { value: fallback() };
  try {
    return { value: schema.parse(JSON.parse(readFileSync(path, "utf8"))) };
  } catch {
    const aside = `${path}.broken-${Date.now()}`;
    renameSync(path, aside);
    return { value: fallback(), movedAside: aside };
  }
}
