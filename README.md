# Paseo Dash

Paseo Dash (PD for short; plugin id `dashboard`) is a [Paseo](https://paseo.sh) plugin that keeps the plan of your projects (releases, features that
span several repositories, tasks with acceptance checklists, and an inbox of drafts) as Markdown
files in a git repository, shows it as a metro map in Paseo, starts a task as an agent in its own
worktree, and follows it until its pull or merge request is merged. ChatGPT drives it through
[God Mode](https://github.com/devXpro/paseo-god-mode-plugin).

What the plugin does and what it needs on a machine is in [OVERVIEW.md](OVERVIEW.md), the page
Paseo shows for it. Changes by version are in [CHANGELOG.md](CHANGELOG.md). The design is in
[docs/design/task-manager-v1/](docs/design/task-manager-v1/README.md).

## Requirements

- Paseo 0.13.0 or newer on the daemon and in the app, with plugins enabled
  (Settings → Plugins → Enable plugins). Built and tested on macOS.
- `npm` and `node` on the daemon's `PATH`: installing from git runs
  `npm ci --omit=dev --ignore-scripts`, then `node scripts/edition.mjs release`.
- `git` that reaches the plan repository and the code repositories without prompting (SSH keys
  or a credential helper).
- `gh` logged in for GitHub; `glab` logged in for each GitLab host you use.
- Optional: God Mode 0.10.0 or newer, for ChatGPT.

## Install

```sh
paseo plugin add git:ergoTech/paseo-dash
paseo plugin ls             # dashboard: running, no ERROR
paseo plugin logs dashboard
```

`git:owner/repo` is the GitHub shorthand from `paseo plugin add --help`; Paseo 0.13 expands it to
`https://github.com/ergoTech/paseo-dash.git`. The full Git URL works as the source too.

Update to a later release:

```sh
paseo plugin update dashboard --ref <tag>
```

Keep one installation of the plugin per daemon. A development install under another id (for
example `dashboard-dev`) shares the plan clones and the journal; the second installation finds the
owner lock and stays read-only. Remove it with `paseo plugin remove dashboard-dev` (a local source
directory is left in place).

## Connect a plan

Everything below is in Paseo: the **Paseo Dash** row in the sidebar and **Settings → Paseo Dash**.

### Start your own plan

With no plan connected, Paseo Dash asks for one:

1. **Name** and **Key**: the key is 2 to 6 capital letters and prefixes every task id
   (`ME-7K3QX`).
2. **Create on GitHub…** creates a private repository with your `gh` login, writes the plan into
   it, and adds the topic `paseo-dashboard-plan`, so people you invite find it. Or paste the clone
   URL of an existing repository under **Or connect one that exists**: an empty repository, or one
   with only a README, becomes a new plan with the name and key above.
3. On the **Projects** tab, add the Paseo projects whose tasks you plan. Each becomes a line on the
   map.

Only a repository created here gets the topic. To let invited people find a plan you connected
instead, add the topic `paseo-dashboard-plan` to it yourself: on GitHub
`gh repo edit <owner/name> --add-topic paseo-dashboard-plan`, on GitLab the project's
Settings → General → Topics.

### Join a shared plan

1. The owner invites you: **People & labels → Share this space → Invite…**, or the repository's
   settings on GitHub or GitLab. You need push access: every plan change and every start is a push
   to the plan repository's default branch.
2. Accept the invitation on GitHub or GitLab.
3. **Settings → Paseo Dash → Plan repositories you can join** lists the repositories with the topic
   `paseo-dashboard-plan` that your `gh` and `glab` logins can read. Press **Connect** next to the
   plan. If it is not listed, press **Search again**, or paste its clone URL under **Connect a
   plan repository** and leave Key and Name empty.
4. On the **Projects** tab, under **On this Mac**, pick the Paseo project for each line you will
   work on, or clone the repository into a new directory. A task whose line is not mapped on this
   machine cannot start here.
5. On **People & labels**, check that your entry lists this machine's git email (**Add this Mac's
   email**), so the "mine" filter finds your tasks.

On a GitLab plan repository, the default branch must let Developers push, or every collaborator
needs the Maintainer role. Settings shows a "Setup:" line with the fix when it does not.

**Settings → Paseo Dash → Disconnect from this machine** removes a plan from this machine only; the
repository and everyone else's copy stay as they are.

## Working with it

