import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { issueKey, parseIssueUrl } from "../../shared/issues.ts";
import { loadPlan } from "../plan/load.ts";
import { buildPrompt } from "../runner/prompt.ts";
import { closingReference, closureFact, projectRepo } from "./link.ts";

const SPACE = `schema: paseo-dashboard/1
key: TST
name: Test space
projects:
  core: { remote: git@github.com:acme/core.git, trunk: main }
  site: { remote: git@gitlab-ssh.example.com:frontend/site.git, trunk: master, web_host: gitlab.example.com }
  ios: { remote: "ssh://git@gitlab-ssh.example.com:2222/frontend/ios.git", trunk: master, web_host: gitlab.example.com }
`;

/** A plan with one task per issue link, in the project given. */
function plan(tasks: { id: string; project: string; issue: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-issue-"));
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "space.yaml"), SPACE);
  for (const t of tasks) {
    writeFileSync(
      join(root, "tasks", `${t.id}-x.md`),
      `---\nid: ${t.id}\ntype: task\ntitle: Fix it\nstatus: todo\nproject: ${t.project}\nissue: ${t.issue}\n---\n\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n`,
    );
  }
  return loadPlan(root);
}

function prompt(project: string, issue: string, template?: string): string {
  const p = plan([{ id: "TST-KSS01", project, issue }]);
  const loaded = p.entities.get("TST-KSS01")!;
  return buildPrompt({ template, plan: p, loaded, task: loaded.entity as Task, spaceName: "Test", branch: "task/x", base: "main", tools: true });
}

test("issue URLs of both forges parse, in one form, and their key ignores spelling", () => {
  assert.deepEqual(parseIssueUrl("https://github.com/acme/core/issues/12"), { forge: "github", host: "github.com", repo: "acme/core", number: 12, url: "https://github.com/acme/core/issues/12" });
  assert.deepEqual(parseIssueUrl(" https://gitlab.example.com/frontend/web/site/-/issues/3/#note_9 "), {
    forge: "gitlab",
    host: "gitlab.example.com",
    repo: "frontend/web/site",
    number: 3,
    url: "https://gitlab.example.com/frontend/web/site/-/issues/3",
  });
  assert.equal(parseIssueUrl("https://gitlab.example.com/frontend/site/-/work_items/4")?.url, "https://gitlab.example.com/frontend/site/-/issues/4");
  for (const bad of [
    "https://github.com/acme/core/pull/12",
    "https://github.com/acme/issues/12",
    "https://example.com/acme/core/issues/12",
    "https://github.com/acme/core/-/issues/12",
    "javascript:alert(1)",
    "https://github.com/acme/core/issues/0",
    "",
  ]) {
    assert.equal(parseIssueUrl(bad), undefined, bad);
  }
  assert.equal(issueKey("https://GitHub.com/Acme/Core/issues/12?x=1"), issueKey("https://github.com/acme/core/issues/12/"));
  assert.notEqual(issueKey("https://github.com/acme/core/issues/12"), issueKey("https://github.com/acme/core/issues/13"));
});

test("a project's web host replaces its remote's host where they differ", () => {
  assert.deepEqual(projectRepo({ remote: "git@github.com:acme/core.git" }), { forge: "github", host: "github.com", repo: "acme/core" });
  assert.deepEqual(projectRepo({ remote: "git@gitlab-ssh.example.com:frontend/site.git", web_host: "gitlab.example.com" }), {
    forge: "gitlab",
    host: "gitlab.example.com",
    repo: "frontend/site",
  });
  assert.equal(projectRepo({ remote: "git@gitlab-ssh.example.com:frontend/site.git" })!.host, "gitlab-ssh.example.com", "without web_host, the remote's");
});

test("the closing reference: #N in the same repository, the full path in another of the same forge, none across forges", () => {
  const core = projectRepo({ remote: "git@github.com:acme/core.git" });
  const site = projectRepo({ remote: "git@gitlab-ssh.example.com:frontend/site.git", web_host: "gitlab.example.com" });
  const ref = (url: string) => parseIssueUrl(url)!;
  assert.deepEqual(closingReference(ref("https://github.com/acme/core/issues/7"), core), { ok: true, keyword: "Closes #7" });
  assert.deepEqual(closingReference(ref("https://github.com/Acme/Core/issues/7"), core), { ok: true, keyword: "Closes #7" }, "paths compare without case");
  assert.deepEqual(closingReference(ref("https://github.com/acme/android/issues/7"), core), { ok: true, keyword: "Closes acme/android#7" });
  assert.deepEqual(closingReference(ref("https://gitlab.example.com/frontend/site/-/issues/1"), site), { ok: true, keyword: "Closes #1" });
  assert.deepEqual(closingReference(ref("https://gitlab.example.com/backend/core/-/issues/5"), site), { ok: true, keyword: "Closes backend/core#5" });
  const across = closingReference(ref("https://github.com/acme/android/issues/7"), site);
  assert.equal(across.ok, false);
  assert.match((across as { reason: string }).reason, /github\.com.*gitlab\.example\.com/);
});

