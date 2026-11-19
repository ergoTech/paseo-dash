# 09 · GitHub and GitLab issues as a task source

Research for the meeting of 2026-10-26, which discussed "GitHub as a task manager, with tags and
labels to categorise tasks", asked to "research integration with the GitLab API to get task data"
(high priority) and decided on "authorisation through Git". The document ends with a recommendation
and open questions; phases F1 (labels), F2 and F3 (issue link and import, options a and b), F4
(sharing) and F5 (the one-way issue mirror of option c) have since been built, each noted where it is
discussed.

The starting point does not change: the plan is Markdown in a git repository (D1, D18 in
[02-product.md](02-product.md#decisions-agreed-with-the-user)), and
[01-research.md](01-research.md#alternatives-considered) explains why GitHub Issues were not chosen
as the store. The dashboard already reads PR/MR state with `gh` and `glab`
(`server/tracker/forge.ts`). The repositories it was written against are partly on a self-hosted
GitLab Community Edition (`gitlab-ssh.example.com` here) and partly on GitHub.

Collected on 2026-10-27. Only read commands were run (`list`, `view`, `api` GET, `auth status`);
nothing was written to either forge. The command transcripts of that session named private hosts and
projects and are not part of this document; what they showed is summarised below.

## The short answer

- **Labels on tasks: yes**, as a free-text list on the task, with an optional palette in
  `space.yaml`. Needed whether or not issues are ever imported.
- **Link a task to an issue: yes.** One `issue` field. The forge closes the issue itself when the
  task's PR/MR merges into the default branch and its description carries a closing keyword; the
  dashboard only puts the keyword into the agent's brief and shows the issue's state.
- **Import issues into the inbox: yes, one way**, after the link exists, so that the link is the
  provenance and the duplicate check.
- **Two-way sync: no.** It breaks the operation journal's guarantees (I1, I2), turns every plan edit
  into a write to someone else's service, and needs a webhook endpoint a daemon behind NAT cannot have.
- **GitHub Projects (v2) as a view: no.** GitHub-only, written through GraphQL or the REST `projectsV2`
  endpoints, needs a token scope this machine does not have, and it cannot show the GitLab repositories that hold most of the work.
- **"Authorisation through Git" is what v1 already does**: whoever can push to the plan repository
  can plan and start. What is missing is a way to invite people from the dashboard, and on GitLab a
  plan repository needs its default branch opened for Developers.

## 1. What `gh` and `glab` give

### Installed and logged in

`gh` 2.83.1 and `glab` 1.90.0 were installed, each logged in.

- `glab auth status` exits with an error when any configured host fails (for example an unused
  `gitlab.com` entry), even while the host in use is logged in. A health check must read the host it
  needs, not the exit code.
- The self-hosted GitLab was Community Edition. Every Premium feature below (epics, scoped labels,
  weights) is absent there.
- The `gh` token had no `read:project` / `project` scope (see [Projects](#github-projects-v2)).

### The data in the repositories today

Issues were barely used: about a dozen GitLab projects held one issue in total, the GitHub
repositories a handful, none labelled, assigned or in a milestone, with only GitHub's nine default
labels. So the decision is about where tasks *will* be written, not about an existing backlog to
bring in.

### Capabilities

| | GitHub (`gh` 2.83.1, github.com) | GitLab (`glab` 1.90.0, CE self-hosted) |
| --- | --- | --- |
| List and filter | `gh issue list` with `--state`, `--label`, `--milestone`, `--assignee`, `--author`, `--search`; default limit 30 (`gh issue list --help`) | `glab issue list` with `--all/--closed`, `--label`, `--not-label`, `--milestone`, `--assignee`, `--search --in`, `--epic`, `--iteration`, `--page`, `--per-page` (30) (`glab issue list --help`) |
| JSON | `--json <fields>`: `assignees author body closed closedAt closedByPullRequestsReferences comments createdAt id isPinned labels milestone number projectCards projectItems reactionGroups state stateReason title updatedAt url` | Issues: `-O json` (`-F` means `details/ids/urls` here); MRs: `-F json` (`glab mr list --help`). The REST issue carries `iid state labels milestone assignees closed_by web_url type issue_type references task_completion_status merge_requests_count due_date …`, and no `epic` or `weight` on CE |
| Labels | Per repository: name, colour (hex without `#`), description (`gh label list`) | Project and group labels, inherited by subprojects; colour, description, priority [G2]. Scoped labels (`type::bug`) are Premium [G2] |
| Milestones | Per repository (REST `milestones`) | Project and group milestones (REST `milestones`) |
| Assignees | Several, by login | Several, by username |
| Hierarchy | Sub-issues: up to 100 per parent, eight levels, across repositories [H1]; read with `gh api …/issues/N/sub_issues` or GraphQL `parent`, `subIssues`, `subIssuesSummary`. Dependencies: GraphQL `blockedBy` [01-research [35]]. Issue types are configured in an organisation's settings [H2]; `ergoTech` is a user account (`gh api users/ergoTech --jq .type` → `User`), so `issueType` is `null` | Epics are Premium [G1]: `GET groups/:id/epics` → `404 Not Found` on CE. Free has child **tasks** under an issue: GraphQL lists the work item types `Epic, Incident, Issue, Key Result, Objective, Requirement, Task, Test Case, Ticket`, and an issue has the `HIERARCHY` and `LINKED_ITEMS` widgets, but no weight or iteration widget |
| Linked PRs/MRs | Issue: `closedByPullRequestsReferences`; PR: `closingIssuesReferences` (both in `--json`) | Issue: `GET …/issues/:iid/closed_by`, `…/related_merge_requests`; MR: `GET …/merge_requests/:iid/closes_issues` |
| Closing keywords | close(s/d), fix(es/ed), resolve(s/d); only when the PR targets the **default** branch; `OWNER/REPO#N` closes across repositories [H3] | Close, Fix, Resolve, Implement families; only on push or merge into the **default** branch; `group/project#N` or a full URL across projects; per-project "Auto-close referenced issues" switch [G3] |
| Pagination | `gh issue list --limit N`; `gh api --paginate [--slurp]`; REST `per_page` (100 observed) | `glab api --paginate [--output ndjson]`; headers `X-Total`, `X-Total-Pages`, `X-Next-Page`, `Link` |
| Incremental reads | REST `issues?since=<time>` | REST `issues?updated_after=<time>` |
| Rate limits | 5,000 requests per hour per user; 900 REST points per minute; 100 concurrent; 80 content-creating requests per minute and 500 per hour [H4]; search 30 per minute [H10]. An authorised conditional request answered `304` does not count [H5] | Authenticated API throttling is off by default on self-managed [G4]; `issues_create_limit` applies to creating issues only |

The rows marked by commands were checked with read-only `gh` and `glab` calls against real
repositories: an issue closed by a PR/MR through a closing keyword (seen from both sides), sub-issue
and dependency fields, the REST issues list returning pull requests too, `updated_after` and ETag on
GitLab, and the rate-limit answer of each forge.

### Specifics of the self-hosted GitLab

- **Two host names.** Remotes use the SSH host (`git@gitlab-ssh.example.com:frontend/site.git`),
  while the API and every `web_url` use `gitlab.example.com` (`glab auth status` maps both to
  `https://gitlab.example.com/api/v4/`). A link from a task to an issue or MR on such an instance
  therefore cannot be matched to its project by comparing the URL's host with the remote's host; the
  dashboard needs a host alias per project (or per space), taken from `glab`'s config or set once in
  the Projects tab. GitHub has one host for both.
  The same applies to PR/MR URLs: `prUrlOfProject` in `server/tracker/forge.ts` compares the URL's
  host with the remote's. Not checked on a live run.
- **CE, not Premium.** No epics, scoped labels, weights or iterations. The hierarchy that exists is
  issue → task (work item `Task`), and "relates to" links.
- **API throttling is the administrator's setting** and may be off, so the dashboard's own polling
  interval can be the only limit. It should still honour `429` and `Retry-After` [G4].
- **An administrator sees more than a Developer.** What works for an instance administrator (reading
  every project, `application/settings`) is not what a Developer collaborator sees. Anything built on
  these calls has to be checked with a Developer account before it ships.
- **Default branches are protected for Maintainers** (see [Authorisation](#3-authorisation-through-git)).

### GitHub Projects (v2)

```console
$ gh project list --owner ergoTech
error: your authentication token is missing required scopes [read:project]
To request it, run:  gh auth refresh -s read:project
```

The guide for automating projects uses GraphQL; reading needs `read:project`, writing needs
`project` [H6]. A REST API for Projects (v2) also exists: `GET /users/{username}/projectsV2` and
`/orgs/{org}/projectsV2` with their items endpoints [H11]; the page names no scopes. With this
machine's token it answers `404 Not Found` (`gh api users/ergoTech/projectsV2`), which does not tell
a missing scope from an account without projects. Fields are text, number, date, single select and iteration [H6]; built-in workflows move items,
for example a merged PR's item to Done [01-research [34]]. Not explored further on this machine:
refreshing the token's scopes is a change to the login, outside a read-only run.

## 2. Options for the dashboard

The constraints every option is held against:

- **Sync engine and invariants** ([05-architecture.md](05-architecture.md#invariants)): every plan
  change is a journaled operation whose `op_id` reaches origin in a commit trailer (I1); applying is
  idempotent (I2); a run writes only to its own live run (I3); one live run per task, ended only by
  its own merge or a confirmed release (I4); claims are decided from origin (I5); Paseo creation
  requests replay byte for byte (I6).
- **The plan repo is the single source of truth** (D1, D18), the plugin works from its own clone
  ([05-architecture.md](05-architecture.md#the-plugins-own-clone)), and people without Paseo read it
  (D9).
- **God Mode** ([06-god-mode.md](06-god-mode.md)): plan edits are `low` and run without a read-back
  (D10) because they stay in the plan repo; anything that reaches people or services is `outward`
  and asks first (the issue mirror, built later, runs separately from the edit; see
  [06-god-mode.md](06-god-mode.md#plan-edits-while-the-issue-mirror-is-on)).
- **No webhooks.** A daemon behind NAT cannot receive them
  ([01-research.md](01-research.md#alternatives-considered)), so everything forge-side is polled.

### a. Import issues into the inbox, one way, with a provenance link

A person (Inbox → Import from GitHub/GitLab) or ChatGPT picks a project, optionally filters by label
or milestone, sees open issues and ticks the ones to bring in. Each becomes an `inbox` draft whose
`issue` field is the issue's web URL, title copied, body copied into `## Brief` as quoted text,
labels copied into `labels`.

| | |
| --- | --- |
| Model | Task: `issue` (text, the web URL), `labels` (list of texts). Both flat, so Obsidian and Bases keep working. No issue state in the plan file |
| Sync engine | A `create` as today. Two machines importing the same issue would create two drafts with different random ids, so `create` gains a second precondition for drafts with an `issue`: **already applied when** a task with the same `issue` exists. That is I2's rule, applied to provenance instead of id; the second import leaves without a commit and the UI says "already imported as LAC-…". I3–I6 untouched: nothing here is run-scoped |
| God Mode | `add_to_inbox` and `create_task` take an optional `issue` URL; reads return `issue` and `labels`. Still `low` (it reads the forge and writes only the plan). Issue text is other people's words, like a meeting: reads stay `untrusted`, and nothing starts without a person accepting the draft. The operation count stays sixteen |
| Offline | The import needs the forge; it fails with the CLI's message and writes nothing. Imported drafts are ordinary files and work offline |
| Rate limits, cost | One list call per project per import (100 issues per page); on demand, not polled. Negligible on both forges |
| Effort | The `issue` field and its duplicate rule, a `forge.issues` RPC over `gh issue list --json` / `glab issue list -O json`, an import screen like the Laconote one. About two to three days |

### b. Link a task to an issue and mirror its state

A task (imported, or linked by pasting a URL) carries `issue`. The start prompt asks the agent to put
the closing keyword into the PR/MR description: `Closes #N` when the issue is in the task's project,
`Closes owner/repo#N` (GitHub) or `Closes group/project#N` (GitLab) when it is in another repository
of the same forge. When the task's own PR/MR merges, the **forge** closes the issue; the dashboard
writes nothing to the forge.

| | |
| --- | --- |
| Model | Same `issue` field as (a). The issue's state (open, closed, closed by which PR/MR) is **runtime state per machine**, like run activity, not a plan field: storing it would make every machine commit the same observation |
| Sync engine | No new operation. The task's `done` still comes only from its run's own merge (I4); the issue's closure is a consequence on the forge, not an input to the plan. An issue closed on the forge while the task is open is shown ("issue closed on GitHub: mark done or cancel?") and changes nothing by itself, the same rule as a merge that is not the run's own ([03-model.md](03-model.md#statuses)) |
| Where the keyword works | Only when the PR/MR targets the default branch [H3][G3]. A task whose `base` is a feature branch, or a project whose trunk is not the default branch, gets no automatic closure; the start confirmation says so. Only within one forge: a GitLab MR cannot close a GitHub issue, so a task in `core` linked to an android issue gets no closure either. GitLab also has a per-project switch (on in the three projects checked) |
| Check after merge | When the run's PR/MR is recorded merged, one read (`closingIssuesReferences` / `closes_issues`) tells whether the forge actually linked it; if not, the task shows "issue still open" with a link |
| God Mode | `task` returns `issue` and `issue_state`; no new operation. No risk change |
| Offline | The link is a file field; the state shows as "unknown" until the forge answers |
| Rate limits, cost | One `issue view` per linked open task on a slow timer (for example every 15 minutes), or one list call per project with `since` / `updated_after` and a conditional request. Ten projects every 15 minutes is 40 calls an hour, against 5,000 on GitHub and whatever limit the GitLab administrator set |
| Effort | Start-prompt line, the runtime issue state, the after-merge check, the host alias. About two days on top of (a) |

Built as phases F2 and F3 (decided by the user on 2026-10-27: "the user wants tasks seen as issues
on the forges"), as options (a) and (b) describe, with these specifics:

- **Model.** Task `issue` (the URL in one form per forge; `shared/issues.ts`) and the project's
  `web_host` in `space.yaml`, set on the Projects tab, for a GitLab with separate SSH and web hosts
  ([03-model.md](03-model.md#spaceyaml)). One issue is one task: the writes refuse an issue another
  task carries, and `create` is already applied when one does
  ([05-architecture.md](05-architecture.md#operations)).
- **Start.** The prompt's `## Issue` section and the confirmation's `issue` fact
  (`server/issues/link.ts`; [05-architecture.md](05-architecture.md#what-a-start-sends)). The default
  branch is the checkout's `origin/HEAD`, not read from the forge; GitLab's auto-close switch is not
  read.
- **State.** `server/tracker/issues.ts`, in memory per machine
  ([05-architecture.md](05-architecture.md#4-issue-state)); God Mode's `task` returns `issue` and
  `issue_state`.
- **Import.** `issues.list` / `issues.import` behind Inbox → "Import from GitHub/GitLab…", not
  described to God Mode ([05-architecture.md](05-architecture.md#forge-issue-import)); God Mode's
  `add_to_inbox`, `create_task` and `update_task` take `issue`.
- Not done: forge labels not yet in the palette get the next palette color, not the forge's; the
  after-merge check runs on the 15-minute timer (or when a screen shows the task), not right when the
  merge is recorded; `prUrlOfProject` still compares a reported PR/MR URL with the remote's host,
  so an agent's `pr_url` on `gitlab.example.com` is not matched to a `gitlab-ssh` remote.
- Not checked live by the agent that built it: a real PR/MR with the keyword closing its issue on
  GitHub and on the self-hosted GitLab, and an import against a real repository, are for the user to try
  after merging.

### c. Two-way sync

Plan edits written to the issue (title, labels, state, assignee) and issue edits written back to the
plan.

| | |
| --- | --- |
| Model | Everything in (a) and (b), plus a mapping of six statuses to open/closed (and `stateReason` on GitHub), of priorities to labels, of milestones and features to forge milestones that exist per repository or group, and a last-synced version per field to tell who changed what |
| Sync engine | Breaks the model. An edit made on the forge has no `op_id`, so it can only enter the plan as an operation some machine invents after polling; every machine polling would invent its own, and I1's "pending exactly when its `op_id` is not on origin" no longer identifies them. A forge write cannot be part of the plan commit, so a pushed plan change and its forge write can disagree after a crash, with no journal on the forge side to replay. The two sides need a conflict rule the engine does not have (the forge has no `expect`) |
| God Mode | Every plan edit would reach a service other people watch: `update_task` and `create_task` would become `outward`, which reverses D10 |
| Offline | Plan edits would queue for the forge as well as for git, with two kinds of pending |
| Rate limits, cost | Writes count as content creation on GitHub (80 per minute, 500 per hour [H4]); polling every linked issue per machine; echo suppression for one's own writes. The largest piece of work of the four, and it produces a second copy of the plan that has to be kept equal to the first |
| Verdict | Not recommended. If people outside Paseo must see tasks as issues, a one-way **mirror** from the plan (one machine, the space's owner, writes issues from committed plan state, like `ROADMAP.md`) keeps the plan the only source; it is still `outward` and needs a decision on which machine writes |

The mirror was built as phase F5 (asked by the user on 2026-10-27: tasks seen as issues), as
[05-architecture.md](05-architecture.md#issue-mirror) describes; two-way sync stays out. Its specifics:

- **Which machine.** A switch per space in Settings, off by default, kept in this machine's
  `mirror.json`; machines with it off write nothing. Nothing stops two machines from turning it on;
  the confirmation says not to, and the issue the task did not take is closed as not planned. The
  confirmation names the repositories the forge says are public; a project added after the switch
  is on is not checked.
- **Which tasks.** `todo`, `in_progress` and `review` tasks with a project and no `issue`, read from
  committed state; the URL is written back to `issue` with a `set`. Done and canceled tasks the
  mirror never saw open get no issue; inbox drafts get none.
- **Which issues.** Only those the mirror made (`mirror.json`); linked and imported ones are never
  written. A record lives on one machine: turning the switch on on another machine instead leaves
  the issues made so far as linked ones (never written again) and mirrors only tasks without one.
- **Which repositories.** Only those this machine's forge login can push to (push, maintain or admin
  on GitHub; Developer or above, in the project or its group, on GitLab), read once an hour. Anyone
  may open an issue in a public repository, so without this check a project that is someone else's
  public repository would get the space's briefs as public issues there. The mirror creates, updates
  and closes nothing in other repositories; Settings lists them as "Not mirrored". Only the project's
  `permissions` field is read (`project_access`, `group_access`); whether access through a group the
  project is shared with shows there was not verified on a live GitLab. Where it does not, such a
  project is not mirrored.
- **What.** Title, brief with the task id and a note that the plan is the source, labels, assignee
  through `people`'s forge logins, state (done closes as completed, canceled as not planned,
  reopening reopens). Written whole when the task's content changes, so forge edits last until the
  task's next change; comments are left alone.
- **Rate limits and offline.** 20 writes a minute and 300 an hour per host, a second apart; a failure
  stops that host for the pass and the task retries with backoff up to an hour; a rate-limit answer
  pauses the host for 15 minutes. A create whose answer was lost is looked up by a marker line in the
  body before another is made.
- **God Mode.** Unchanged: the switch is not described, and the plan edits stay `low`, decided by
  the user on 2026-10-27
  ([06-god-mode.md](06-god-mode.md#plan-edits-while-the-issue-mirror-is-on)).
- Not checked live by the agent that built it: issues made, edited, closed and reopened on a real
  GitHub and GitLab repository (labels the repository does not have yet, an assignee login, GitLab's
  `assignee_ids: []` and `state_event` on an issue already in that state); this is for the user after
  merging.

### d. GitHub Projects (v2) as a view

A project board on GitHub showing the plan's tasks, either as issues or as draft items.

| | |
| --- | --- |
| Model | Items need issues (back to option c) or draft items written by the dashboard (a one-way mirror through GraphQL or the REST `projectsV2` items endpoints [H11]) |
| Sync engine | As the mirror in (c): outside the journal, written from committed state |
| Fit | GitHub-only; the self-hosted GitLab repositories cannot be items. A user-owned project here, since `ergoTech` is a user account. Needs `project` scope on every writing machine; this machine's token has neither `project` nor `read:project` |
| God Mode | Nothing to add; ChatGPT already reads the plan |
| Offline | The board is on github.com only; a mirror would queue its writes like any forge write |
| Rate limits, cost | GraphQL is limited by points (5,000 per hour for this login, `gh api rate_limit`); a mirror writes one item per changed task. Moderate: a client for project items and fields (GraphQL or REST), and a field mapping per project board |
| Verdict | Not recommended. The metro map, `ROADMAP.md` and Obsidian Bases (D7, D9) already cover the "view for people without Paseo" across both forges |

## 3. "Authorisation through Git"

### What the dashboard has today

The dashboard has no users or roles of its own. Access is exactly access to the plan repository,
through each person's own git credentials
([05-architecture.md](05-architecture.md#what-the-plan-repo-needs)):

- **Read the plan**: clone/fetch the plan repo.
- **Plan and start**: push to its default branch (D13). Push access is also the trust boundary:
  briefs become agents' first prompts ([05-architecture.md](05-architecture.md#security)).
- `people` in `space.yaml` maps git identities to names for display; it grants nothing.

What that means on each forge:

| | GitHub | GitLab (this instance) |
| --- | --- | --- |
| Who can read | Owner and collaborators. A **user-owned** repository has only these two levels and no read-only collaborator [H7]; read-only needs an organisation (`pull`, `triage`) or a public repository | Members with a role. Reporter is the lowest default role that reads a private repository; newer releases add Planner [G5] |
| Who can push to the default branch | Every collaborator. Branch protection and rulesets are not available on private user-owned repositories on the free plan: `gh api repos/ergoTech/paseo_dashboard/branches/master/protection` → `403 Upgrade to GitHub Pro or make this repository public`. That happens to satisfy D13 | Only **Maintainers** by default: GitLab protects the default branch with push and merge for Maintainers (level 40); Developers push only to unprotected branches [G5]. A plan repository on this GitLab needs either "Developers + Maintainers allowed to push" on its default branch, or every collaborator as Maintainer |
| Who can invite | The owner | Maintainer or Owner (Owner for a group) [G6] |

GitLab's levels: 10 Guest, 15 Planner, 20 Reporter, 25 Security Manager, 30 Developer, 40
Maintainer, 50 Owner [G7]. Planner manages issues, epics, milestones and iterations [G5]; it is
useful only if issues become the place where people outside Paseo plan, which this document does
not recommend.

### Inviting a person through the forges' APIs

| | GitHub | GitLab |
| --- | --- | --- |
| Call | `PUT /repos/{owner}/{repo}/collaborators/{username}` → `201` with an invitation the person must accept, `204` when they get access without one (already a collaborator, an organisation member, a team member); `permission` (`pull` … `admin`) only on organisation repositories; 50 invitations per repository per 24 hours [H8] | `POST /projects/:id/members` (`user_id`, `access_level`) for existing accounts [G7]; `POST /projects/:id/invitations` with `email` and `access_level` for people without one; Maintainer or Owner [G6] |
| By email | No; a GitHub login is needed | Yes, through invitations. Whether self-service sign-up is on and needs an administrator's approval is the instance's setting, so a new person may also wait for an administrator |
| What the dashboard would add | A "Share this space" dialog in the Paseo UI: forge, username or email, role (GitHub user repositories: none to choose). It calls `gh api` / `glab api` with the inviter's own login, so no new credential is stored | — |
| Risk | Gives someone the power to write instructions for the inviter's agents. `outward`, asks first in the UI, and **not described to God Mode**: [06-god-mode.md](06-god-mode.md#why-these-risks) keeps settings and credentials out, and sharing the plan repo is treated the same way | — |

Removing a person is the reverse call and has the same trust meaning. Neither needs a model change:
the plan does not store who is invited, the forge does.

Decided by the user on 2026-10-27 (open question 5): invites from the dashboard, and plan
repositories discoverable. As built in phase F4 (`server/spaces/sharing.ts`,
`server/spaces/discover.ts`, contracts in `shared/sharing.ts`):

- **Discovery.** Plan repositories carry the topic `paseo-dashboard-plan`; onboarding adds it with
  `gh repo edit <owner/name> --add-topic` after `gh repo create`, and a failure to add it leaves the
  repository and says so in Settings. `plans.available` lists, on GitHub,
  `gh api --paginate user/repos?affiliation=owner,collaborator,organization_member` filtered on the
  topic by gh's `--jq` and again by the plugin (GitHub's search index lags behind a new topic), and
  on each GitLab host
  `glab auth status` reports as logged in, `projects?topic=…&membership=true` (the topic checked
  again). The clone URL follows the CLI's `git_protocol`. A repository is left out when a connected
  space comes from either of its clone URLs, and a GitLab instance reached under two host names lists
  a project once; clone URLs are compared without case. Someone invited sees the repository after
  accepting the invitation.
- **Who has access.** `sharing.read`: GitHub `repos/{o}/{r}/collaborators?affiliation=direct` and
  `…/invitations` (the repository owner is shown, not removable); GitLab `projects/:id/members` and
  `…/invitations`. Reading invitations needs admin on GitHub and Maintainer on GitLab; without it the
  members still show, with a line saying invitations are not shown.
- **Invite.** GitHub: `PUT repos/{o}/{r}/collaborators/{login}`, with `permission` `push`, `triage` or
  `pull` (offered as write, triage, read) on an organisation's repository and none on a user's; an
  empty `204` answer means they have access without an invitation (an existing collaborator, whose
  permission the call sets, an organisation member or a team member). GitLab: by username, `users?username=` then
  `POST projects/:id/members` with `user_id` and `access_level` (Reporter 20, Developer 30,
  Maintainer 40); by email, `POST projects/:id/invitations`, whose `status: error` answer is reported.
  The person is then added to `people` under the key the dialog gives (default: from the login), with
  the GitHub login, the GitLab login under the instance's web host, or the email; nobody is added
  when someone in `people` already holds that login or email. An existing entry under that key may
  gain a login it lacks or another email, which the confirmation names; one holding another login
  for the same forge (host) is never rewritten: the invitation is refused before anything is sent.
  When the plan is busy syncing past the write's wait, the answer still says the invitation went out
  and that People is not updated yet.
- **Remove.** GitHub: `DELETE …/collaborators/{login}`, or `DELETE …/invitations/{id}` for one not yet
  accepted. GitLab: `DELETE projects/:id/members/:user_id` or `DELETE …/invitations/:email`.
- **Confirmation and God Mode.** The dialog states what the person gets (pushing means writing briefs
  that become the inviter's agents' first prompts) and through whose login; `sharing.invite` and
  `sharing.remove` refuse without `confirmed`, before any forge call. None of these RPCs is described
  to God Mode.
- **Setup check.** `spaces.check` reads `projects/:id/protected_branches/<plan branch>` on GitLab and
  reports the branch when no push level at or below Developer (30) is allowed, with the fix (Protected
  branches → "Developers + Maintainers", or Maintainer for every collaborator). A branch that is not
  protected passes; an answer the login may not read is shown as "not checked".
- Not checked live by the agents that built it: a real invitation, its acceptance and the removal are
  for the user to try after merging.

### A web login with GitHub or GitLab OAuth

Only relevant if a web dashboard is built later; the Paseo plugin needs none of it.

- **What it would mean.** A server that keeps its own clone of each plan repo and serves people who
  have no Paseo. It needs to know who is asking (OAuth sign-in) and whether that person may read or
  write the plan, which the forge already answers: GitHub's
  `GET /repos/{owner}/{repo}/collaborators/{username}/permission` (used above), GitLab's members API.
  So "authorisation through Git" carries over: the forge's repository permission is the dashboard's
  permission, checked per session.
- **GitHub.** A GitHub App rather than an OAuth app: fine-grained permissions and access only to the
  repositories it is installed on, where an OAuth app needs broad scopes such as `repo` and gets
  everything the user can reach [H9].
- **GitLab.** An OAuth application registered on the instance (user applications page) with the
  authorization code flow with PKCE; scopes such as `read_user` for sign-in and `read_repository` /
  `write_repository` for git over HTTPS [G8]. A device grant exists (generally available in 17.9)
  [G8]. Each self-hosted instance needs its own registration, and its administrator sees the app.
- **What it changes.** The server becomes a writer of the plan repo on people's behalf: either it
  pushes with each user's token (their identity on every commit, but tokens stored server-side) or
  with one bot credential (simpler, but then git history no longer tells people apart, which weakens
  the "per git: …" hint in [05-architecture.md](05-architecture.md#security)). Starting agents from a
  web dashboard would need a reachable Paseo daemon per person, which is out of scope. A read-only web
  view is the cheap version: sign in, check read permission, render the same views `ROADMAP.md`
  renders.
- Two forges mean two sign-in buttons, and a person can have different identities on each; the plan
  would need a mapping, which `people` in `space.yaml` could hold (logins per forge).

## 4. Labels for tasks

Forge labels, as observed: GitHub labels are per repository with a colour without `#` and a
description (`gh label list --json name,color` → nine defaults such as
`bug #d73a4a`); GitLab labels are per project or group, inherited downwards, with a colour, a
description and a priority, and the `key::value` scoped form is Premium [G2]. Neither forge's labels
were used in the repositories checked.

Two ways to model them in the plan:

| | Free text | Defined in `space.yaml` with colours |
| --- | --- | --- |
| Task file | `labels: [ui, backend, bug]` | the same |
| `space.yaml` | nothing | `labels: { bug: { color: "#d73a4a", description: "…" }, ui: { color: "#7057ff" } }` |
| New label | Typing it | Typing it adds it to `space.yaml` in the same commit (a `label_def` operation, as projects are added on the Projects tab), with the next palette colour |
| Unknown label in a file (hand edit, Obsidian, import) | Shown as is | Shown in a neutral colour and listed in the space's problems as "not defined", never dropped |
| Import from a forge | Names copied verbatim | Names copied; a forge label not yet defined is offered with the forge's colour, for the person to accept |
| Typos and near-duplicates | Accumulate | Visible in one list, renamable in one commit |

Either way the dashboard needs:

- A `labels` list on tasks (and possibly features) in `shared/model.ts`, flat for Obsidian. The name
  `labels` rather than `tags` keeps Obsidian from merging it with its own tag system, whose values
  cannot contain spaces; using `tags` would instead make the tag pane and `#tag` search work. A
  choice for the user.
- **Add and remove operations instead of a list-valued `set`.** `set` with `expect` on the whole list
  makes two people adding different labels conflict. `label` with `add`/`remove` of one value,
  "already applied when" the value is already present or absent (I2), merges them.
- Filters in the task list, the inbox and God Mode's `tasks` read; chips on cards and stations;
  labels in `ROADMAP.md` tables and the Bases views.
- No mapping table between forges. A GitHub `bug` and a GitLab `type::bug` stay two labels unless a
  person renames one; the dashboard does not guess.

Decided by the user on 2026-10-27 and built as phase F1: **a palette of defined labels plus free
labels**, the field named `labels`, and `people` in `space.yaml` now. As built, `update_task` takes
`add_labels` and `remove_labels` (one `label` operation each) rather than a `labels` list, and the
`tasks` and `inbox` reads also take `mine`. The model is in
[03-model.md](03-model.md#spaceyaml), the operations in
[05-architecture.md](05-architecture.md#operations), God Mode's arguments in
[06-god-mode.md](06-god-mode.md#reads). Bases views name `note.labels` only in spaces created from
then on: the plugin writes them once and never rewrites them.

Recommendation: **defined in `space.yaml`**, because the meeting asked for labels "to categorise
tasks", which needs a fixed list and colours on the map, and because the definition step is where
imported forge labels get reconciled. The `label_def` operation and the colour default follow the
pattern the Projects tab already uses for line colours.

## 5. Recommendation and phased plan

The forges stay where code is reviewed and merged; the plan repository stays where work is planned.
The dashboard reads issues, links to them, and lets the forge close them. It writes to issues only
as the one-way mirror of F5, on the machine where a space's switch is on, and only to issues it made.

| Phase | Scope | Model change | God Mode | Acceptance (summary) | Size |
| --- | --- | --- | --- | --- | --- |
| F1 · Labels | `labels` on tasks, `labels` palette in `space.yaml`, add/remove operations, filters and chips, `ROADMAP.md` and Bases | `labels`, `space.yaml` `labels`, ops `label`, `label_def` | `tasks` filter by label; `create_task` / `update_task` take labels | Two machines adding different labels to one task both land; an undefined label from a hand edit shows as a problem, not dropped | 2–3 days |
| F2 · Issue link (built) | `issue` field; per-project web-host alias (`gitlab-ssh.example.com` → `gitlab.example.com`); start prompt line with the right closing reference; runtime issue state; after-merge check; "issue closed on the forge" hint | `issue`; project `web_host` (or derived from `glab` config) | `task` returns `issue`, `issue_state` | A GitHub and a GitLab task each merge a PR/MR with the keyword and their issues close; a task with a feature-branch base says at start that the issue will not close | 2 days |
| F3 · Import (built) | Inbox → Import from GitHub/GitLab per project, filter by label/milestone, de-duplication by `issue` across machines | `create` precondition on `issue` | `add_to_inbox` takes `issue`; reads stay `untrusted` | Importing the same issue on two machines yields one draft; an import with no network writes nothing | 2–3 days |
| F5 · Issue mirror (built) | One-way mirror of accepted tasks to issues in their project's repository, from committed state, on one machine per space | none (`issue` written back; `mirror.json` per machine) | none (switch not described; plan edits stay `low`, decided 2026-10-27) | A task moved to todo gets one issue, a machine without the switch makes none; done/canceled close, reopening reopens; linked or imported issues never written | 2–3 days |
| F4 · Sharing (built) | "Share this space" for GitHub collaborators and GitLab members/invitations; plan repositories found by the topic `paseo-dashboard-plan`; setup check that a GitLab plan repo's default branch accepts Developer pushes | none | none (not described) | Invite and remove through the UI with a confirmation; no credential stored | 2 days |

Not planned: two-way sync, GitHub Projects (v2), a web login. Each can be reconsidered when there is
a concrete reader for it; the one-way mirror in (c) was built as F5.

F1 does not depend on the others; F3 depends on F2's `issue` field. Each is one task, one PR, as in
[07-plan.md](07-plan.md).

## Open questions for the user

1. **Where will new tasks be written?** Today the forges hold five issues across both, so import
   brings in almost nothing. Is the meeting's "GitHub as a task manager" a wish to see tasks *as
   issues* on GitHub (then the one-way mirror matters, and which machine writes it), or to use the
   forges' labels and milestones as categories (then F1 alone answers it)?
2. **Labels: defined in `space.yaml` with colours (recommended) or free text?** And `labels` or
   Obsidian's `tags` as the field name?
3. **A plan repository on the self-hosted GitLab**: open its default branch to Developers, or make
   collaborators Maintainers? (D16 put the first plan repo on GitHub; this matters only if a GitLab
   one is wanted.)
4. **Read-only collaborators**: the user-owned GitHub repository cannot have them. Is moving the plan
   repo to a GitHub organisation acceptable if someone should only read?
5. **Should the dashboard invite people (F4)**, or is inviting through the forge's web UI enough?
6. **Web dashboard**: is one actually planned? If not, OAuth stays out of the design.

## Sources

GitHub:

- [H1] https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- [H2] https://docs.github.com/en/issues/tracking-your-work-with-issues/configuring-issues/managing-issue-types-in-an-organization
- [H3] https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- [H4] https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- [H5] https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- [H6] https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
- [H7] https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository
- [H8] https://docs.github.com/en/rest/collaborators/collaborators
- [H9] https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- [H10] https://docs.github.com/en/rest/search/search
- [H11] https://docs.github.com/en/rest/projects/projects, https://docs.github.com/en/rest/projects/items

GitLab:

- [G1] https://docs.gitlab.com/user/group/epics/
- [G2] https://docs.gitlab.com/user/project/labels/
- [G3] https://docs.gitlab.com/user/project/issues/managing_issues/ (Closing issues automatically)
- [G4] https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/
- [G5] https://docs.gitlab.com/user/permissions/
- [G6] https://docs.gitlab.com/api/invitations/
- [G7] https://docs.gitlab.com/api/members/
- [G8] https://docs.gitlab.com/api/oauth2/

References of the form [01-research [N]] are the numbered sources of
[01-research.md](01-research.md#sources).
