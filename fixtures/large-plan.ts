import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A large plan for checking the dashboard's screens by hand (07-plan.md, Phase 4 acceptance): 500
 * tasks in 6 projects, spread over releases and features, with every status and some dependencies.
 * Finished tasks carry the PR and branch they shipped from, every fifth task a decision in its
 * Notes and every task in progress a progress note, so search has something to find.
 * Deterministic, so the same command always makes the same plan.
 *
 *   node fixtures/large-plan.ts [directory]
 *
 * writes a plan repository into `<directory>/plan` with a bare remote `<directory>/plan.git` next to
 * it, and prints the remote to connect in Settings → Paseo Dash (key LPL).
 */

export const PROJECTS = ["core", "site", "android", "ios", "backoffice", "desktop"] as const;
export const TASK_COUNT = 500;
const RELEASES = 5;
const FEATURES = 40;
const STATUSES = ["done", "done", "todo", "todo", "todo", "in_progress", "review", "inbox", "canceled"] as const;
/** Every fourth task has no priority of its own, so the space's default counts (sortTasks). */
const PRIORITIES = ["urgent", "high", "medium", undefined, "high", "low", "medium", undefined] as const;

/** A distinct time per task, spread over October, so list order by age and by finish time is tested. */
const at = (t: number, hour: number) => new Date(Date.UTC(2026, 9, 1 + (t % 28), hour, t % 60)).toISOString();

/** Crockford base32 suffix for an index: LPL-00001, LPL-00002, … */
function id(prefix: string, n: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let rest = n, i = 0; i < 5; i += 1, rest = Math.floor(rest / 32)) out = alphabet[rest % 32] + out;
  return `${prefix}-${out}`;
}

const file = (front: Record<string, unknown>, body = "") =>
  `---\n${Object.entries(front)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n${body}`;

/** Writes the plan files into `root` (an empty directory). */
export function writeLargePlan(root: string): void {
  for (const dir of ["milestones", "features", "tasks"]) mkdirSync(join(root, dir), { recursive: true });
  const projects = PROJECTS.map((p) => `  ${p}: { remote: "git@github.com:example/${p}.git" }`).join("\n");
  writeFileSync(join(root, "space.yaml"), `schema: paseo-dashboard/1\nkey: LPL\nname: "Large plan"\nprojects:\n${projects}\ndefaults:\n  priority: medium\n`);

  const releases = Array.from({ length: RELEASES }, (_, r) => ({ id: id("LPL", 1 + r), title: `Release ${r + 1}.0` }));
  releases.forEach((release, r) => {
    const status = r === 0 ? "done" : r === 1 ? "active" : "planned";
    const due = `2026-${String(10 + Math.floor(r / 2)).padStart(2, "0")}-${r % 2 ? "28" : "14"}`;
    writeFileSync(join(root, "milestones", `${release.id}-release-${r + 1}-0.md`), file({ id: release.id, type: "milestone", title: release.title, status, due }));
  });

  const features = Array.from({ length: FEATURES }, (_, f) => ({ id: id("LPL", 100 + f), title: `Feature ${f + 1}`, release: f % (RELEASES + 1) }));
  for (const feature of features) {
    const milestone = feature.release < RELEASES ? `[[${releases[feature.release]!.id}-release-${feature.release + 1}-0]]` : undefined;
    const spans = PROJECTS.filter((_, p) => (p + feature.release) % 3 !== 2);
    writeFileSync(
      join(root, "features", `${feature.id}-feature-${feature.id.slice(-5).toLowerCase()}.md`),
      file({ id: feature.id, type: "feature", title: feature.title, status: feature.release === 0 ? "done" : "active", milestone, branch: `feat/f${feature.id.slice(-3).toLowerCase()}`, projects: spans }, "\nA feature of the large plan.\n"),
    );
  }

  for (let t = 0; t < TASK_COUNT; t += 1) {
    const taskId = id("LPL", 1000 + t);
    const feature = t % 7 === 6 ? undefined : features[t % FEATURES]!;
    let status: string = STATUSES[t % STATUSES.length]!;
    // A finished release's tasks are done, so the Done column stays finished.
    if (feature?.release === 0) status = "done";
    const project = PROJECTS[(t * 5) % PROJECTS.length]!;
    const depends = t > 10 && t % 4 === 0 ? [`[[${id("LPL", 1000 + t - 7)}-task-${t - 7}]]`] : undefined;
    const run =
      status === "in_progress" || status === "review"
        ? { run_id: `r-fixture-${t}`, run_by: "fixture", run_host: "elsewhere-mbp", run_branch: `task/${taskId.toLowerCase()}`, run_started: at(t, 9) }
        : {};
    const shipped =
      status === "done" ? { run_branch: `task/${taskId.toLowerCase()}`, run_pr: `https://github.com/example/${project}/pull/${t + 1}`, run_ended: at(t, 17) } : {};
    const progress = status === "in_progress" ? { progress_note: `Wiring step ${(t % 4) + 1} of 4` } : {};
    const notes = t % 5 === 0 ? `\nDecision: keep the queue in memory, not in sqlite (ticket Q${t}).\n` : "";
    writeFileSync(
      join(root, "tasks", `${taskId}-task-${t}.md`),
      file(
        {
          id: taskId,
          type: "task",
          title: `Task ${t} of ${project}`,
          status,
          priority: PRIORITIES[t % PRIORITIES.length],
          created: at(t, 8),
          project: status === "inbox" && t % 2 ? undefined : project,
          feature: feature ? `[[${feature.id}-feature-${feature.id.slice(-5).toLowerCase()}]]` : undefined,
          depends_on: depends,
          ...run,
          ...shipped,
          ...progress,
        },
        `\n## Brief\n\nGenerated task ${t}.\n\n## Acceptance\n\n- [${t % 3 ? " " : "x"}] first\n- [ ] second\n\n## Notes\n${notes}`,
      ),
    );
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const base = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "dashboard-large-plan-")));
  const root = join(base, "plan");
  const remote = join(base, "plan.git");
  mkdirSync(root, { recursive: true });
  writeLargePlan(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Large plan fixture");
  git(root, "push", "--quiet", remote, "main");
  console.log(remote);
}
