import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A space's projects, the lines of its map (docs/design/task-manager-v1/03-model.md, `space.yaml`):
 * listing them with this machine's Paseo projects, adding one from Paseo or by URL, ordering,
 * coloring, grouping, removing, mapping one to a local Paseo project by hand, and cloning one this
 * machine lacks. These are the dashboard screens' actions; God Mode is not offered them.
 */

/**
 * Line colors, in the order new projects get them. Mid-tone hues, so a 5 px line and a white-on-color
 * badge stay visible on both light and dark themes; the status of a station never relies on them.
 */
export const LINE_COLORS = [
  "#3e8eed",
  "#e5484d",
  "#30a46c",
  "#f76b15",
  "#8e4ec6",
  "#12a594",
  "#d6409f",
  "#ad7f58",
  "#5b5bd6",
  "#7c8a20",
] as const;

/**
 * Each project's line color, in space.yaml order: its own, else the next palette color no project
 * names, so a default never repeats a color someone chose. Defaults still follow the order; the
 * Projects tab writes them into space.yaml before it adds, moves, recolors or removes a line, so
 * they stop shifting.
 */
export function lineColors(projects: [key: string, color: string | undefined][]): Map<string, string> {
  const named = new Set(projects.map(([, color]) => color?.toLowerCase()).filter(Boolean));
  const free = LINE_COLORS.filter((color) => !named.has(color));
  const pool = free.length ? free : [...LINE_COLORS];
  let next = 0;
  return new Map(projects.map(([key, color]) => [key, color?.toLowerCase() ?? pool[next++ % pool.length]!]));
}

/** The first palette color no listed project uses yet; the least used one once all are taken. */
export function nextLineColor(used: string[]): string {
  const counts = new Map<string, number>(LINE_COLORS.map((c) => [c, 0]));
  for (const color of used) {
    const key = color.toLowerCase();
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  let best: string = LINE_COLORS[0];
  for (const color of LINE_COLORS) if (counts.get(color)! < counts.get(best)!) best = color;
  return best;
}

/** The repository name of a clone URL: `git@host:acme/core.git` → `core`. */
export function repoNameOf(remote: string): string {
  return remote.trim().replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() ?? "";
}

/** A key for a repository: its name in lower case with other characters as `-`, unique among `taken`. */
export function suggestKey(remote: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = repoNameOf(remote)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  if (!base) base = "project";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const space = z.string().trim().min(1).describe("Space key");
const project = z.string().trim().min(1).describe("Project key from space.yaml");
const answer = z.object({ ok: z.boolean(), error: z.string() });

export const projectsListRpc = defineRpc({
  name: "projects.list",
  input: z.object({ space }),
  output: z.object({
    projects: z.array(
      z.object({
        key: z.string(),
        remote: z.string(),
        trunk: z.string(),
        /** The color the map draws: space.yaml's, else the default for its place. */
        color: z.string(),
        /** True when space.yaml names the color. */
        color_set: z.boolean(),
        group: z.string(),
        /** space.yaml's `web_host`: the forge's web host when the remote's host differs, or empty. */
        web_host: z.string(),
        /** The Paseo project on this machine it maps to, or null. */
        local: z.object({ project_id: z.string(), name: z.string(), root: z.string() }).nullable(),
        /** True when the mapping was chosen by hand on this machine. */
        override: z.boolean(),
        open_tasks: z.number().int(),
        /** Other connected spaces that list the same repository: each has its own tasks for it. */
        shared_with: z.array(z.string()),
      }),
    ),
    /** This machine's git projects in Paseo with an origin remote, not listed in the space yet. */
    candidates: z.array(
      z.object({ project_id: z.string(), name: z.string(), root: z.string(), remote: z.string(), trunk: z.string(), key: z.string() }),
    ),
    /** Git projects in Paseo not offered above because they have no usable origin remote, nor mapped by hand. */
    no_remote: z.array(z.object({ name: z.string(), root: z.string() })),
    /** Every Paseo project on this machine, for mapping by hand. */
    local: z.array(z.object({ project_id: z.string(), name: z.string(), root: z.string() })),
    /** Where a clone goes by default: the directory most Paseo projects live in, or empty. */
    clone_parent: z.string(),
    groups: z.array(z.string()),
    error: z.string(),
  }),
});

export const projectsAddRpc = defineRpc({
  name: "projects.add",
  input: z.object({
    space,
    key: z.string().trim().min(1).describe("New project key: lower-case letters, digits, - and _"),
    remote: z.string().trim().min(1).describe("Clone URL of the project's repository"),
    trunk: z.string().trim().optional().describe("Base branch for task branches; empty: read from the remote"),
    color: z.string().trim().optional().describe("Line color #rrggbb; empty: the next free one"),
    group: z.string().trim().optional().describe("Umbrella the project belongs to"),
  }),
  output: answer.extend({ key: z.string() }),
});

export const projectsUpdateRpc = defineRpc({
  name: "projects.update",
  input: z.object({
    space,
    project,
    color: z.string().trim().optional().describe("Line color #rrggbb; empty: back to the default"),
    group: z.string().trim().optional().describe("Umbrella; empty: none"),
    trunk: z.string().trim().optional().describe("Base branch; empty: the repository's default"),
    web_host: z.string().trim().max(260).optional().describe("The forge's web host when it differs from the remote's (git-ssh.example.com → git.example.com); empty: the remote's"),
  }),
  output: answer,
});

export const projectsMoveRpc = defineRpc({
  name: "projects.move",
  input: z.object({ space, project, offset: z.union([z.literal(-1), z.literal(1)]).describe("-1 moves the line up, 1 down") }),
  output: answer,
});

export const projectsRemoveRpc = defineRpc({
  name: "projects.remove",
  input: z.object({ space, project }),
  output: answer,
});

export const projectsMapRpc = defineRpc({
  name: "projects.map",
  input: z.object({
    space,
    project,
    local_project: z.string().trim().describe("Paseo project id on this machine; empty: match by remote again"),
  }),
  output: answer,
});

export const projectsCloneRpc = defineRpc({
  name: "projects.clone",
  input: z.object({ space, project, directory: z.string().trim().min(1).describe("Absolute path of the new checkout; must not exist") }),
  /** `done` is false while the clone goes on in the background (Paseo stops waiting at 30 s). */
  output: answer.extend({ done: z.boolean(), directory: z.string() }),
});
