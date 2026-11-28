import type { PaseoApi } from "./server/paseo.ts";
import { autopilotStartOptions, nextTask, readAutopilot, setAutopilot, startReady } from "./server/queue.ts";
import { resumeCheck, resumeTask } from "./server/autopilot-resume.ts";
import { cliStopper } from "./server/runner/stop.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { beforeHook } from "./server/hooks.ts";
import { getTaskWithRuns, listInbox, listTasks, readBoard, readRoadmap, releaseCheck, startCheck, uiStartCheck } from "./server/api/reads.ts";
import {
  addToInbox,
  continueTask,
  rankTask,
  archiveTasks,
  archiveWorkspace,
  createFeature,
  createMilestone,
  createTask,
  markSeen,
  moveTask,
  releaseTask,
  startTask,
  updateFeature,
  updateMilestone,
  updateTask,
} from "./server/api/writes.ts";
import { describeDashboard, describeRpc } from "./server/capabilities.ts";
import { startPlan, startSet } from "./server/api/start-set.ts";
import { readMap } from "./server/map/read.ts";
import { featureView, liveRuns, planOptions, roadmapText, taskCodeMap, taskRuns, taskView } from "./server/views.ts";
import { Dashboard } from "./server/dashboard.ts";
import { readChanges } from "./server/changes.ts";
import { changesRpc } from "./shared/changes.ts";
import { readOverview } from "./server/overview.ts";
import { listEvents, markEventsRead } from "./server/events.ts";
import { eventsListRpc, eventsSeenRpc } from "./shared/events.ts";
import { readRecap } from "./server/recap.ts";
import { recapRpc } from "./shared/recap.ts";
import { addRecent, readPrefs, readRecent, writePrefs } from "./server/ui-prefs.ts";
import { readGodModeSettings, startWithoutAsking, writeGodModeSettings } from "./server/godmode-settings.ts";
import { godModeSettingsRpc, godModeSettingsSetRpc } from "./shared/godmode.ts";
import { readPlanToolsSettings, writePlanToolsSettings } from "./server/plan-tools-settings.ts";
import { planToolsSettingsRpc, planToolsSettingsSetRpc } from "./shared/plan-tools.ts";
import { reconcileRulesRpc, reconcileRulesSetRpc } from "./shared/reconcile.ts";
import { readRules, writeRules } from "./server/reconcile/rpc.ts";
import { enableDelegation, grantDelegation, listDelegationAgents, readDelegation, readDelegationLog, revokeDelegation } from "./server/delegation/rpc.ts";
import { delegationAgentsRpc, delegationEnableRpc, delegationGrantRpc, delegationLogRpc, delegationReadRpc, delegationRevokeRpc } from "./shared/delegation.ts";
import { previewQueue, readQueue, setQueue } from "./server/managed/rpc.ts";
import { queuePreviewRpc, queueReadRpc, queueSetRpc } from "./shared/managed-queue.ts";
import { openPlanTools } from "./server/agent-tools/plan-hook.ts";
import { listSpaces, syncAnswer } from "./server/spaces/list.ts";
import { localProjects } from "./server/spaces/local.ts";
import { createGithubRepo, GITHUB_REPO } from "./server/spaces/github.ts";
import { availablePlans } from "./server/spaces/discover.ts";
import { checkSpace, invite, readSharing, removeAccess } from "./server/spaces/sharing.ts";
import { plansAvailableRpc, sharingInviteRpc, sharingReadRpc, sharingRemoveRpc, spacesCheckRpc } from "./shared/sharing.ts";
import {
  addProject,
  cloneProject,
  cloneTarget,
  listProjects,
  mapProject,
  moveProject,
  removeProject,
  updateProject,
} from "./server/spaces/projects.ts";
import {
  projectsAddRpc,
  projectsCloneRpc,
  projectsListRpc,
  projectsMapRpc,
  projectsMoveRpc,
  projectsRemoveRpc,
  projectsUpdateRpc,
} from "./shared/projects.ts";
import { SPACE_KEY_PATTERN } from "./shared/model.ts";
import { helloRpc, overviewRpc } from "./shared/overview.ts";
import {
  acceptCheckRpc,
  featuresCreateRpc,
  featuresUpdateRpc,
  inboxAddRpc,
  inboxListRpc,
  milestonesCreateRpc,
  milestonesUpdateRpc,
  releaseCheckRpc,
  resumeCheckRpc,
  resumeTaskRpc,
  roadmapRpc,
  startCheckRpc,
  tasksCreateRpc,
  tasksGetRpc,
  tasksListRpc,
  tasksReleaseRpc,
  tasksResultRpc,
  tasksStartRpc,
  startPlanRpc,
  tasksStartSetRpc,
  tasksUpdateRpc,
  reconcileRpc,
  taskTextRpc,
  tasksProfilesRpc,
  updateTasksCheckRpc,
  updateTasksRpc,
  startCandidatesRpc,
  readyReviewRpc,
  tasksDeliveryRpc,
} from "./shared/api.ts";
import { taskDelivery } from "./server/delivery.ts";
import { startCandidates } from "./server/api/candidates.ts";
import { readyReview } from "./server/api/ready-review.ts";
import { readProfiles, readTaskText, updateTasks, updateTasksCheck } from "./server/api/batch.ts";
import { reconcile } from "./server/api/reconcile.ts";
import { mapRpc } from "./shared/map.ts";
import { uiBoardRpc } from "./shared/board.ts";
import { labelsPutRpc, labelsRemoveRpc, peoplePutRpc, peopleRemoveRpc } from "./shared/labels.ts";
import { putLabel, putPerson, removeLabel, removePerson } from "./server/api/team.ts";
import { activityRpc, activityTrackRpc } from "./shared/activity.ts";
import { trackWorkspace } from "./server/adopt.ts";
import { listActivity } from "./server/activity.ts";
import {
  tasksContinueRpc,
  tasksRankRpc,
  autopilotReadRpc,
  autopilotSetRpc,
  autopilotStartOptionsRpc,
  tasksNextRpc,
  tasksStartReadyRpc,
  tasksArchiveRpc,
  tasksArchiveWorkspaceRpc,
  tasksSeenRpc,
  tasksSendBackRpc,
  uiMoveRpc,
  uiOptionsRpc,
  uiPrefsRpc,
  uiPrefsSetRpc,
  uiRecentAddRpc,
  uiRecentRpc,
  uiRoadmapRpc,
  uiRunsRpc,
  uiStartCheckRpc,
  uiStartRpc,
  uiTasksCreateRpc,
  uiTaskResultRpc,
} from "./shared/ui.ts";
import { acceptCheck, sendBack, taskChecks, taskResult } from "./server/result.ts";
import { featureViewRpc, taskCodeMapRpc, taskRunsRpc, taskViewRpc } from "./shared/views.ts";
import { spacesAddRpc, spacesCreateRpc, spacesDisconnectRpc, spacesListRpc, spacesSyncRpc } from "./shared/spaces.ts";
import { localHost } from "./server/api/view.ts";
import { VERSION } from "./shared/version.ts";
import {
  laconoteConfigureRpc,
  laconoteImportRpc,
  laconoteMeetingsRpc,
  laconotePreviewRpc,
  laconoteProjectsRpc,
  laconoteReleasesReadRpc,
  laconoteReleasesSetRpc,
  laconoteSettingsRpc,
} from "./shared/laconote.ts";
import { configureLaconote, importItems, laconoteMeetings, laconoteSettings, previewMeeting } from "./server/laconote/importer.ts";
import { laconoteProjects, readReleases, setRelease } from "./server/laconote/releases-rpc.ts";
import { issuesImportRpc, issuesListRpc, issuesMirrorReadRpc, issuesMirrorSetRpc } from "./shared/issues.ts";
import { importIssues, listIssues } from "./server/issues/import.ts";
import { readMirror, setMirror } from "./server/issues/mirror-rpc.ts";

