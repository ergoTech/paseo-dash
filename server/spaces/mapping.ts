/**
 * Matching a space's projects (keyed by remote URL in space.yaml) to this machine's Paseo projects.
 * Remote URLs are compared without scheme, user, port, `.git` and case of the host, so
 * `git@github.com:acme/core.git` and `https://github.com/acme/core` are the same project.
 */
export function normalizeRemote(url: string): string {
  let value = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(value);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else {
    value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
    value = value.replace(/^([^/:]+):\d+\//, "$1/");
  }
  value = value.replace(/\/+$/, "").replace(/\.git$/i, "");
  const slash = value.indexOf("/");
  return slash === -1 ? value.toLowerCase() : `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
}

export interface LocalProject {
  projectId: string;
  name: string;
  remote: string | undefined;
  /** The project's checkout on this machine, where the forge CLIs find its repository. */
  rootPath?: string;
  /** A git project in Paseo (it may still have no origin remote). */
  git?: boolean;
}

/**
 * For each project key of the space: the matching local project id, or null. A mapping chosen by
 * hand on this machine (a fork, a mirror, a checkout without the same remote) wins while that Paseo
 * project exists; otherwise the remote decides.
 */
export function mapProjects(
  projects: Record<string, { remote: string }>,
  local: LocalProject[],
  overrides: Record<string, string> = {},
): Record<string, string | null> {
  const byRemote = new Map<string, string>();
  const ids = new Set(local.map((project) => project.projectId));
  for (const project of local) {
    if (project.remote) byRemote.set(normalizeRemote(project.remote), project.projectId);
  }
  return Object.fromEntries(
    Object.entries(projects).map(([key, project]) => {
      const chosen = overrides[key];
      if (chosen && ids.has(chosen)) return [key, chosen];
      return [key, byRemote.get(normalizeRemote(project.remote)) ?? null];
    }),
  );
}

/**
 * A project remote the plugin may hand to git: a URL with a network or file scheme, or scp-like
 * `user@host:path`. Others (`ext::…`, a leading `-`, a bare local path) never reach `git`, because
 * space.yaml is written by every collaborator of the plan repository.
 */
export function usableRemote(url: string): boolean {
  return /^(?:https?|ssh|git|file):\/\/[^\s]+$/i.test(url) || /^\w[\w.-]*@[\w.-]+:[^\s-][^\s]*$/.test(url);
}
