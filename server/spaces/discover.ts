import type { RpcOutput } from "@getpaseo/plugin";
import { PLAN_TOPIC, type plansAvailableRpc } from "../../shared/sharing.ts";
import { githubUsesSsh, type Shell, systemShell } from "./github.ts";
import { normalizeRemote, usableRemote } from "./mapping.ts";

/**
 * Plan repositories this machine could connect (09-forge-issues.md, F4): the ones carrying the plan
 * topic that this machine's `gh` and `glab` logins can read and that no space here comes from yet.
 * A repository a person was invited to shows once they accepted the invitation on the forge. Only
 * GET calls; nothing is written anywhere.
 */

type Available = RpcOutput<typeof plansAvailableRpc>;
type Plan = Available["plans"][number];
/** A plan found, with every clone URL of its repository: a space here may come from any of them. */
interface Found {
  plan: Plan;
  urls: string[];
}

/**
 * GitHub and GitLab are asked side by side, and each host's list beside its protocol setting, so the
 * longest path is `glab auth status` then one list: within Paseo's 30-second limit.
 */
const STATUS_MS = 8_000;
const LIST_MS = 15_000;
const CONFIG_MS = 5_000;

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

/** One JSON value per line, as `gh api --jq` prints them; lines that are not JSON are skipped. */
function jsonLines(stdout: string): unknown[] {
  return stdout.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const topicsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : []);

async function github(shell: Shell): Promise<{ found: Found[]; note?: string }> {
  // Every repository the login owns, collaborates on or reaches through an organisation, kept by
  // gh's jq when it has the topic (and checked again below), so the answer stays small however many
  // repositories the login reaches; not GitHub's search, whose index lags behind a new topic.
  const [listed, ssh] = await Promise.all([
    shell(
      "gh",
      ["api", "--paginate", "user/repos?per_page=100&affiliation=owner,collaborator,organization_member", "--jq", `.[] | select((.topics // []) | index("${PLAN_TOPIC}")) | {full_name, ssh_url, clone_url, html_url, description, topics}`],
      LIST_MS,
    ),
    githubUsesSsh(shell),
  ]);
  if (listed.code !== 0) return { found: [], note: `GitHub not searched: ${lastLine(listed.stderr) || "gh stopped without a reason (it may have run out of time)"}` };
  const found = jsonLines(listed.stdout).flatMap((value): Found[] => {
    const repo = value as Record<string, unknown>;
    if (!topicsOf(repo.topics).includes(PLAN_TOPIC)) return [];
    const remote = ssh && text(repo.ssh_url) ? text(repo.ssh_url) : text(repo.clone_url);
    if (!text(repo.full_name) || !usableRemote(remote)) return [];
    return [
      {
        plan: { forge: "github", host: "github.com", path: text(repo.full_name), description: text(repo.description), web_url: text(repo.html_url), remote },
        urls: [text(repo.ssh_url), text(repo.clone_url)],
      },
    ];
  });
  return { found };
}

/** The GitLab hosts `glab` is logged in to; its exit code is not read, since one bad host fails it. */
function gitlabHosts(output: string): string[] {
  return [...new Set([...output.matchAll(/Logged in to ([A-Za-z0-9.-]+(?::\d+)?) as /g)].map((m) => m[1]!))];
}

async function gitlabHost(shell: Shell, host: string): Promise<{ found: Found[]; note?: string }> {
  const [listed, protocol] = await Promise.all([
    shell("glab", ["api", "--hostname", host, "--paginate", `projects?topic=${PLAN_TOPIC}&membership=true&simple=true&per_page=100`], LIST_MS),
    shell("glab", ["config", "get", "git_protocol", "--host", host], CONFIG_MS),
  ]);
  let projects: unknown;
  try {
    projects = JSON.parse(listed.stdout);
  } catch {
    // Reported below.
  }
  if (listed.code !== 0 || !Array.isArray(projects)) return { found: [], note: `${host} not searched: ${lastLine(listed.stderr) || "glab stopped without a reason (it may have run out of time)"}` };
  const https = protocol.code === 0 && protocol.stdout.trim() === "https";
  const found = projects.flatMap((value): Found[] => {
    const project = value as Record<string, unknown>;
    if (!topicsOf(project.topics).includes(PLAN_TOPIC)) return [];
    const remote = https || !text(project.ssh_url_to_repo) ? text(project.http_url_to_repo) : text(project.ssh_url_to_repo);
    const web = text(project.web_url);
    if (!text(project.path_with_namespace) || !usableRemote(remote)) return [];
    let webHost = host;
    try {
      webHost = new URL(web).host;
    } catch {
      // The login's host then.
    }
    return [
      {
        plan: { forge: "gitlab", host: webHost, path: text(project.path_with_namespace), description: text(project.description), web_url: web, remote },
        urls: [text(project.ssh_url_to_repo), text(project.http_url_to_repo)],
      },
    ];
  });
  return { found };
}

async function gitlab(shell: Shell): Promise<{ found: Found[]; notes: string[] }> {
  const status = await shell("glab", ["auth", "status"], STATUS_MS);
  if (/not installed or not on the daemon's PATH/.test(status.stderr)) return { found: [], notes: [`GitLab not searched: ${status.stderr}`] };
  const hosts = gitlabHosts(`${status.stdout}\n${status.stderr}`);
  if (!hosts.length) return { found: [], notes: [] };
  const each = await Promise.all(hosts.map((host) => gitlabHost(shell, host)));
  return { found: each.flatMap((f) => f.found), notes: each.flatMap((f) => (f.note ? [f.note] : [])) };
}

/**
 * The plan repositories with the topic that no connected space comes from. A GitLab instance
 * reached under two host names lists a project twice; it shows once, by its web URL.
 */
export async function availablePlans(connected: string[], shell: Shell = systemShell): Promise<Available> {
  // Forges name repositories case-insensitively; a space connected as acme/plan is Acme/Plan too.
  const same = (url: string) => normalizeRemote(url).toLowerCase();
  const taken = new Set(connected.map(same));
  const [hub, lab] = await Promise.all([github(shell), gitlab(shell)]);
  const seen = new Set<string>();
  const plans: Plan[] = [];
  for (const { plan, urls } of [...hub.found, ...lab.found]) {
    if (urls.some((url) => url && taken.has(same(url)))) continue;
    const id = (plan.web_url || normalizeRemote(plan.remote)).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    plans.push(plan);
  }
  return { plans, notes: [...(hub.note ? [hub.note] : []), ...lab.notes] };
}