const message = (error: unknown) => String((error as Error)?.message ?? error);

/** Paseo stops waiting for an RPC after 30 s; past this, the work goes on and the reply says so. */
const ANSWER_WITHIN_MS = 25_000;

function within<T>(work: Promise<T>, onLate: (error: unknown) => void): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => {
      work.catch(onLate);
      resolve({ done: false });
    }, ANSWER_WITHIN_MS);
  });
  return Promise.race([work.then((value) => ({ done: true as const, value })), late]).finally(() => clearTimeout(timer));
}

export default function contribute(server: PluginServerContext) {
  // No I/O here: the first RPC starts the dashboard (lock, spaces, fetch loop).
  const dashboard = new Dashboard({ stopAgent: cliStopper() });

  // The switch is read on every call, so ChatGPT's next call follows a change made in Settings.
  server.handle(describeRpc, () => describeDashboard(startWithoutAsking(dashboard.dataDir)));

  server.handle(overviewRpc, async (input, { paseo }) => {
    dashboard.attach(paseo);
    await dashboard.start();
    // Screens read the overview, and the changes token is polled: while one is open, PRs/MRs are checked at most once a minute.
    dashboard.peekPrs();
    await dashboard.chats.ready();
    return readOverview(dashboard, input);
  });

  // The token a visible screen polls (client/changes.ts); the token itself is read from memory.
  server.handle(changesRpc, async (_input, { paseo }) => {
    dashboard.attach(paseo);
    await dashboard.start();
    return readChanges(dashboard);
  });

  // Plan reads and writes (06-god-mode.md). Each handler checks what it acts on itself: any paired
  // client can call any RPC, and meta.describe is not a permission system.
  const ctx = { dashboard };
  const started = <I, O>(fn: (input: I) => O | Promise<O>) => async (input: I, { paseo }: { paseo: PaseoApi }) => {
    dashboard.attach(paseo);
    await dashboard.start();
    return fn(input);
  };
  // Reads that say what became of a stopped run's chat wait for it to be read (server/chats.ts); one
  // that also waits for the forge or asks the providers waits less, to answer inside Paseo's 30 s.
  const SHORT_WAIT_MS = 2_000;
  const withChats = <I, O>(fn: (input: I) => O | Promise<O>, waitMs?: number) =>
    started(async (input: I) => {
      await dashboard.chats.ready(waitMs);
      return fn(input);
    });
  server.handle(tasksListRpc, withChats((input) => listTasks(ctx, input)));
  server.handle(tasksGetRpc, withChats((input) => getTaskWithRuns(ctx, input)));
  server.handle(roadmapRpc, started((input) => readRoadmap(ctx, input)));
  server.handle(inboxListRpc, started((input) => listInbox(ctx, input)));
  server.handle(startCheckRpc, withChats((input) => startCheck(ctx, input), SHORT_WAIT_MS));
  server.handle(releaseCheckRpc, started((input) => releaseCheck(ctx, input)));
  // A PR/MR's checks and review from gh / glab (server/result.ts), the task screen's read for God Mode.
  server.handle(tasksResultRpc, withChats((input) => taskChecks(ctx, input)));
  server.handle(reconcileRpc, withChats((input) => reconcile(ctx, input), SHORT_WAIT_MS));
  server.handle(tasksProfilesRpc, started((input) => readProfiles(ctx, input)));
  server.handle(updateTasksCheckRpc, started((input) => updateTasksCheck(ctx, input)));
  server.handle(updateTasksRpc, started((input) => updateTasks(ctx, input)));
  server.handle(taskTextRpc, started((input) => readTaskText(ctx, input)));
  server.handle(startCandidatesRpc, started((input) => startCandidates(ctx, input)));
  server.handle(readyReviewRpc, withChats((input) => readyReview(ctx, input), SHORT_WAIT_MS));
  server.handle(tasksDeliveryRpc, withChats((input) => taskDelivery(ctx, input)));
  // The read-back of accepting a task's work: who holds it and its PR/MR's checks and review.
  server.handle(acceptCheckRpc, started((input) => acceptCheck(ctx, input)));
  server.handle(inboxAddRpc, started((input) => addToInbox(ctx, input)));
  server.handle(tasksCreateRpc, started((input) => createTask(ctx, input)));
  server.handle(tasksUpdateRpc, started((input) => updateTask(ctx, input)));
  server.handle(tasksStartRpc, started((input) => startTask(ctx, input)));
  // A set of tasks the user named, with what each does now and in which order (server/api/start-set.ts).
  server.handle(startPlanRpc, started((input) => startPlan(ctx, input)));
  server.handle(tasksStartSetRpc, started((input) => startSet(ctx, input)));
  server.handle(tasksReleaseRpc, started((input) => releaseTask(ctx, input)));
  server.handle(milestonesCreateRpc, started((input) => createMilestone(ctx, input)));
  server.handle(milestonesUpdateRpc, started((input) => updateMilestone(ctx, input)));
  server.handle(featuresCreateRpc, started((input) => createFeature(ctx, input)));
  server.handle(featuresUpdateRpc, started((input) => updateFeature(ctx, input)));
  // Task events: finished, failed, waiting for the user (server/events.ts).
  server.handle(eventsListRpc, started((input) => listEvents(dashboard, input)));
  server.handle(eventsSeenRpc, started((input) => markEventsRead(dashboard, input)));
  // What happened in the plan over a period, from its commits (server/recap.ts).
  server.handle(recapRpc, started((input) => readRecap(dashboard, input)));
  // The metro map for the dashboard screens (not described to God Mode: it reads roadmap instead).
  server.handle(mapRpc, started((input) => readMap(dashboard, input)));
  // The board's columns (shared/board.ts), also only on the dashboard's screens.
  server.handle(uiBoardRpc, withChats((input) => readBoard(ctx, input)));
  server.handle(activityRpc, started((input) => listActivity(dashboard, input)));
  server.handle(activityTrackRpc, started((input) => trackWorkspace(ctx, input)));
  server.handle(taskViewRpc, withChats((input) => taskView(dashboard, input)));
  server.handle(taskRunsRpc, started((input) => taskRuns(dashboard, input)));
  server.handle(taskCodeMapRpc, started((input) => taskCodeMap(dashboard, input)));
  server.handle(featureViewRpc, started((input) => featureView(dashboard, input)));
  // Actions only the dashboard's screens offer (shared/ui.ts), also not described to God Mode.
  server.handle(uiStartCheckRpc, withChats((input) => uiStartCheck(ctx, input), SHORT_WAIT_MS));
  server.handle(uiTasksCreateRpc, started((input) => createTask(ctx, input, "dashboard")));
  server.handle(
    uiStartRpc,
    started(({ task, profile, mode, effort, model, start_past, seen, clarification, shown, branch }) =>
      startTask(ctx, { task, profile }, { startPast: start_past, seen, mode, effort, model, clarification, shown, branch }),
    ),
  );
  server.handle(tasksContinueRpc, started((input) => continueTask(ctx, input)));
  server.handle(tasksRankRpc, started((input) => rankTask(ctx, input)));
  server.handle(tasksNextRpc, started((input) => nextTask(ctx, input)));
  server.handle(tasksStartReadyRpc, started((input) => startReady(ctx, input)));
  server.handle(autopilotReadRpc, started(() => readAutopilot(ctx)));
  server.handle(autopilotSetRpc, started((input) => setAutopilot(ctx, input)));
  server.handle(autopilotStartOptionsRpc, started(() => autopilotStartOptions(ctx)));
  server.handle(resumeCheckRpc, started((input) => resumeCheck(ctx, input)));
  server.handle(resumeTaskRpc, started((input) => resumeTask(ctx, input)));
  server.handle(tasksArchiveWorkspaceRpc, started((input) => archiveWorkspace(ctx, input)));
  server.handle(tasksArchiveRpc, started((input) => archiveTasks(ctx, input)));
  server.handle(uiMoveRpc, started((input) => moveTask(ctx, input)));
  server.handle(tasksSeenRpc, started((input) => markSeen(ctx, input)));
  server.handle(uiOptionsRpc, started((input) => planOptions(dashboard, input)));
  server.handle(uiRunsRpc, started(() => liveRuns(dashboard)));
  server.handle(uiRoadmapRpc, started((input) => roadmapText(dashboard, input)));
  server.handle(uiTaskResultRpc, withChats((input) => taskResult(ctx, input)));
  server.handle(uiPrefsRpc, started(() => readPrefs(dashboard)));
  server.handle(uiPrefsSetRpc, started((input) => writePrefs(dashboard, input)));
  server.handle(uiRecentRpc, started(() => readRecent(dashboard)));
  server.handle(uiRecentAddRpc, started((input) => addRecent(dashboard, input)));
  // ChatGPT's settings (shared/godmode.ts), not described to God Mode: ChatGPT cannot turn them on.
  server.handle(godModeSettingsRpc, started(() => readGodModeSettings(dashboard)));
  server.handle(godModeSettingsSetRpc, started((input) => writeGodModeSettings(dashboard, input)));
  // The plan tools' switch (shared/plan-tools.ts), also only on the dashboard's screens.
  server.handle(planToolsSettingsRpc, started(() => readPlanToolsSettings(dashboard)));
  server.handle(planToolsSettingsSetRpc, started((input) => writePlanToolsSettings(dashboard, input)));
  // The owner's rule for automatic closing (shared/reconcile.ts), only on the dashboard's screens: ChatGPT cannot switch it on.
  server.handle(reconcileRulesRpc, started(() => readRules(dashboard)));
  server.handle(reconcileRulesSetRpc, started((input) => writeRules(dashboard, input)));
  // Delegated planning (shared/delegation.ts), only on the dashboard's screens: ChatGPT cannot grant it.
  server.handle(delegationReadRpc, started(() => readDelegation(dashboard)));
  server.handle(delegationEnableRpc, started((input) => enableDelegation(dashboard, input)));
  server.handle(delegationAgentsRpc, started((input) => listDelegationAgents(dashboard, input)));
  server.handle(delegationGrantRpc, started((input) => grantDelegation(dashboard, input)));
  server.handle(delegationRevokeRpc, started((input) => revokeDelegation(dashboard, input)));
  server.handle(delegationLogRpc, started((input) => readDelegationLog(dashboard, input)));
  // The managed queue (shared/managed-queue.ts), only on the dashboard's screens: ChatGPT cannot turn it on or raise its limit.
  server.handle(queueReadRpc, started(() => readQueue(ctx)));
  server.handle(queueSetRpc, started((input) => setQueue(ctx, input)));
  server.handle(queuePreviewRpc, started((input) => previewQueue(ctx, input)));

  // The Laconote import (Inbox tab, Settings), also not described to God Mode: ChatGPT has add_to_inbox.
  server.handle(laconoteSettingsRpc, started(() => laconoteSettings(ctx)));
  server.handle(laconoteConfigureRpc, started((input) => configureLaconote(ctx, input)));
  server.handle(laconoteMeetingsRpc, started((input) => laconoteMeetings(ctx, input)));
  server.handle(laconotePreviewRpc, started((input) => previewMeeting(ctx, input)));
  server.handle(laconoteImportRpc, started((input) => importItems(ctx, input)));
  // The release context's mapping (Settings), also only on the dashboard's screens.
  server.handle(laconoteProjectsRpc, started(() => laconoteProjects(ctx)));
  server.handle(laconoteReleasesReadRpc, started((input) => readReleases(ctx, input)));
  server.handle(laconoteReleasesSetRpc, started((input) => setRelease(ctx, input)));

  // Inbox → Import from GitHub/GitLab, also only on the dashboard's screens.
  server.handle(issuesListRpc, started((input) => listIssues(ctx, input)));
  server.handle(issuesImportRpc, started((input) => importIssues(ctx, input)));
  // The issue mirror's switch per space (Settings), also only on the dashboard's screens.
  server.handle(issuesMirrorReadRpc, started((input) => readMirror(ctx, input)));
  server.handle(issuesMirrorSetRpc, started((input) => setMirror(ctx, input)));

  // A space's label palette and people (the People & labels tab), also not described to God Mode.
  server.handle(labelsPutRpc, started((input) => putLabel(ctx, input)));
  server.handle(labelsRemoveRpc, started((input) => removeLabel(ctx, input)));
  server.handle(peoplePutRpc, started((input) => putPerson(ctx, input)));
  server.handle(peopleRemoveRpc, started((input) => removePerson(ctx, input)));

  // A space's projects (the Projects tab), also not described to God Mode.
  const withPaseo = <I, O>(fn: (input: I, paseo: PaseoApi) => O | Promise<O>) => async (input: I, { paseo }: { paseo: PaseoApi }) => {
    dashboard.attach(paseo);
    await dashboard.start();
    return fn(input, paseo);
  };
  server.handle(projectsListRpc, withPaseo((input, paseo) => listProjects(ctx, paseo, input)));
  server.handle(projectsAddRpc, started((input) => addProject(ctx, input)));
  server.handle(projectsUpdateRpc, started((input) => updateProject(ctx, input)));
  server.handle(projectsMoveRpc, started((input) => moveProject(ctx, input)));
  server.handle(projectsRemoveRpc, started((input) => removeProject(ctx, input)));
  server.handle(
    projectsMapRpc,
    withPaseo(async (input, paseo) => {
      try {
        return await mapProject(ctx, paseo, input);
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }),
  );
  server.handle(
    projectsCloneRpc,
    withPaseo(async (input, paseo) => {
      try {
        const target = cloneTarget(ctx, input);
        const result = await within(cloneProject(ctx, paseo, target), (error) =>
          dashboard.warnings.push(`cloning ${target.remote} into ${target.directory} failed: ${message(error)}`),
        );
        return { ok: true, done: result.done, directory: target.directory, error: "" };
      } catch (error) {
        return { ok: false, done: true, directory: "", error: message(error) };
      }
    }),
  );

  // Plan repositories to connect, sharing a space's plan repository and its setup check
  // (09-forge-issues.md, F4), through this machine's gh and glab logins; not described to God Mode.
  server.handle(plansAvailableRpc, started(() => availablePlans([...dashboard.spaces.values()].map(({ record }) => record.remote))));
  server.handle(sharingReadRpc, started((input) => readSharing(ctx, input)));
  server.handle(sharingInviteRpc, started((input) => invite(ctx, input)));
  server.handle(sharingRemoveRpc, started((input) => removeAccess(ctx, input)));
  server.handle(spacesCheckRpc, started((input) => checkSpace(ctx, input)));

  // A review comment for a task's agent, from the task screen (also not described to God Mode).
  server.handle(tasksSendBackRpc, withPaseo((input, paseo) => sendBack(ctx, paseo, input)));

  server.handle(helloRpc, async (_input, { paseo }) => {
    dashboard.attach(paseo);
    await dashboard.start();
    if (dashboard.owner) {
      void localProjects(paseo)
        .then((local) => {
          dashboard.updateMapping(local);
          // The checkouts are known now, so the first PR/MR pass can run: a merge made while the
          // plugin was off lands at once, not on the timer.
          dashboard.peekPrs();
        })
        .catch((error: unknown) => console.error(`dashboard: project mapping failed: ${message(error)}`));
    }
    return { version: VERSION };
  });

  server.handle(spacesListRpc, async () => {
    await dashboard.start();
    return listSpaces(dashboard);
  });

  server.handle(spacesAddRpc, async (input, { paseo }) => {
    try {
      const adding = dashboard.addSpace(input).then(async ({ key }) => {
        dashboard.updateMapping(await localProjects(paseo));
        void dashboard.syncAll();
        return key;
      });
      const result = await within(adding, (error) => dashboard.warnings.push(`connecting ${input.remote} failed: ${message(error)}`));
      if (!result.done) return { ok: false, key: "", error: "still connecting in the background; the space appears in the list when it is done" };
      return { ok: true, key: result.value, error: "" };
    } catch (error) {
      return { ok: false, key: "", error: message(error) };
    }
  });

  // Every check is in removeSpace itself: any paired client can call this.
  server.handle(spacesDisconnectRpc, async ({ space }) => {
    try {
      const removing = dashboard.removeSpace(space, localHost());
      const result = await within(removing, (error) => dashboard.warnings.push(`disconnecting ${space} failed: ${message(error)}`));
      if (!result.done) return { ok: false, error: "the space is busy syncing; the disconnect goes on in the background, and a refusal shows in the warnings" };
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });

  server.handle(spacesCreateRpc, async (input, { paseo }) => {
    // Checked before anything goes to GitHub, so a bad key does not leave an orphan repository.
    const key = input.key.toUpperCase();
    if (!SPACE_KEY_PATTERN.test(key)) return { ok: false, key: "", error: "the key is 2-6 capital letters" };
    if (!GITHUB_REPO.test(input.repo)) return { ok: false, key: "", error: `${JSON.stringify(input.repo)} is not a GitHub repository name like owner/plan` };
    await dashboard.start();
    if (!dashboard.owner) return { ok: false, key: "", error: dashboard.ownerReason };
    if (dashboard.spaces.has(key)) return { ok: false, key: "", error: `space ${key} is already connected` };
    try {
      const creating = createGithubRepo(input.repo).then(async ({ remote, warning }) => {
        if (warning) dashboard.warnings.push(warning);
        const { key: added } = await dashboard.addSpace({ remote, key, name: input.name });
        dashboard.updateMapping(await localProjects(paseo));
        void dashboard.syncAll();
        return added;
      });
      const result = await within(creating, (error) => dashboard.warnings.push(`creating ${input.repo} failed: ${message(error)}`));
      if (!result.done) return { ok: false, key: "", error: "still creating in the background; the space appears in the list when it is done" };
      return { ok: true, key: result.value, error: "" };
    } catch (error) {
      return { ok: false, key: "", error: message(error) };
    }
  });

  server.handle(spacesSyncRpc, async ({ space }) => {
    await dashboard.start();
    if (!dashboard.owner) return { ok: false, error: dashboard.ownerReason, spaces: [] };
    const target = space ? dashboard.spaces.get(space.toUpperCase()) : undefined;
    if (space && !target) return { ok: false, error: `no space ${space}`, spaces: [] };
    const targets = target ? [target] : [...dashboard.spaces.values()];
    try {
      // "Sync" also asks the forges about live runs' PRs/MRs, and git whether tracked trunk
      // checkouts landed, in the background.
      void dashboard.prs.checkAll().catch(() => undefined);
      for (const run of dashboard.runs?.runs.values() ?? []) void dashboard.refreshLanded(run);
      // Each space's own queue, never skipped like an overlapping loop tick: the person asked for a fetch now.
      const work = Promise.all(
        targets.map(({ sync }) =>
          sync.sync().catch((error: unknown) => {
            sync.state.error = `the plan could not be updated: ${message(error)}`;
          }),
        ),
      );
      const result = await within(work, () => undefined);
      const answer = syncAnswer(targets);
      if (!result.done) return { ok: true, ...answer, error: ["still syncing in the background", answer.error].filter(Boolean).join("; ") };
      return { ok: !answer.error, ...answer };
    } catch (error) {
      return { ok: false, error: message(error), spaces: [] };
    }
  });

  // Lifecycle hooks of this machine's task agents (05-architecture.md, Tracking progress).
  const unhook = dashboard.tracker.register(server);
  // The plan tools of any agent of a mapped project while the switch is on, and a coordinator's tools
  // (server/agent-tools/plan-hook.ts).
  unhook.push(
    beforeHook(server, "agent.session_open", ({ request }, { paseo }) =>
      openPlanTools(dashboard, request, paseo, { log: (line) => console.error(`dashboard: ${line}`) }),
    ),
  );

  return () => {
    for (const off of unhook) off();
    dashboard.stop();
  };
}