1. **Inbox.** Drafts come from **New task** without a project, from ChatGPT (`add_to_inbox`), from **Import from
   Laconote…**, or from **Import from GitHub/GitLab…** (open issues of a project).
2. **Triage.** Give a draft its project, release and feature, edit the brief and the acceptance
   lines, then accept it (`todo`) or reject it.
3. **Start.** The start dialog shows the agent, its mode, the branch and what the task waits for.
   Starting claims the task in the plan repository, creates a worktree workspace and an agent with
   the brief. Another machine trying the same task is told who holds it.
4. **Follow.** The Live tab and the task screen show whether the agent works, waits for you or
   failed, its latest message, and the acceptance lines it ticked with `task_report`.
5. **Review.** When the pull or merge request is ready, the task moves to `review`. The task
   screen's **Result** block shows the changes, checks and review state; **Accept and mark done…**
   or **Send back to the agent** with a comment.
6. **Done.** Merged with its acceptance ticked, or merged and its workspace archived, the task is
   `done`, and its feature follows when all its tasks are done. `ROADMAP.md` in the plan repository
   is rendered again in each of the plugin's commits.

Every collaborator sees each change after their next sync (a fetch runs in the background;
**Sync now** in Settings forces one).

### Work that only a person can do

Some tasks are not for an agent: signing a contract, a decision only the owner makes. To keep them
out of automatic starts, name the labels that mark them in the plan repository's `space.yaml`:

```yaml
defaults:
  human_labels: [manual, needs-owner]
```

Commit and push it; every machine picks it up with its next sync. Names match in any case. Without
this setting (the default) labels change nothing about starting; a value that is not a list of labels
counts as no setting.

With it, a todo task carrying such a label:

- is passed over by **Start next**, **Start ready tasks**, the autopilot and `start_tasks`, each of
  which names the task and the label; turning the autopilot on for that one task is refused;
- reads as `needs_owner` in `start_plan` and `start_check`, with the reason and `needs: human_label`;
- can still be started by itself: from its own screen, or with `start_task`. The dialog and the
  read-back say the label, and so does the answer of a start without a read-back. A run already
  under way is left alone.

## ChatGPT through God Mode

God Mode reads the plugin's `meta.describe` and offers its operations to ChatGPT as Paseo Dash
(plugin id `dashboard`). Its description tells ChatGPT that «PD» means Paseo Dash, so «в PD заведи
таску» or «подивись PD» go to this plugin; `PD` is also an alias God Mode matches the plugin by.
It offers reads such as `overview`, `tasks`, `task`, `roadmap` and `inbox`, and actions such as
`add_to_inbox`, `create_task`, `update_task`, `start_task` and `release_task`. `start_task` and
`release_task` ask for confirmation with a read-back; plan edits do not. **Start tasks without
asking** (Settings, per machine) lets `start_task` run at once. `events` reads what this
Mac's task agents did meanwhile (finished, failed, waiting for you) and `mark_events_read` marks
them told; ChatGPT gets them when asked, since God Mode cannot reach a chat unasked. The contract
is in [06-god-mode.md](docs/design/task-manager-v1/06-god-mode.md).

## Development

```sh
npm install
npm run typecheck
npm test
```

A working copy runs in the daemon under its own id:
`paseo plugin add <absolute path> --id dashboard-dev`, then `paseo plugin reload dashboard-dev`
after edits. `npm install` marks a working copy as the development edition
(`shared/edition.generated.ts`, written by `scripts/edition.mjs`; not in git): it calls itself
**Paseo Dash Dev** in its sidebar row, screens and settings and to ChatGPT, and does not answer to
«PD», which stays with the installed plugin. Paseo's own plugin list still shows the manifest's
name, Paseo Dash, for both; the id (`dashboard-dev`) tells them apart there. An install from git
writes the release edition in its last `build` command. Disable or remove the `dashboard` installation meanwhile, or whichever of the two starts
second stays read-only (see Install). The working rules for this repository (review gate, branches, checks on the live
daemon) are in [AGENTS.md](AGENTS.md). `node fixtures/large-plan.ts` generates a plan of 500 tasks
for checking the screens by hand. `npm run sizes` prints what ChatGPT's reads weigh on that plan against
`origin/master`, for a PR; `npm test` fails when one goes over `fixtures/response-budget.ts`.

## License

MIT, see [LICENSE](LICENSE).
