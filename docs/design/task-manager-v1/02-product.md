# 02 · Product: who, scenarios, and the v1 scope

## Decisions agreed with the user

Taken in the design session on 2026-10-25. Each one shapes the rest of the documents.

| # | Question | Decision |
| --- | --- | --- |
| D1 | Where do tasks live? | In a **separate git repository per umbrella project** (for example `laconote-plan`), so people can be invited to it. The plugin connects several such repositories, one space each. |
| D2 | What does "start a task" do? | Creates a **new worktree workspace and an agent** for it: one task, one branch, one workspace, one PR/MR. |
| D3 | Where does progress come from? | All three: **Paseo lifecycle**, the **agent's own reports**, and **PR/MR state**. |
| D4 | Who else works with the tasks? | **Each collaborator with their own Paseo** and this plugin. Two machines must not start the same task. |
| D5 | Hierarchy | Space → **Milestone (release)** → **Feature** (cross-repo) → **Task** (one repo) → acceptance checklist. Projects (repos) are a dimension of tasks. |
| D6 | Laconote meetings | Both **through ChatGPT** (the Laconote connector plus God Mode) and an **import inside the plugin**. |
| D7 | UI | Convenient day to day, and **visual like a roadmap per project**, readable from far away across sub-projects. Of four concepts, the user chose the **metro**: repos as lines, tasks as stations, features as interchanges, releases as columns ([04-ux.md](04-ux.md#the-metro-in-detail)). Refined by the owner on 2026-11-03: the metro shows the structure but is slower for daily work, so on desktop the space opens on the **board** (columns by task state, [04-ux.md](04-ux.md#the-board)) and the map is its own tab; on a phone the space still opens on the lines list. |
| D8 | ChatGPT | **God Mode must see and drive the plugin.** |
| D9 | People without Paseo | The plan repo carries a generated **`ROADMAP.md`** (Mermaid and tables) and **Obsidian Bases** views. |
| D10 | Plan edits from ChatGPT | **Without a read-back** (`low`); starting a task always asks first. |
| D11 | Name | Plugin id **`dashboard`**, title **"Dashboard"**. |
| D12 | Releasing a claimed task | Ending another run's hold on a task (back to todo, canceled or done) **asks first**: a dialog in Paseo, and `release_task` with risk `disruptive` in God Mode, naming who holds the task. Decided after the review found that a `low` reopen would allow a double start. |
| D13 | The plan repo's branch | The plan repo's **default branch** is the data branch; every collaborator's plugin pushes to it directly (no "require pull request" rule on it). |
| D14 | Agent defaults | **Per space**: `space.yaml` names the default agent profile for every start in the space; a task can override it; this machine's plugin setting applies only when the space names none, or a name this host does not have. |
| D15 | Feature completion | **Automatic**: a feature becomes `done` when all its tasks that are not canceled are done, and `active` again when one of them is reopened or a new task is added. Inbox drafts count neither way (2026-10-28). |
| D16 | Hosting of the first plan repo | **GitHub** (for example `ergoTech/laconote-plan`); collaborators are invited to that repository. |
| D17 | Dependency `yaml` | **Approved**, for front matter that keeps comments and key order on rewrite. |
| D18 | One plan repository for everything | Decided 2026-10-26, refining D1: the default is **one personal plan repository holding every project connected to the dashboard** (one space). Projects are added from this machine's Paseo projects or by URL on the dashboard's Projects tab, not by editing `space.yaml`; an umbrella (Laconote, Paseo plugins) is a `group` of projects, and the map can show one group. Several spaces still work, for a plan shared with other people. The dashboard can create the repository on GitHub with `gh` after asking. |
| D19 | Moving a task | Decided 2026-10-27: **"Move…" is an action** on the task (task screen, workspace panel, Command Center), not drag and drop on the map. It moves a task to another release, another feature, or out of its feature or release at any time; to another **line** (project) only while the task was never started (no `run_id`), since a started task's branch and PR/MR belong to that repository. `update_task` refuses a line change on a started task with the same reason. |
| D20 | Several spaces, one view | Decided 2026-10-27, refining D18: git grants access per repository, so a person with several audiences (a personal plan, a team plan in a GitHub organisation, other companies' plans) keeps **one plan repository per space**, and the dashboard shows **all their work in one view** across the spaces it holds; storage and the model do not change. With two or more spaces the sidebar has one "Dashboard" row with the total needs-you count; rows per space are a setting, off by default. The map is one band per space, each the space's own map (its releases, then its lines), one under another; the lists (Tasks, Inbox, Live, the work in Paseo outside the plan) mix the spaces, each row tagged with its space, with a space filter and "mine" resolved against each space's own people. Writes go to the task's own space: a project key held by several spaces, a draft without a project, a new release or feature and a Laconote import ask which. The roadmap stays per space ([04-ux.md](04-ux.md#all-spaces)). |
| D21 | Task order | Decided 2026-10-28: every task list is cut into sections (running, review, ready, blocked, drafts, done, canceled); inside ready and blocked, **priority first** (a task without one ranks as the space default), then a **manual rank that moves only within its priority level** (moving above another level is an explicit priority change), then the release due date, then creation time. Done work lists the latest first. |
| D22 | Waiting for a canceled task | Decided 2026-10-28: a dependency on a canceled task does not block, without any extra message. |
| D23 | The agent of a run that ends | Decided 2026-10-28: a release (back to todo, cancel, done) **stops** the run's agent: on this machine at once, on another machine once it syncs, however late (runs that ended before this version first ran there are left alone), and not for a release to done, which another machine cannot tell from a merge; a run that ended by its merge is left alone. The agent's chat stays. Archiving the run's workspace is a **separate button** on the task. |
| D24 | Starting without a person each time | Decided 2026-10-28: a cautious **autopilot**, opt-in on this machine for **one task** (start it once it is ready) or **one project** (its ready tasks one after another, only while no run of it is live). It starts only what an ordinary start would, only instructions the person has seen as they are now, at most one per pass and below a limit of runs at work on this machine (default 3; since 2026-11-15, JOBBY-AH5Z0, an agent that is gone or failed, or a task in review awaiting acceptance, takes no place); a usage limit an agent met holds every start until it resets; a failed start or agent (other than on a usage limit), or a person's release of a run it started, pauses it. "Start ready tasks" of a feature starts only the tasks its confirmation named, under the same seen-instructions rule. Since 2026-11-16 (JOBBY-H3ZEX) a new task created ready gets a task flag on its own unless created as To Do only or this Mac's "Start new ready tasks" is off, and every start from this Mac passes this Mac's default mode and effort (Auto, High) below a picked or profile's one. There is **no autopilot for everything**: "Start next" is a button. Two machines with the same project on autopilot can each start one of its tasks at the same moment; the claim keeps them on different tasks. |

## Who uses it

| Actor | Where | Needs |
| --- | --- | --- |
| **Lead** (the person who plans) | Paseo desktop and phone, ChatGPT voice | Plan releases and features, turn meetings into tasks, start agents, see what needs them, review and close |
| **Collaborator** with their own Paseo | Their Paseo | See the same plan, take tasks without colliding with others, run agents on their machine |
| **ChatGPT** through God Mode | Phone, car, walk | Read the state, create and edit tasks, start a task after a read-back, follow progress, then use God Mode's own chat tools on the task's agent |
| **Coding agent** started from a task | Paseo worktree | A self-contained brief, the acceptance checklist, a way to report progress without permission prompts |
| **Planning agent** (the hub "orchestrator") | Its own clone of the plan repo | A documented file format it can read and write; its pushes show up for everyone like a person's |
| **Collaborator without Paseo** (reader) | GitHub/GitLab web, Obsidian | Readable Markdown; edits that the plugin picks up and validates |

## Scenarios

Each scenario lists what "works" means; the phase that delivers it is in [07-plan.md](07-plan.md).

**S1 · Connect a space.** The lead adds `laconote-plan` by its remote URL. The plugin clones it,
reads `space.yaml`, maps `core`, `site`, `android`, … to the local Paseo projects by remote URL and
asks only for the ones it cannot match. *Works:* the space shows its milestones, features and tasks;
an unmapped project is visible as such, not silently dropped.

**S2 · Plan a release.** Create "Release 2.3" with a due date, the feature "TOTP 2FA" with the
shared branch `feat/totp-2fa` and its projects, then a task per repo with dependencies (core first,
clients after). *Works:* the roadmap shows the feature in the release with one lane per repo, the
client tasks shown as waiting for core.

**S3 · Meeting to inbox.** After a meeting, the lead either says to ChatGPT "turn yesterday's sync
into tasks" (ChatGPT reads Laconote, calls `add_to_inbox`), or opens Inbox → Import from Laconote,
picks the meeting and ticks action items. *Works:* drafts appear in the inbox with a link to the
meeting; nothing starts; a second import of the same meeting offers only new items, and asking
ChatGPT twice skips drafts that already exist for that meeting.

**S4 · Triage.** The lead goes through the inbox: assigns project, feature and milestone, edits the
title and brief, accepts (→ `todo`), merges duplicates by cancelling one, rejects (→ `canceled`).
*Works:* accepted tasks appear in the roadmap; the meeting link stays on the task.

**S5 · Start.** One tap on a `todo` task (or a confirmed ChatGPT `start_task`). *Works:* the claim
lands in the plan repo; a worktree workspace and an agent, both `LAC-7K3QX · TOTP endpoints in core`,
exist; the agent's first message is the brief built from the template; the task
is `in_progress` for every collaborator after their next sync. A second machine trying the same task
gets "already started by …".

**S6 · Follow.** The lead sees, per task, whether its agent works, waits for input, waits for them,
or failed, the agent's latest message, and the checklist ticks the agent reported. *Works:* a
permission request shows as "needs you" in the dashboard and in God Mode's `overview` within one
refresh; one tap opens the agent's chat.

**S7 · Review and done.** The agent opens an MR (Laconote: self-hosted GitLab) or PR (GitHub).
*Works:* the task moves to `review` with the link once the PR/MR is ready (a draft keeps it in
progress); when merged with its acceptance ticked it moves to `done`; a closed-unmerged MR leaves it
in place with a warning.

**S8 · See the roadmap from far away.** The lead opens the space and sees the metro: each repo a
line, each release a column, each feature an interchange crossing the repos it touches, each task a
station with its state; zooms into a feature to see its tasks in dependency order, or into one repo's
line; zooms into a task. *Works:* as specified in [04-ux.md](04-ux.md#the-metro-in-detail), on a wide
desktop window and, through the lines and features lists, on a phone.

**S9 · Collaborate.** Anna, with her own Paseo, connects the same plan repo, takes the Android task,
starts it on her Mac. *Works:* the lead sees "running on anna-mbp" without Anna's live details; edits
by both on different tasks or different fields never conflict; the same field edited at once shows a
conflict to resolve; taking the task back from Anna is a release that asks first and names her.

**S10 · Drive from ChatGPT.** "What needs me?", "how is release 2.3?", "add a task for the iOS QR
screen to the TOTP feature", "start it", "what did the agent say?". *Works:* every one of these goes
through God Mode's `plugin_read` / `plugin_action` with the operations in
[06-god-mode.md](06-god-mode.md), and the last one through God Mode's own `read_chat` on the
`chat_id` the plugin returned.

## Scope

### In v1

- Spaces backed by plan repos; project mapping per machine; sync with the operation journal; claims.
- Milestones, features, tasks (with dependencies and acceptance checklists), inbox drafts.
- Start: claim, worktree workspace, agent with the brief, the agent tools bridge.
- Progress from lifecycle, agent reports and PR/MR state; reconciliation after restarts.
- UI: the metro map with its feature and line views, the Live tab, a task list, task detail, inbox
  with Laconote import, settings; a workspace panel for the task of the current workspace; Command
  Center items; a composer pill on task agents; timeline cards for start and status changes.
- God Mode: the eighteen operations of [06-god-mode.md](06-god-mode.md).
- Obsidian-friendly files, a generated `ROADMAP.md`, Obsidian Bases views.

### Later (candidates for v2)

- Subtasks as their own level; time estimates and burndown.
- Recurring tasks and scheduled starts (Paseo schedules are not in the plugin SDK yet).
- Planning tools for the hub agent over MCP (in v1 it edits files in its own clone).
- Starting a task offline; moving a run to another machine.
- A one-way mirror to GitHub/GitLab issues.
- Notifications to other people (chat, mail) and comment threads on tasks.
- Automatic decomposition of a feature into tasks by an agent (in v1 ChatGPT or the hub agent can
  draft them into the inbox).
- A roadmap canvas shared with Obsidian (`.canvas`, laid out by people, live status on top).
- A calendar timeline view inside Paseo (v1 has the Mermaid gantt in `ROADMAP.md`).

### Not planned

- Real-time co-editing; a hosted web app; fine-grained permissions inside a plan repo (repo access is
  the permission); deleting tasks from ChatGPT.

## Constraints

- **Paseo 0.13.0** or newer on the daemon and the app: the plugin is built and tested against the
  0.13.0 SDK and reads protocol fields as 0.13.0 defines them (workspace forge data, agent attention
  fields, agent profiles); older versions are not tested. `requirements.paseo: ">=0.13.0"`.
- **God Mode 0.10.0** or newer for `outcome`, `target` and `untrusted` (installed: 0.12.1).
- Plugin UI uses React Native primitives and the host UI kit only; no SVG library, no DOM APIs
  outside a gated `client/web.ts`. Works on phones.
- New dependencies need the user's approval; `yaml` is approved (D17), the rest is in
  [07-plan.md](07-plan.md#dependencies).

## Open questions

None. The questions left after the review were answered by the user on 2026-10-25 and are
decisions D13–D17 above. What remains unverified are platform facts, which the phase 3 spikes check
on the live daemon ([07-plan.md](07-plan.md#phase-3--runner-and-progress)).
