import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Finding and sharing plan repositories (docs/design/task-manager-v1/09-forge-issues.md, section 3
 * and phase F4). Every call goes through this machine's own `gh` and `glab` logins; the dashboard
 * stores no credential. None of these RPCs is described to God Mode (06-god-mode.md): sharing the
 * plan repository gives someone the power to write instructions for the inviter's agents.
 */

/** The GitHub topic and GitLab project topic every plan repository carries. */
export const PLAN_TOPIC = "paseo-dashboard-plan";

export type Forge = "github" | "gitlab";

/** A role offered when inviting someone; `value` is what `sharing.invite` takes. */
export interface Role {
  value: string;
  label: string;
  /** The role can push to the plan's default branch (and so write briefs for agents). */
  writes: boolean;
}

/** Roles of an organisation's GitHub repository, as GitHub names them (pull, triage, push). */
export const GITHUB_ORG_ROLES: Role[] = [
  { value: "write", label: "Write: plans and starts tasks", writes: true },
  { value: "triage", label: "Triage: reads the plan", writes: false },
  { value: "read", label: "Read: reads the plan", writes: false },
];

/** GitLab roles that can read a private repository; Developer pushes only where the branch allows it. */
export const GITLAB_ROLES: Role[] = [
  { value: "developer", label: "Developer: plans and starts tasks where the default branch accepts Developers", writes: true },
  { value: "maintainer", label: "Maintainer: plans, starts and invites others", writes: true },
  { value: "reporter", label: "Reporter: reads the plan", writes: false },
];

export const EMAIL_PATTERN = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

const space = z.string().trim().min(1).describe("Space key");

/** Plan repositories this machine's gh and glab logins can read and that are not connected yet. */
export const plansAvailableRpc = defineRpc({
  name: "plans.available",
  input: z.object({}),
  output: z.object({
    plans: z.array(
      z.object({
        forge: z.enum(["github", "gitlab"]),
        /** The forge's web host: github.com, or the GitLab instance. */
        host: z.string(),
        /** owner/name on GitHub, group/…/name on GitLab. */
        path: z.string(),
        description: z.string(),
        web_url: z.string(),
        /** The clone URL to connect, in the protocol this machine's CLI is set to. */
        remote: z.string(),
      }),
    ),
    /** Why a forge or host was not searched (a CLI missing or logged out); a short sentence each. */
    notes: z.array(z.string()),
  }),
});

const member = z.object({
  kind: z.enum(["member", "invitation"]),
  /** A login, or the email of an invitation sent by email. */
  who: z.string(),
  name: z.string(),
  role: z.string(),
  /** False for the repository's owner, whom the forge does not let anyone remove. */
  removable: z.boolean(),
});

/** Who has access to a space's plan repository, and what an invitation there can offer. */
export const sharingReadRpc = defineRpc({
  name: "sharing.read",
  input: z.object({ space }),
  output: z.object({
    ok: z.boolean(),
    error: z.string(),
    forge: z.enum(["github", "gitlab", ""]),
    /** owner/name or group/name, as the forge shows it. */
    repo: z.string(),
    host: z.string(),
    /** Roles to choose from; empty for a user-owned GitHub repository, whose collaborators all write. */
    roles: z.array(z.object({ value: z.string(), label: z.string(), writes: z.boolean() })),
    /** GitLab only: an email invites someone without an account. */
    by_email: z.boolean(),
    members: z.array(member),
  }),
});

/** Invites a person to a space's plan repository and adds them to its people. Outward: the screen asks first. */
export const sharingInviteRpc = defineRpc({
  name: "sharing.invite",
  input: z.object({
    space,
    who: z.string().trim().min(1).max(255).describe("GitHub login, GitLab username, or an email (GitLab only)"),
    role: z.string().trim().default("").describe("A role sharing.read offers; empty on a user-owned GitHub repository"),
    person_key: z.string().trim().max(32).default("").describe("The people key to add them under; empty: from the login"),
    person_name: z.string().trim().max(100).default(""),
    /** Set by the confirmation the screen shows; without it nothing is sent. */
    confirmed: z.boolean().default(false),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string(),
    /** `invited`: the person must accept an invitation; `added`: they have access now. */
    sent: z.enum(["invited", "added", ""]),
    /** The people key they are listed under; empty when listing them failed (see `warning`). */
    person: z.string(),
    warning: z.string(),
  }),
});

/** Takes a person's access to a space's plan repository away, or withdraws their invitation. */
export const sharingRemoveRpc = defineRpc({
  name: "sharing.remove",
  input: z.object({
    space,
    kind: z.enum(["member", "invitation"]),
    who: z.string().trim().min(1).max(255),
    confirmed: z.boolean().default(false),
  }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

/** Whether a space's plan repository is set up for every collaborator to push (05-architecture.md). */
export const spacesCheckRpc = defineRpc({
  name: "spaces.check",
  input: z.object({ space }),
  output: z.object({
    /** False when the forge could not be asked; `error` says why. */
    checked: z.boolean(),
    error: z.string(),
    problems: z.array(z.object({ problem: z.string(), fix: z.string() })),
  }),
});

function forgeName(forge: Forge): string {
  return forge === "github" ? "GitHub" : "GitLab";
}

/** What the invitation's confirmation says; the same sentence the tests read. */
export function inviteSentence(input: {
  forge: Forge;
  repo: string;
  who: string;
  role?: Role;
  person: string;
  /** `held`: that person holds this login or email already; `extended`: the entry exists and gets it. */
  listed?: "held" | "extended";
}): string {
  const cli = input.forge === "github" ? "gh" : "glab";
  const email = EMAIL_PATTERN.test(input.who);
  const as = input.role ? ` as ${input.role.label.split(":")[0]}` : " as a collaborator";
  const writes = input.role ? input.role.writes : true;
  const what = writes
    ? "They will be able to push to the plan: briefs they write become the first prompts of agents started here."
    : "They will be able to read the plan, not change it.";
  const accept = input.forge === "github" ? "GitHub sends them an invitation to accept, unless they reach the repository already." : email ? "GitLab emails them an invitation." : "GitLab gives them access at once.";
  const listed = !input.person
    ? ""
    : input.listed === "held"
      ? ` They are in People as ${input.person} already.`
      : input.listed === "extended"
        ? ` People's ${input.person} gets this ${email ? "email" : "login"}.`
        : ` They are added to People as ${input.person}.`;
  return `Invite ${input.who} to ${input.repo} on ${forgeName(input.forge)}${as}, with your own ${cli} login? ${accept} ${what}${listed}`;
}

/** What the removal's confirmation says. */
export function removeSentence(input: { forge: Forge; repo: string; who: string; kind: "member" | "invitation" }): string {
  if (input.kind === "invitation") return `Withdraw the invitation of ${input.who} to ${input.repo} on ${forgeName(input.forge)}?`;
  return `Remove ${input.who}'s access to ${input.repo} on ${forgeName(input.forge)}? They can no longer fetch or push the plan; their tasks and their People entry stay.`;
}

/** A people key suggested from a login or an email: lower case, the allowed characters only. */
export function suggestPersonKey(who: string): string {
  const base = who.trim().split("@")[0]!.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "");
  return base.slice(0, 32);
}
