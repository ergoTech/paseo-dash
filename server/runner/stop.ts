import { homedir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, systemCommand } from "../tracker/forge.ts";

/**
 * Stopping an agent's turn (D23: a release, cancel or done stops the run's agent; its chat stays).
 * The plugin SDK of Paseo 0.13 has no call for it (an agent handle can archive, detach or send, not
 * interrupt), so this runs the Paseo CLI's `paseo agent stop <id>`: it interrupts a running agent
 * and does nothing to an idle one. The CLI is looked for on PATH, then where the Paseo app installs it.
 */

export interface StopResult {
  ok: boolean;
  /** Why it could not be stopped, as a person reads it; empty when it was. */
  error: string;
}

export type AgentStopper = (agentId: string) => Promise<StopResult>;

const TIMEOUT_MS = 10_000;

export function cliCandidates(home = homedir()): string[] {
  return [process.env.PASEO_CLI ?? "", "paseo", join(home, ".local", "bin", "paseo"), "/Applications/Paseo.app/Contents/Resources/bin/paseo"].filter(Boolean);
}

export function cliStopper(run: CommandRunner = systemCommand, candidates = cliCandidates()): AgentStopper {
  return async (agentId) => {
    const args = ["agent", "stop", agentId, "--json", ...(process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : [])];
    let missing = "";
    for (const command of candidates) {
      const answer = await run(command, args, homedir(), TIMEOUT_MS);
      if (answer.code === 0) return { ok: true, error: "" };
      const said = (answer.stderr ?? answer.stdout).trim();
      if (/ENOENT|command not found/.test(said)) {
        missing = command;
        continue;
      }
      return { ok: false, error: `paseo agent stop failed: ${said.split("\n")[0] || `exit ${answer.code}`}` };
    }
    return { ok: false, error: `the Paseo CLI was not found${missing ? ` (tried ${candidates.join(", ")})` : ""}; stop the agent in its chat` };
  };
}