test("the start prompt puts the closing keyword in, for GitHub and GitLab, same and cross repository", () => {
  const cases: [project: string, issue: string, line: string][] = [
    ["core", "https://github.com/acme/core/issues/7", `Put the line "Closes #7" in the merge request's description`],
    ["core", "https://github.com/acme/android/issues/8", `Put the line "Closes acme/android#8" in the merge request's description`],
    ["site", "https://gitlab.example.com/frontend/site/-/issues/1", `Put the line "Closes #1" in the merge request's description`],
    ["site", "https://gitlab.example.com/backend/core/-/issues/5", `Put the line "Closes backend/core#5" in the merge request's description`],
    // A remote with a port and scheme: the path still decides "same repository".
    ["ios", "https://gitlab.example.com/frontend/ios/-/issues/2", `Put the line "Closes #2" in the merge request's description`],
  ];
  for (const [project, issue, line] of cases) {
    const text = prompt(project, issue);
    assert.ok(text.includes(line), `${project} ${issue}:\n${text}`);
    assert.ok(text.includes(`## Issue\n\nThis task stands for the issue ${parseIssueUrl(issue)!.url}.`), issue);
    assert.ok(text.indexOf("## Issue") > text.indexOf("## Dependencies") && text.indexOf("## Issue") < text.indexOf("## Reporting"), "between the dependencies and the reporting");
  }
  const across = prompt("site", "https://github.com/acme/android/issues/7");
  assert.ok(across.includes("on another forge than this repository, so the merge cannot close it"));
  assert.ok(!across.includes("Closes"), "no keyword that cannot work");
  assert.ok(!prompt("core", "not a link").includes("## Issue"), "an unusable link adds nothing");
});

test("a space template gets the issue section where it says {{issue}}, else at its end", () => {
  const placed = prompt("core", "https://github.com/acme/core/issues/7", "Do {{id}}.\n\n{{issue}}Thanks.");
  assert.ok(placed.startsWith("Do TST-KSS01.\n\n## Issue\n\n"));
  assert.ok(placed.trimEnd().endsWith("Thanks."));
  const appended = prompt("core", "https://github.com/acme/core/issues/7", "Do {{id}}.");
  assert.ok(appended.startsWith("Do TST-KSS01.\n\n## Issue\n\n"));
  assert.ok(appended.includes(`"Closes #7"`));
});

test("the start confirmation says when the merge cannot close the issue", () => {
  const core = { remote: "git@github.com:acme/core.git", trunk: "main" };
  const site = { remote: "git@gitlab-ssh.example.com:frontend/site.git", trunk: "master", web_host: "gitlab.example.com" };
  const gh = "https://github.com/acme/core/issues/7";
  assert.equal(closureFact({ task: { issue: undefined, base: undefined }, project: core, defaultBranch: "main" }), "");
  assert.equal(
    closureFact({ task: { issue: gh, base: undefined }, project: core, defaultBranch: "main" }),
    `Its issue acme/core#7 closes when the PR with "Closes #7" merges into main.`,
  );
  assert.match(closureFact({ task: { issue: gh, base: "feat/totp" }, project: core, defaultBranch: "main" }), /will not close by itself: the task's base is feat\/totp/);
  assert.match(closureFact({ task: { issue: gh, base: undefined }, project: { ...core, trunk: "develop" }, defaultBranch: "main" }), /will not close by itself: the project's base branch develop is not the repository's default branch main/);
  assert.match(closureFact({ task: { issue: gh, base: undefined }, project: site, defaultBranch: "master" }), /will not close by itself: the issue is on github\.com and the project on gitlab\.example\.com/);
  assert.match(
    closureFact({ task: { issue: "https://gitlab.example.com/frontend/site/-/issues/1", base: undefined }, project: site, defaultBranch: "master" }),
    /closes when the MR with "Closes #1" merges into master if the project closes referenced issues automatically/,
  );
  assert.match(closureFact({ task: { issue: gh, base: undefined }, project: core, defaultBranch: undefined }), /provided main is the repository's default branch \(not checked/);
  assert.match(closureFact({ task: { issue: "see the forum", base: undefined }, project: core, defaultBranch: "main" }), /not an issue URL/);
});
