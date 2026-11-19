import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Connected spaces (plan repositories) and their sync state, for the settings screen. */
export const spacesListRpc = defineRpc({
  name: "spaces.list",
  input: z.object({}),
  output: z.object({
    /** False when another installation of the dashboard owns this daemon's data. */
    owner: z.boolean(),
    reason: z.string(),
    /** Runtime files that could not be read and were moved aside; spaces may be missing. */
    warnings: z.array(z.string()),
    spaces: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        remote: z.string(),
        branch: z.string(),
        last_sync: z.string(),
        pending: z.number().int(),
        error: z.string(),
        conflicts: z.array(z.object({ id: z.string(), reason: z.string(), at: z.string() })),
        problems: z.array(z.object({ path: z.string(), reason: z.string() })),
        late_claims: z.number().int(),
        warnings: z.array(z.string()),
        tasks: z.number().int(),
        mapping: z.array(z.object({ project: z.string(), local: z.string() })),
      }),
    ),
  }),
});

export const spacesAddRpc = defineRpc({
  name: "spaces.add",
  input: z.object({
    remote: z.string().min(1).describe("Clone URL of the plan repository"),
    key: z.string().optional().describe("Id prefix (2-6 capital letters); needed only for a new repository (empty, or with only a README, LICENSE or .gitignore)"),
    name: z.string().optional().describe("Space name; needed only for a new repository (empty, or with only a README, LICENSE or .gitignore)"),
  }),
  output: z.object({ ok: z.boolean(), key: z.string(), error: z.string() }),
});

export const spacesSyncRpc = defineRpc({
  name: "spaces.sync",
  input: z.object({ space: z.string().optional() }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

/**
 * Disconnects a space from this machine: its local clone and journal are deleted, the plan repository
 * and its remote are not touched. Refused while the space has changes not pushed yet, a start being
 * decided or created, or a live run of this machine. Not described to God Mode (06-god-mode.md).
 */
export const spacesDisconnectRpc = defineRpc({
  name: "spaces.disconnect",
  input: z.object({ space: z.string().trim().min(1).describe("Key of the space to disconnect") }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

/**
 * Creates a private GitHub repository with `gh` and connects it as a new space: the dashboard's one
 * plan repository for all of a person's projects (D18). An outward action; the screen asks first.
 */
export const spacesCreateRpc = defineRpc({
  name: "spaces.create",
  input: z.object({
    repo: z.string().trim().min(1).describe("GitHub repository to create: owner/name, or name for the logged-in account"),
    key: z.string().trim().min(1).describe("Id prefix: 2-6 capital letters"),
    name: z.string().trim().min(1).describe("Space name"),
  }),
  output: z.object({ ok: z.boolean(), key: z.string(), error: z.string() }),
});
