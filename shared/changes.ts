import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A small token of what the dashboard's screens read: it differs whenever what they answer from in
 * the daemon's memory differs (server/changes.ts). A screen polls this and reads in full only when the token moved (client/changes.ts).
 * Not described to God Mode: it reads what it needs when it needs it.
 */
export const changesRpc = defineRpc({
  name: "dashboard.changes",
  input: z.object({}),
  output: z.object({ token: z.string() }),
});
