import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The Laconote import (05-architecture.md, Laconote import): action items of a meeting become inbox
 * drafts. Only the dashboard's screens offer it; it is not described to God Mode, where ChatGPT reads
 * Laconote through its own connector and calls add_to_inbox. The API key goes in through
 * `laconote.configure` and no answer ever carries it back.
 */

export const DEFAULT_API_URL = "https://meet.laconote.com";
export const DEFAULT_WEB_URL = "https://laconote.com";

/** Longest pasted export the preview reads. */
export const MAX_PASTE = 200_000;
/** Longest action item text a preview gives and an import accepts. */
export const ITEM_TEXT_MAX = 5_000;
/** Most action items one import takes; the sheet sends no more. */
export const IMPORT_MAX = 500;

const settingsOutput = z.object({
  api_url: z.string(),
  web_url: z.string(),
  /** Whether a key is stored; the key itself is never answered. */
  key_set: z.boolean(),
  error: z.string(),
});

export const laconoteSettingsRpc = defineRpc({ name: "laconote.settings", input: z.object({}), output: settingsOutput });

export const laconoteConfigureRpc = defineRpc({
  name: "laconote.configure",
  input: z.object({
    api_url: z.string().max(500).optional(),
    web_url: z.string().max(500).optional(),
    /** Checked by the handler, so a refusal never repeats what was typed. */
    key: z.string().max(2000).optional(),
    clear_key: z.boolean().default(false),
  }),
  output: settingsOutput.extend({ ok: z.boolean() }),
});

export const laconoteMeetingsRpc = defineRpc({
  name: "laconote.meetings",
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({
    meetings: z.array(z.object({ id: z.string(), title: z.string(), date: z.string(), has_summary: z.boolean() })),
    error: z.string(),
  }),
});

/** A meeting from the API by its id, or a pasted Markdown export; exactly one of them. */
const source = z.object({
  meeting: z.string().trim().min(1).max(200).optional(),
  text: z.string().max(MAX_PASTE).optional(),
});

export const laconotePreviewRpc = defineRpc({
  name: "laconote.preview",
  input: source,
  output: z.object({
    source: z.enum(["api", "paste", ""]),
    title: z.string(),
    date: z.string(),
    /** The meeting's web link for an API meeting; empty for a paste. */
    url: z.string(),
    topics: z.array(
      z.object({
        title: z.string(),
        decisions: z.array(z.string()),
        links: z.array(z.string()),
        items: z.array(
          z.object({
            text: z.string(),
            owner: z.string(),
            deadline: z.string(),
            priority: z.string(),
            /** Already made a draft by an earlier import of this meeting on this machine. */
            imported: z.boolean(),
          }),
        ),
      }),
    ),
    error: z.string(),
  }),
});

export const laconoteImportRpc = defineRpc({
  name: "laconote.import",
  input: source.extend({
    space: z.string().trim().min(1).optional(),
    /** The chosen action items by their text, as the preview gave it. */
    items: z.array(z.string().min(1).max(ITEM_TEXT_MAX)).min(1).max(IMPORT_MAX),
  }),
  output: z.object({
    ok: z.boolean(),
    created: z.array(z.object({ id: z.string(), title: z.string() })),
    skipped: z.array(z.string()),
    error: z.string(),
  }),
});

/**
 * The release context (05-architecture.md, Release context): the open milestones of a space's projects
 * go to the Laconote projects they are mapped to on this machine, so delivery meetings show the release,
 * its due date and the days left. Settings only; not described to God Mode.
 */

/** The Laconote projects the key's owner belongs to, to map a space's projects to. */
export const laconoteProjectsRpc = defineRpc({
  name: "laconote.projects",
  input: z.object({}),
  output: z.object({
    projects: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })),
    error: z.string(),
  }),
});

const releaseLine = z.object({ id: z.string(), name: z.string(), due: z.string(), progress: z.number().nullable() });

export const laconoteReleasesReadRpc = defineRpc({
  name: "laconote.releases.read",
  input: z.object({ space: z.string().trim().min(1) }),
  output: z.object({
    key_set: z.boolean(),
    /** Every project of the space, with the Laconote project it is mapped to here ("" when none). */
    mapping: z.array(z.object({ project: z.string(), laconote: z.string() })),
    /** One per Laconote project the space's projects are mapped to. */
    sets: z.array(
      z.object({
        laconote: z.string(),
        projects: z.array(z.string()),
        releases: z.array(releaseLine),
        /** Open milestones with no due date: Laconote needs one, so they are not sent. */
        undated: z.array(z.object({ id: z.string(), title: z.string() })),
        /** When Laconote last accepted the set; "" when never. */
        sent_at: z.string(),
        /** The set as it is now has not been accepted yet. */
        waiting: z.boolean(),
        error: z.string(),
      }),
    ),
    error: z.string(),
  }),
});

/** Maps one project of a space to a Laconote project on this machine, or unmaps it (`laconote` ""). */
export const laconoteReleasesSetRpc = defineRpc({
  name: "laconote.releases.set",
  input: z.object({
    space: z.string().trim().min(1),
    project: z.string().trim().min(1).max(100),
    laconote: z.string().trim().max(100),
  }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});
