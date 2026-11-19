import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeLargePlan } from "./large-plan.ts";

/**
 * What ChatGPT reads from this plugin on the large plan, in UTF-8 bytes of the JSON a handler returns
 * (`tasks_query`: a search, its rows with quotes and what else it names),
 * and what any agent's plan tools cost it: `plan_tools` is the JSON of their MCP tool list, `plan_find`
 * the text of a search that fills a whole page (server/agent-tools/plan.ts).
 * The code measured comes from `codeRoot`, so the same plan goes through another checkout too
 * (scripts/response-sizes.ts compares two). The plan always comes from this file's checkout: a
 * difference between two checkouts is then the code's, not the fixture's.
 *
 *   node fixtures/response-sizes.ts [checkout]
 *
 * prints the sizes as JSON, for the checkout given or this one.
 */

export const RESPONSES = ["meta.describe", "overview", "tasks", "tasks_query", "task", "plan_tools", "plan_find"] as const;
export type ResponseName = (typeof RESPONSES)[number];
export type ResponseSizes = Record<ResponseName, number>;

/** A fixed clock and host: dates and names in a reply must not move a size from one day to the next. */
const NOW = new Date(Date.UTC(2026, 10, 1, 12));
const HOST = "size-check-mbp";
const THIS_CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function planRemote(base: string): string {
  const root = join(base, "plan");
  const remote = join(base, "plan.git");
  mkdirSync(root);
  writeLargePlan(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Large plan fixture");
  git(root, "push", "--quiet", remote, "main");
  return remote;
}

export async function measureResponseSizes(codeRoot: string = THIS_CHECKOUT): Promise<ResponseSizes> {
  const load = (path: string) => import(pathToFileURL(join(codeRoot, path)).href);
  const { Dashboard } = (await load("server/dashboard.ts")) as typeof import("../server/dashboard.ts");
  const { describeDashboard } = (await load("server/capabilities.ts")) as typeof import("../server/capabilities.ts");
  const { readOverview } = (await load("server/overview.ts")) as typeof import("../server/overview.ts");
  const { getTask, getTaskWithRuns, listTasks } = (await load("server/api/reads.ts")) as typeof import("../server/api/reads.ts");
  const { FakePaseo } = (await load("server/runner/testing.ts")) as typeof import("../server/runner/testing.ts");
  const { tasksListInput } = (await load("shared/api.ts")) as typeof import("../shared/api.ts");

  const base = mkdtempSync(join(tmpdir(), "dashboard-sizes-"));
  const dashboard = new Dashboard({ dataDir: join(base, "data"), fetchIntervalMs: 3_600_000 });
  try {
    dashboard.attach(new FakePaseo({}).api());
    await dashboard.addSpace({ remote: planRemote(base) });
    const sync = dashboard.spaces.get("LPL")!.sync;
    await sync.sync();
    const ctx = { dashboard, now: () => NOW, host: HOST };

    const overview = readOverview(dashboard, {}, HOST);
    // Through the schema, as a call that names no page size: a larger default page is a larger reply.
    const tasks = await listTasks(ctx, tasksListInput.parse({}));
    // A search by a project's name: rows with where they matched, and the project itself in `also`.
    const tasksQuery = await listTasks(ctx, tasksListInput.parse({ query: "core" }));
    // An error reply is tiny and would pass any budget for the wrong reason.
    if (overview.error || overview.spaces.length === 0) throw new Error(`overview did not read the plan: ${overview.error || "no spaces"}`);
    if (tasks.error || tasks.tasks.length === 0) throw new Error(`tasks did not read the plan: ${tasks.error || "no tasks"}`);
    if (tasksQuery.error || tasksQuery.tasks.length === 0) throw new Error(`a tasks search found nothing: ${tasksQuery.error || "no tasks"}`);

    // The largest task. Which one that is changes with the fields a reply carries; only its runs need
    // git, once per task, so they are read for the one that is largest without them.
    let largest = { id: "", size: -1 };
    for (const { entity } of sync.plan.entities.values()) {
      if (entity.type !== "task") continue;
      const reply = getTask(ctx, { task: entity.id });
      if (reply.error) throw new Error(`task ${entity.id} did not read: ${reply.error}`);
      if (bytes(reply) > largest.size) largest = { id: entity.id, size: bytes(reply) };
    }
    if (!largest.id) throw new Error("the plan has no tasks to read");
    const task = await getTaskWithRuns(ctx, { task: largest.id });
    if (task.error || task.runs_error) throw new Error(`task ${largest.id} did not read: ${task.error || task.runs_error}`);

    // A checkout from before the plan tools has none: 0, which the table shows as new.
    const plan = await load("server/agent-tools/plan.ts").catch(() => undefined) as typeof import("../server/agent-tools/plan.ts") | undefined;
    let planTools = 0;
    let planFind = 0;
    if (plan) {
      const { PLAN_TOOLS } = (await load("server/agent-tools/bridge-script.ts")) as typeof import("../server/agent-tools/bridge-script.ts");
      const { FIND_LIMIT } = (await load("server/agent-tools/schema.ts")) as typeof import("../server/agent-tools/schema.ts");
      planTools = bytes({ tools: PLAN_TOOLS });
      const found = plan.findTasks(plan.scopeOf(dashboard, "git@github.com:example/core.git"), "task", FIND_LIMIT);
      if (found.split("\n").length !== FIND_LIMIT + 1) throw new Error(`plan_find did not fill a page: ${found.slice(0, 200)}`);
      planFind = Buffer.byteLength(found, "utf8");
    }

    return {
      // The installed plugin's description in both states of its switch: what ChatGPT can be given.
      "meta.describe": Math.max(bytes(describeDashboard(false, false)), bytes(describeDashboard(true, false))),
      overview: bytes(overview),
      tasks: bytes(tasks),
      tasks_query: bytes(tasksQuery),
      task: bytes(task),
      plan_tools: planTools,
      plan_find: planFind,
    };
  } finally {
    dashboard.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(await measureResponseSizes(resolve(process.argv[2] ?? THIS_CHECKOUT))));
}
