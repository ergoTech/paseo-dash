import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed at its deadline: whatever it was doing may or may not have happened. */
  timedOut: boolean;
}

export interface GitRunner {
  run(cwd: string, args: string[], timeoutMs: number): Promise<GitResult>;
}

/**
 * Git without prompts: a missing credential fails at once instead of hanging a plugin RPC
 * (07-plan.md, phase 1). Arguments are always an array; nothing goes through a shell.
 */
export const systemGit: GitRunner = {
  run(cwd, args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            // No askpass dialog for ssh either; the user's own ssh command and config stay in effect.
            SSH_ASKPASS_REQUIRE: "never",
            LC_ALL: "C",
          },
        },
        (error, stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({
            code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: Boolean(failure?.killed),
          });
        },
      );
    });
  },
};

/**
 * Push results, by what they say about whether the ref moved:
 * - `rejected`: origin moved first (non-fast-forward, or a concurrent update won the ref lock);
 *   nothing landed, replay and push again;
 * - `declined`: the remote refused the update (a hook, branch protection); nothing landed, and pushing
 *   again will not help;
 * - `unreachable`: failed before anything was sent;
 * - `unknown`: cut off or unexplained; only origin can tell (I5).
 */
export type PushResult = "accepted" | "rejected" | "declined" | "unreachable" | "unknown";

const REJECTED =
  /\[rejected\]|non-fast-forward|fetch first|\(stale info\)|\[remote rejected\][^\n]*\((failed to update ref|cannot lock ref|incorrect old value)/;
const DECLINED = /\[remote rejected\]|protected branch|pre-receive hook declined/i;
// Failures before the client sent anything: connection, authentication, a remote that is not there.
// Signs that the conversation with the remote got as far as sending: then nothing is certain.
const SENT = /^To |^remote:|hung up unexpectedly|unexpected disconnect/m;
const UNREACHABLE =
  /Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Permission denied|Authentication failed|Host key verification failed|could not read Username|Repository not found|does not appear to be a git repository|Could not read from remote repository/i;

export function classifyPush(result: GitResult): PushResult {
  if (result.timedOut) return "unknown";
  if (result.code === 0) return "accepted";
  if (REJECTED.test(result.stderr)) return "rejected";
  if (DECLINED.test(result.stderr)) return "declined";
  if (UNREACHABLE.test(result.stderr) && !SENT.test(result.stderr)) return "unreachable";
  return "unknown";
}

/**
 * A branch name read from a remote, safe to put into a refspec: never an option, no spaces or ref
 * syntax. `git check-ref-format --branch` is the authority when connecting; this guards every use.
 */
export const SAFE_BRANCH = /^(?![-/.])(?!.*\/[.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<![./])$/;

/** Plugin commits never prompt or run the user's hooks: no signing, no hook directory. */
export const COMMIT_CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

export async function git(runner: GitRunner, cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await runner.run(cwd, args, timeoutMs);
  if (result.code !== 0 || result.timedOut) {
    // The subcommand, past any leading `-c <setting>` and global options.
    const command = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ?? args[0];
    throw new Error(`git ${command} failed${result.timedOut ? " (timed out)" : ""}: ${result.stderr.trim().split("\n").pop() ?? ""}`);
  }
  return result.stdout;
}
