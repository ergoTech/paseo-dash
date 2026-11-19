import type { SpaceEntry } from "../api/resolve.ts";
import { normalizeRemote } from "./mapping.ts";

/**
 * The other connected spaces that list the same repository as a line. A repository can be a line in
 * several plans: each keeps its own tasks for it, and nothing syncs between them; where this machine
 * maps those lines to the same Paseo project, its workspaces count under each line.
 */
export function alsoIn(spaces: Iterable<SpaceEntry>, own: string, remote: string): string[] {
  const wanted = normalizeRemote(remote);
  const keys: string[] = [];
  for (const entry of spaces) {
    if (entry.record.key === own) continue;
    const projects = Object.values(entry.sync.plan.space?.projects ?? {});
    if (projects.some((p) => p.remote && normalizeRemote(p.remote) === wanted)) keys.push(entry.record.key);
  }
  return keys;
}
