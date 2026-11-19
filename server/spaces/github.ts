import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { PLAN_TOPIC } from "../../shared/sharing.ts";

/**
 * Creating the plan repository on GitHub with `gh`, for a dashboard that starts from nothing
 * (02-product.md, D18: one personal plan repository). Arguments are arrays, never a shell; a missing
 * or logged-out `gh` fails with its own words.
 */

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Shell = (command: string, args: string[], timeoutMs: number) => Promise<ShellResult>;

export const systemShell: Shell = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: homedir(), timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = failure?.code === "ENOENT" ? `${command} is not installed or not on the daemon's PATH` : "";
        resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0, stdout: String(stdout), stderr: missing || String(stderr) });
      },
    );
  });

/** `owner/name` or just `name` (then the logged-in account owns it). */
export const GITHUB_REPO = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/)?[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

const GH_MS = 20_000;

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

/** Whether this machine's git talks to GitHub over SSH, as `gh` is set to. */
export async function githubUsesSsh(shell: Shell = systemShell): Promise<boolean> {
  const protocol = await shell("gh", ["config", "get", "git_protocol", "-h", "github.com"], GH_MS);
  return protocol.code === 0 && protocol.stdout.trim() === "ssh";
}

/**
 * Creates a private repository with the plan topic, so the dashboards of people invited to it list
 * it (shared/sharing.ts), and returns the clone URL this machine's git uses for GitHub: SSH when
 * `gh` is set to the ssh protocol, else HTTPS. A topic that could not be set does not undo the
 * repository; `warning` says so.
 */
export async function createGithubRepo(repo: string, shell: Shell = systemShell): Promise<{ remote: string; warning: string }> {
  if (!GITHUB_REPO.test(repo)) throw new Error(`${JSON.stringify(repo)} is not a GitHub repository name like owner/plan`);
  const created = await shell("gh", ["repo", "create", repo, "--private", "--description", "Plan of Paseo Dash"], GH_MS);
  if (created.code !== 0) throw new Error(`gh repo create failed: ${lastLine(created.stderr) || "no reason given"}`);
  const viewed = await shell("gh", ["repo", "view", repo, "--json", "nameWithOwner,sshUrl,url"], GH_MS);
  let urls: { nameWithOwner?: string; sshUrl?: string; url?: string } = {};
  try {
    urls = JSON.parse(viewed.stdout) as typeof urls;
  } catch {
    // Reported below.
  }
  if (viewed.code !== 0 || !urls.url) throw new Error(`the repository was created, but gh could not read its URL: ${lastLine(viewed.stderr)}`);
  const full = urls.nameWithOwner && GITHUB_REPO.test(urls.nameWithOwner) ? urls.nameWithOwner : repo;
  const topic = await shell("gh", ["repo", "edit", full, "--add-topic", PLAN_TOPIC], GH_MS);
  const warning =
    topic.code === 0
      ? ""
      : `${full} was created without the topic ${PLAN_TOPIC}, so Paseo Dash does not list it for people you invite (${lastLine(topic.stderr) || "no reason given"}); add it with gh repo edit ${full} --add-topic ${PLAN_TOPIC}`;
  const remote = (await githubUsesSsh(shell)) && urls.sshUrl ? urls.sshUrl : `${urls.url.replace(/\/+$/, "")}.git`;
  return { remote, warning };
}
