import type { RunRecord } from "./runs.ts";

/**
 * The mode and effort a run's agent runs with, as a person reads it on the task screen: what the start
 * passed to `agents.create`, then what Paseo reports of the agent where that differs (a person changed
 * it in the chat, or the provider did not take it). Nothing is filled in: a value no one reported is not said.
 */
export function runSettingsText(run: Pick<RunRecord, "asked" | "reported">): string {
  const { asked, reported } = run;
  const differs = (want: string | undefined, got: string | undefined) => Boolean(got) && got !== want;
  const now = [
    reported?.modeId && differs(asked?.modeId, reported.modeId) ? `mode ${reported.modeId}` : "",
    reported?.effortId && differs(asked?.effortId, reported.effortId) ? `effort ${reported.effortId}` : "",
  ].filter(Boolean);
  if (!asked) return reported ? `Paseo reports ${[reported.modeId ? `mode ${reported.modeId}` : "", reported.effortId ? `effort ${reported.effortId}` : ""].filter(Boolean).join(", ")}` : "";
  const started = `Started in ${asked.mode} · effort ${asked.effort}`;
  return now.length ? `${started}. Paseo now reports the agent in ${now.join(", ")}` : started;
}
