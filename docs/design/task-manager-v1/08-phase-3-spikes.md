# 08 · Phase 3 spikes

Results of the two spikes that [07-plan.md](07-plan.md#phase-3--runner-and-progress) asks for before
the runner is built. Run on 2026-10-26 against the local Paseo 0.13.0 daemon through the plugin SDK's
own `PaseoApi` (`createPaseoClient` over `ws://127.0.0.1:6767/ws`), which is the API the plugin
server receives as `paseo`. Scripts lived in a temp directory and are not part of the repository.

## Spike A · Agent tools transport and creation idempotency

**Setup.** A minimal MCP server with the two task tools (`task_brief`, `task_report`) that logs every
request, in two transports:

- stdio: `{ type: "stdio", command, args }`, newline-delimited JSON-RPC;
- loopback HTTP: `{ type: "http", url: "http://127.0.0.1:<port>/mcp", headers }`, JSON responses.

Each agent was created with `paseo.agents.create({ cwd, title, labels, prompt, config: { provider,
modeId, mcpServers: { dashboard }, toolPolicy: { preapproved: [both tools] } } })` and asked to call
`task_brief`, then `task_report`, then answer DONE.

**Results.**

| Provider (model, mode) | stdio | loopback HTTP |
| --- | --- | --- |
| Claude Code (`claude/claude-haiku-5-5`, mode `default`) | both tools called, no permission prompt, `pendingPermissions: []`, 10 s | both tools called, no prompt, 5 s; the tools were first found through `ToolSearch` |
| Codex (`codex/gpt-5.6-luna`, mode `auto`) | both tools called, no prompt, 9 s | both tools called, no prompt, 8 s |

- Claude Code defers MCP tools behind its tool search. The protocol types document `alwaysLoad: true`
  on the server config as loading them directly for the Claude provider. Not tested live yet; the
  bridge is planned to set it.
- Claude Code first sends `server/discover` (protocol 2026-07-28) and falls back to `initialize`
  (2025-11-25) when the server answers "method not found"; Codex sends `initialize` (2025-06-18). The
  bridge answers whatever version the client asks for.
- HTTP headers configured on the server reach every request after `initialize`, so a per-run token can
  travel in a header for HTTP, or in the stdio bridge's environment.
- **Node binary for stdio.** Plugin workers run as `Paseo Helper` (Electron), not as a system `node`.
  `process.execPath` of the worker with `ELECTRON_RUN_AS_NODE=1` runs a plain Node script (Node 24.20):
  the bridge's `command` is the worker's `process.execPath`, its `env` sets `ELECTRON_RUN_AS_NODE=1`,
  so the bridge does not depend on a `node` on `PATH`.

**Decision: stdio bridge over a Unix socket**, as the architecture preferred. The command and the
socket path are stable across plugin reloads, while a loopback HTTP port would change and leave
running agents with a stale URL. Checked once the bridge was built (2026-10-26):
- an agent started by the plugin (Claude, profile "laconote work") called `task_brief` and
  `task_report`, and the task moved to review in the plan;
- after `paseo plugin reload dashboard-dev`, the same agent called `task_brief` again and got the
  answer from the reloaded plugin.

The bridge script runs as the plugin worker's `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.

**Idempotency** (`idempotencyKey` on `agents.create`):

- the same key with the same request returns the same agent (same id), no second agent;
- the same key with a changed request (one space added to the prompt) fails with
  `agent_request_key_conflict`.

This matches I6: keys are per attempt and a stored request is replayed byte for byte. The
`outcomeUnknown` case (a failure after provisioning started) was not provoked; the runner handles it
as the architecture describes (reconcile by the `dashboard.run` label and the run's branch before any
new attempt), without a live observation.

## Spike B · Forge data and agent profiles

**Agent profiles.** `paseo.config.get()` returns `config.agentProfiles` as a list of entries
shaped by the protocol's `AgentProfileSchema`: `{ id, name, provider, model?, modeId?,
thinkingOptionId?, featureValues?, … }`. (An earlier version of this page named the fields `mode` and
`thinking`; the values were right, the field names were not.) On
this machine: "laconote work" (claude, `claude-opus-5-5`, modeId `auto`, thinkingOptionId `medium`),
"free" (codex, no model, modeId `auto-review`), "evoplay" (claude, `claude-opus-5-5`, `auto`,
`medium`). The config also holds provider keys and environment, so the
plugin reads only `agentProfiles` from it and never logs or returns the rest.

**PR/MR on the workspace descriptor.** Every workspace descriptor carries `forge` (`github`,
`gitlab`, or absent) and `githubRuntime: { featuresEnabled, pullRequest, error }`, also for GitLab
projects on `gitlab-ssh.example.com`.

- On all 56 workspaces of this daemon `pullRequest` was `null`, also after
  `paseo.workspaces.ref(id).refresh()`.
- Where a PR/MR exists, it was merged with a head other than the workspace's head:
  - a self-hosted GitLab project's branch: MR !935, merged, head `9d3af070`, while the workspace head
    is `593f2bba`;
  - another GitHub repository: PRs #1 and #3, both merged, with other heads.

  So the descriptor hides a merged PR/MR once the heads differ, as the architecture expects from the
  daemon code. This is the case the CLI fallback exists for.
- An open PR/MR at the workspace's head was not available on GitLab: no open MR existed in the
  repositories checked, and none was opened for the spike. So the GitLab descriptor is not observed
  live; the tracker does not depend on it, see the CLI fallback below.
- **GitHub, open PR at the workspace's head: filled, with a delay.** This phase's own draft PR #6 was
  opened on the workspace's branch. The descriptor still showed `pullRequest: null` right after, and
  showed it about two minutes later:
  - present: `number`, `url`, `state: "open"`, `isMerged`, `isDraft`, `headRefName`, `baseRefName`,
    `checksStatus`, `reviewDecision`, `mergeable`;
  - absent: a merge time and a head sha. `gitRuntime` carries `currentBranch` but no commit either.
  So the descriptor tells "open at this head" quickly enough for the `review` edge. It cannot decide
  whether a merge is the run's own, which needs `mergedAt` from the CLI.
- **CLI fallback works on both forges.** `glab mr list --source-branch <b> --all -F json` (glab 1.90)
  returns `iid`, `state`, `merged_at` and `sha`. `gh pr list --head <b> --state all --json
  number,state,mergedAt,headRefOid` (gh 2.83) returns the same facts. Both give the merge time the
  "run's own merge" rule needs.

**Consequence for the tracker.** The descriptor is read after each turn and on a timer, but the CLI
fallback is not a rare path: it decides every merge whose head moved, and every merge time. The
tracker treats the CLI as a primary source for `run_pr` once it is known, and the descriptor as the
fast path for an open PR/MR at the run's head.
