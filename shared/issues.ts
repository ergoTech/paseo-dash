import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Forge issues (docs/design/task-manager-v1/09-forge-issues.md, phases F2, F3 and F5): a task's `issue`
 * is the web URL of one GitHub or GitLab issue. The forge closes it when the task's PR/MR merges with
 * a closing keyword. The dashboard writes to the forge only through the issue mirror, on the one
 * machine where a space's switch is on, and only to issues the mirror made. Importing issues into the
 * inbox and the mirror's switch are offered by the dashboard's screens only; God Mode passes `issue`
 * through add_to_inbox and create_task instead.
 */

export type IssueForge = "github" | "gitlab";

export interface IssueRef {
  forge: IssueForge;
  /** The web host, lower case: `github.com`, `gitlab.example.com`. */
  host: string;
  /** The repository's path as written: `ergoTech/paseo-dash`, `frontend/site`. */
  repo: string;
  number: number;
  /** The URL in one form per forge, without query or fragment. */
  url: string;
}

/** Longest issue URL a task takes. */
export const ISSUE_URL_MAX = 500;

/**
 * An issue's web URL: `https://github.com/<owner>/<repo>/issues/<n>`, or on GitLab (any host)
 * `https://<host>/<group>/…/<project>/-/issues/<n>` (also `/-/work_items/<n>`). Anything else is not
 * an issue link.
 */
export function parseIssueUrl(text: string | undefined): IssueRef | undefined {
  if (!text || text.length > ISSUE_URL_MAX) return undefined;
  const match = /^https?:\/\/([a-z0-9.-]+(?::\d+)?)\/([^?#\s]+?)\/?(?:[?#][^\s]*)?$/i.exec(text.trim());
  if (!match) return undefined;
  const host = match[1]!.toLowerCase();
  const path = match[2]!;
  const gitlab = /^((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:issues|work_items)\/(\d{1,9})$/.exec(path);
  if (gitlab && host !== "github.com") {
    const number = Number(gitlab[2]);
    return number > 0 ? { forge: "gitlab", host, repo: gitlab[1]!, number, url: `https://${host}/${gitlab[1]}/-/issues/${number}` } : undefined;
  }
  const github = /^([\w.-]+\/[\w.-]+)\/issues\/(\d{1,9})$/.exec(path);
  if (github && host === "github.com") {
    const number = Number(github[2]);
    return number > 0 ? { forge: "github", host, repo: github[1]!, number, url: `https://${host}/${github[1]}/issues/${number}` } : undefined;
  }
  return undefined;
}

/** What identifies an issue across spellings of its URL: host, path without case, and number. */
export function issueKey(text: string | undefined): string | undefined {
  const ref = parseIssueUrl(text);
  return ref ? `${ref.host}/${ref.repo.toLowerCase()}#${ref.number}` : undefined;
}

/** How a person names an issue: `ergoTech/paseo-dash#12`, `frontend/site#3`. */
export function issueLabel(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

export const ISSUE_RULE = "an issue's web URL, https://github.com/<owner>/<repo>/issues/<n> or https://<gitlab host>/<group>/<project>/-/issues/<n>";

/** Most issues one listing shows; the forge's first page of open issues, newest first. */
export const ISSUES_LIST_MAX = 100;
/** Most issues one import takes. */
export const ISSUES_IMPORT_MAX = 50;

const space = z.string().trim().min(1).describe("Space key");
const project = z.string().trim().min(1).describe("Project key from space.yaml");
const filter = {
  label: z.string().trim().max(100).optional().describe("Only issues with this forge label"),
  milestone: z.string().trim().max(200).optional().describe("Only issues in this forge milestone (its title)"),
};

/** The open issues of a project's repository, as the import sheet lists them. */
export const issuesListRpc = defineRpc({
  name: "issues.list",
  input: z.object({ space, project, ...filter }),
  output: z.object({
    /** `github`, `gitlab`, or empty when the project could not be read. */
    forge: z.string(),
    /** The repository the list came from, as a person names it: `github.com/acme/core`. */
    repository: z.string(),
    issues: z.array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        labels: z.array(z.string()),
        milestone: z.string(),
        /** The task that already carries this issue (any status), or empty. */
        imported_as: z.string(),
      }),
    ),
    /** True when the forge had more open issues than the list shows. */
    more: z.boolean(),
    error: z.string(),
  }),
});

/**
 * Makes inbox drafts of the chosen issues. The server reads them from the forge again (the screen's
 * copy is not trusted), so a forge that cannot be reached means nothing is written.
 */
export const issuesImportRpc = defineRpc({
  name: "issues.import",
  input: z.object({
    space,
    project,
    ...filter,
    numbers: z.array(z.number().int().positive()).min(1).max(ISSUES_IMPORT_MAX),
  }),
  output: z.object({
    ok: z.boolean(),
    created: z.array(z.object({ id: z.string(), title: z.string() })),
    /** Issues not imported because a task already carries them (`id`), or that the forge did not list. */
    skipped: z.array(z.object({ title: z.string(), id: z.string(), reason: z.string() })),
    error: z.string(),
  }),
});

/**
 * The issue mirror of one space on this machine (09-forge-issues.md, the mirror). With `visibility`,
 * each project's repository is asked whether it is public, which reads the forge.
 */
export const issuesMirrorReadRpc = defineRpc({
  name: "issues.mirror.read",
  input: z.object({ space, visibility: z.boolean().optional() }),
  output: z.object({
    on: z.boolean(),
    /** Issues the mirror keeps equal to their task. */
    mirrored: z.number().int(),
    /** Tasks whose issue is not made or not up to date yet. */
    waiting: z.number().int(),
    problems: z.array(z.object({ task: z.string(), error: z.string() })),
    /** Forge hosts that asked to slow down, with until when. */
    paused: z.array(z.string()),
    /**
     * Repositories (`host/repo`) this machine's forge login may not write to: the mirror makes no
     * issue there, since anyone may open one in a public repository and the briefs would be public in
     * someone else's repository.
     */
    read_only: z.array(z.string()),
    /** Only with `visibility`: `public`, `private`, `internal`, or `unknown` with the reason in `note`. */
    repositories: z.array(
      z.object({
        project: z.string(),
        repository: z.string(),
        visibility: z.string(),
        note: z.string(),
        /** This machine's forge login may push there; false also when that could not be read. The mirror writes only where it may. */
        write: z.boolean(),
      }),
    ),
    error: z.string(),
  }),
});

/**
 * Turns the mirror of a space on or off on this machine. Turning it on needs `confirmed`: briefs
 * become issue text, public in a public repository, and only one machine should have it on.
 */
export const issuesMirrorSetRpc = defineRpc({
  name: "issues.mirror.set",
  input: z.object({ space, on: z.boolean(), confirmed: z.boolean().optional() }),
  output: z.object({ ok: z.boolean(), on: z.boolean(), error: z.string() }),
});
