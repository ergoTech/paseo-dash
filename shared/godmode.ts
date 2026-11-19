import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * This machine's choices for ChatGPT through God Mode (06-god-mode.md, Starting without asking):
 * `start_without_asking` lets ChatGPT start a todo task as soon as the user asks, without God Mode
 * reading the start back first. It decides only whether a start asks; the agent's permission mode
 * comes from its profile or provider either way. Settings screen only: never described to God Mode,
 * so ChatGPT cannot turn it on.
 */
const settings = z.object({ start_without_asking: z.boolean() });

export const godModeSettingsRpc = defineRpc({
  name: "godmode.settings",
  input: z.object({}),
  output: settings.extend({ error: z.string() }),
});

export const godModeSettingsSetRpc = defineRpc({
  name: "godmode.settings.set",
  input: settings,
  output: settings.extend({ ok: z.boolean(), error: z.string() }),
});
