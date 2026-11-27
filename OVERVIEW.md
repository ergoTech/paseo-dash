Paseo Dash (PD for short) keeps the plan of your projects in a git repository and shows it in Paseo: releases, features that span several repositories, and tasks with acceptance checklists. A task starts as an agent in its own worktree, and its progress comes back from Paseo, from the agent's own reports, and from the task's pull or merge request.

## How it works

The plan is a set of Markdown files in a plan repository on GitHub or GitLab. Everyone who can push to that repository and runs Paseo with this plugin sees the same plan. Every change is a commit that the plugin pushes to the repository's default branch, so the history of the plan is the history of that branch. Starting a task claims it with a push, which means two machines never start the same task.

Starting a task creates a worktree workspace on a task branch and an agent whose first message is the task's brief. The agent gets two tools of its own to read the brief again and to report progress and ticked acceptance lines. When its pull or merge request is ready for review (not a draft), the task moves to review; when it is merged with its acceptance ticked, the task is done.

## What you see

- A board per plan, the first screen on desktop: drafts, tasks ready to start, blocked, running, in review and done as columns. Drag a draft to accept it or a task back to the drafts, and drag to set the order; on a phone the same moves are buttons.
- A metro map per plan: each repository a line, each release a column, each cross-repository feature an interchange, each task a station. Features and lines open into their own views.
- Tasks (on desktop), Inbox, Live (running work, with what needs you first), Roadmap, Projects, and People and labels tabs. With several plans, one Paseo Dash row shows the work of all of them.
- Live's "Review before starting": per open card of a space or project what is covered already (confirmed by its own merged PR/MR and ticked acceptance, partly, or only a possible match), what remains, and which task holds the most others back. It changes nothing.
- The task screen with its brief, checklist, run, and a Result block for reviewing the pull or merge request and accepting or sending back the work.
- A sidebar row with the count of what needs you, Command Center items, a panel for the task of the current workspace, and cards in the agent's timeline.
- Work started directly in Paseo, outside the plan, listed per line, and a workspace can be tracked as a task.
- Each plan repository also gets a generated `ROADMAP.md` with tables and Mermaid charts, and Obsidian Bases views, for people without Paseo.

## Setup

- Paseo 0.13 or newer. Built and tested on macOS.
- `git` with access to the plan repository and the code repositories. Pushes run without prompts, so the credential must work non-interactively.
- `gh` logged in for GitHub, `glab` logged in for each GitLab host. The plugin uses them, with your own login, to create a plan repository, find plan repositories you were invited to, invite people, read issues, write mirrored issues where you turn the mirror on, and follow pull and merge requests.
- A plan repository whose default branch accepts pushes from every collaborator. On GitLab the default branch is protected for Maintainers unless you change it; Settings shows the fix when it is.
- Each repository a task runs in must be a project in your Paseo, mapped to its line on the Projects tab.

With no plan connected, Paseo Dash offers to create a plan repository on GitHub or to connect an existing one by its clone URL. Settings → Paseo Dash connects more and lists the plan repositories you can join: those with the topic `paseo-dashboard-plan` that your `gh` and `glab` logins can read.

## Sharing

Access to the plan is access to the plan repository. "Share this space" invites a person on GitHub or GitLab through your own login and adds them to People. Whoever can push to the plan repository can write task briefs that become your agents' first prompts, so invite only people you trust. A GitHub repository owned by a user has no read-only collaborators.

## Task events

When a task's agent finishes its turn, fails or waits for your answer, Paseo Dash records it once, with the task, its chat, the time and the reply or reason. The Live tab lists them with the unread ones marked, and while the Paseo Dash row is shown in Paseo's sidebar each new one shows as a toast. Your phone's system notifications come from Paseo itself, without the task.

## ChatGPT through God Mode

