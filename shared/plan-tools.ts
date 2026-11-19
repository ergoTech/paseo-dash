import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * This machine's switch for the plan tools of any agent (server/agent-tools/plan.ts): when on, every
 * agent session opened in a repository that is a project of a connected space gets plan_find,
 * plan_task and plan_add_draft. Off unless turned on. Settings screen only: never described to God
 * Mode, so ChatGPT cannot turn it on.
 */
const settings = z.object({ enabled: z.boolean() });

export const planToolsSettingsRpc = defineRpc({
  name: "agents.plan_tools",
  input: z.object({}),
  output: settings.extend({ error: z.string() }),
});

export const planToolsSettingsSetRpc = defineRpc({
  name: "agents.plan_tools.set",
  input: settings,
  output: settings.extend({ ok: z.boolean(), error: z.string() }),
});
