import { parseIssueUrl } from "../../shared/issues.ts";
import type { SpaceProject } from "../../shared/model.ts";
import type { Plan } from "../plan/load.ts";
import { normalizeRemote } from "../spaces/mapping.ts";
import { type ForgeCli, forgeOf } from "./forge.ts";

/**
 * Whether a GitLab project's `web_host` (space.yaml) is the host its forge serves it on (03-model.md,
 * Projects). A remote cloned from one host (`git-ssh.example.com`) whose web pages, issues and MRs are
 * on another (`git.example.com`) needs `web_host`; without it issue links, closing references and
 * PR/MR checks compare the wrong host, and a task's issue reads as "on another forge".
 *
 * The answer is the forge's own: GitLab's API names the project's `web_url`. Hosts that merely look
 * alike are never taken as the same. Only the remote's host and the `web_host` the user set are asked:
 * plan links are untrusted text, and `glab api --hostname` sends the daemon's GitLab token to whatever
 * host it is given, so a host only the plan's links name is reported for the user to check, never asked.
 */

export interface WebHostVerdict {
  /** The host the remote names. */
  remoteHost: string;
  /** The web host the dashboard uses now: `web_host`, else the remote's host. */
  used: string;
  /** The host the forge's API names in the project's web URL; "" when no host answered. */
  served: string;
  /** Hosts the plan's links to this repository use other than `used` (issues, PR/MRs), most used first. */
  seen: string[];
  /** When this machine asked, ISO time; "" when it has not. */
  at: string;
}

/** What is wrong and the one action that fixes it; "" when nothing is. */
export function webHostProblem(project: string, verdict: WebHostVerdict): string {
  const { remoteHost, used, served, seen } = verdict;
  if (served && served !== used) {
    return `Project ${project}: its forge serves it at https://${served} (GitLab's web_url), but Paseo Dash uses ${used}. Set its web host to ${served} (Projects → ${project} → Web host, or projects.update web_host ${served}); issue links, closing references and PR/MR checks then match.`;
  }
  if (!served && seen.length) {
    return `Project ${project}: the plan links its issues or MRs on ${seen[0]}, while Paseo Dash uses ${used} (from its remote ${remoteHost}); the forge did not confirm either. Check that https://${seen[0]} serves the same repository (glab api --hostname ${seen[0]} projects/<path>), then set its web host to ${seen[0]} in Projects.`;
  }
  return "";
}

/** The hosts the plan's links to the project's repository name other than `used`, most used first. */
export function seenHosts(plan: Plan, key: string, project: SpaceProject): string[] {
  const normal = normalizeRemote(project.remote);
  const slash = normal.indexOf("/");
  if (slash <= 0) return [];
  const path = normal.slice(slash + 1).toLowerCase();
  const used = (project.web_host ?? normal.slice(0, slash)).toLowerCase();
  const counts = new Map<string, number>();
  const note = (url: string | undefined) => {
    if (!url) return;
    const issue = parseIssueUrl(url);
    const pr = /^https:\/\/([^/\s]+)\/(.+?)\/(?:-\/merge_requests|pull)\/\d+\/?$/.exec(url.trim());
    const host = issue?.host ?? pr?.[1]?.toLowerCase();
    const repo = (issue?.repo ?? pr?.[2] ?? "").toLowerCase();
    if (!host || repo !== path || host === used) return;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  };
  for (const loaded of plan.entities.values()) {
    const task = loaded.entity;
    if (task.type !== "task" || task.project !== key) continue;
    note(task.issue);
    note(task.run_pr);
    for (const link of task.links) note(link);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host);
}

export interface WebHostOptions {
  forge: ForgeCli;
  /** A directory the CLI runs in: the API call names the host and path, no checkout is needed. */
  cwd: () => string;
  now?: () => Date;
  log?: (message: string) => void;
}

/** A host's answer is kept this long; a screen or a read older than that asks again in the background. */
const FRESH_MS = 60 * 60_000;

/** The GitLab projects' web hosts as their forges answer them, per remote; read in the background, never written. */
export class WebHosts {
  private readonly options: WebHostOptions;
  /** By normalized remote: the host the forge named, "" when none answered, with when it was asked. */
  private readonly served = new Map<string, { host: string; at: number }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(options: WebHostOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? (() => new Date()))().getTime();
  }

  stop(): void {
    this.stopped = true;
  }

  /** What this machine knows of a project's web host now; an old or missing answer is asked for in the background. */
  peek(plan: Plan, key: string, project: SpaceProject): WebHostVerdict | undefined {
    if (forgeOf(project.remote) !== "gitlab") return undefined;
    const normal = normalizeRemote(project.remote);
    const slash = normal.indexOf("/");
    if (slash <= 0) return undefined;
    const remoteHost = normal.slice(0, slash);
    const seen = seenHosts(plan, key, project);
    const known = this.served.get(normal);
    if (!this.stopped && (!known || this.now() - known.at >= FRESH_MS)) void this.check(project);
    return { remoteHost, used: project.web_host ?? remoteHost, served: known?.host ?? "", seen, at: known ? new Date(known.at).toISOString() : "" };
  }

  /** Asks the forge now (the remote's host, then the `web_host` the user set); a check going on is shared. */
  check(project: SpaceProject): Promise<void> {
    const normal = normalizeRemote(project.remote);
    const running = this.inFlight.get(normal);
    if (running) return running;
    const read = this.read(normal, project)
      .catch((error: unknown) => this.options.log?.(`web host of ${normal}: ${(error as Error).message}`))
      .finally(() => this.inFlight.delete(normal));
    this.inFlight.set(normal, read);
    return read;
  }

  private async read(normal: string, project: SpaceProject): Promise<void> {
    const slash = normal.indexOf("/");
    const remoteHost = normal.slice(0, slash);
    const path = normal.slice(slash + 1);
    const asked = [...new Set([remoteHost, project.web_host].filter((h): h is string => Boolean(h)))];
    for (const host of asked) {
      if (this.stopped) return;
      const urls = await this.options.forge.projectUrls(this.options.cwd(), host, path);
      if (!urls) continue;
      const web = /^https?:\/\/([^/\s]+)\/(.+?)\/?$/.exec(urls.web);
      // The answer must be the same repository the remote names, by its clone URL or its path.
      const same = normalizeRemote(urls.ssh || urls.http) === normal || web?.[2]?.toLowerCase() === path.toLowerCase();
      if (!web || !same) continue;
      this.served.set(normal, { host: web[1]!.toLowerCase(), at: this.now() });
      return;
    }
    this.served.set(normal, { host: "", at: this.now() });
  }
}