With God Mode 0.10 or newer, ChatGPT knows the plugin as Paseo Dash and takes «PD» for it, so «в PD заведи таску» or «подивись PD» reach it. ChatGPT can read the plan (also the review before a start: coverage per card and the dependency roots), add drafts to the inbox, create and edit tasks, releases and features, and start or release a task. Plan edits go through without a read-back; starting a task, or releasing a task that someone has started, asks first. Settings → Starts asked through ChatGPT (God Mode) → "Start tasks without asking" (also behind the Settings button of Paseo Dash's top bar) lets ChatGPT start a todo task as soon as you ask, on this machine. Nothing is read back before the start, also when someone else changed the task's instructions since you saw them; ChatGPT tells you that after the start. The agent's permission mode stays its profile's or its provider's default. ChatGPT can also read what your task agents did while you were away (finished, failed, waiting for you) and mark it told; it reads them when you ask, it is not notified by itself. For "what happened since Friday" it reads a recap of the plan over up to 31 days: tasks done, merged, sent to review, started, blocked, released, created and drafted, with who, when and a link, taken from the plan repository's history, hand edits included. The plugin lists the facts; ChatGPT writes the summary. Settings, credentials and sharing are not exposed to God Mode. With the issue mirror on, a task ChatGPT creates in a project, or edits, also reaches the issue the mirror made for it; such plan edits still go through without a read-back, decided on 2026-10-27 (`docs/design/task-manager-v1/06-god-mode.md`).

## Plan tools for any agent

Settings → Agents → "Plan tools for every agent" (off by default) gives every agent on this machine whose repository is a project of a connected space three tools: search that space's tasks by words, read one task's brief and acceptance, and add a draft to the project's Inbox, so an agent can check for a duplicate before it proposes a task. They cannot start, move or edit tasks or reach other spaces. The tools come with each session's open: a new agent gets them at once, an agent already open only when its session next reopens, for example after Paseo restarts. Needs Paseo 0.14 or newer, for Claude, Codex, Copilot and OpenCode agents. In a permission mode that asks, each call asks.

## Delegated planning (pilot)

Settings → "Delegated planning (pilot)", off by default, lets you appoint one agent as the coordinator of one project: it can prepare that project's cards without being able to run them. You pick an open agent working in the project's repository and what it may do:

- Write its own drafts: add Inbox drafts, and edit the brief and acceptance of those it added while they are still drafts.
- Set priority: of drafts and todo cards.
- Set dependencies: between cards of the project; it removes one from drafts only.

Reload the agent afterwards: the tools come with a session's open. Needs Paseo 0.14 or newer, for Claude, Codex, Copilot and OpenCode agents. Settings lists every permission. Turning an action off or revoking the permission refuses the next call at once, and a change still waiting to be pushed is dropped at the next sync that reaches the plan repository; a push already under way is not stopped. Turning it on again does not bring a dropped change back. Settings and the task screen show the changes made, and those refused by the rules above, with who asked, when, and under which permission; the plan's commits name the agent and the permission too.

A coordinator cannot start, release or move a task, touch labels, requirements (QA among them) or delivery facts, change a card with a live run or marked as a person's work, reach another project, change its own permission, or overwrite an edit newer than the one it read. A permission mode that asks still asks for each call. Priority and dependencies change what the autopilot picks next.

What the limit does not cover: it binds the tools this plugin gives. An agent that runs shell commands as your user without asking can reach Paseo, the plugin's files and the plan repository itself. A change of the rules file while the plugin runs pauses every permission, dropping changes not pushed yet, until you save one again; a change made before a restart is not detected.

## Managed queue (pilot)

Settings → "Managed queue (pilot)", off by default, lets one project's ready cards start on this Mac without pressing Start. You set the project, how many starts it may make in 24 hours, and optionally the labels it is narrowed to. Live's "Managed queue" shows, before you turn it on and after, what it would do with each open card and why: which card is next, which wait for another card and enter by themselves once it is done, and every case that waits for you with the step that settles it. Turning it on, pausing and turning it off are your switches, here and in Live.

The queue is the autopilot with your limits on top: it starts one card per check, only while one of this Mac's places is free and no provider usage limit holds, and not more than the starts you allowed. Pausing or turning it off counts at once, also for a start that was only waiting for its turn, and the start asks again on the plan it fetched, so a card that changed meanwhile, a limit or a revocation stops it. A card starts once: another machine that wins the claim starts it, and a card whose run was released is never started again by the queue.

It leaves to you: cards marked as a person's work, waiting on a decision, access, a device or QA, with an open question, whose work looks merged or partly done, that read like another card (a signal, never a duplicate), whose data could not be read, whose instructions you have not seen as they are now (an imported text, a coordinator's draft or a changed scope), and drafts. A proven duplicate (the same issue, or the same title, brief and acceptance) is held while the older card goes first; you cancel it. Text on a card never gives it permission. Readiness checks settle signals only. Nothing here reaches ChatGPT. As with the other switches, this is not a boundary against a process of your own user, which can edit the plugin's files.

## Laconote

The inbox imports action items from Laconote meetings as drafts, from a pasted Markdown export or, with an API key, from the meeting list. The key is stored only on this machine, in the plugin's data directory with file mode 0600, and is never written to the plan repository. The inbox also imports open issues from GitHub and GitLab, and a task can link to an issue: the agent is asked to reference it in its pull or merge request, so that a merge into the default branch closes it.

## Issue mirror

"Mirror issues" in Settings, per space and off by default, makes this machine write a GitHub or GitLab issue for every open task (todo, in progress or review) that has no issue, in its project's GitHub or GitLab repository, and put the issue's link on the task. The issue's title, brief, labels, assignee (from People) and state follow the task: done or canceled closes it, reopening the task reopens it, and edits made on the forge are overwritten by the task's next change; comments stay. Tasks already done or canceled get no issue. Issues linked or imported by hand are never written. In a public repository the brief becomes public, and only one machine should have the switch on for a space.
