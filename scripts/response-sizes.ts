import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetOf } from "../fixtures/response-budget.ts";
import { RESPONSES, type ResponseSizes } from "../fixtures/response-sizes.ts";

/**
 * A table for a PR: the size of ChatGPT's reads on the large plan, in the working tree and in a base
 * commit (default origin/master, fetched first). The base is a temporary export of that commit, so
 * this checkout and git's worktree list stay as they are.
 *
 *   npm run sizes [-- base-ref]
 *
 * It reports and does not judge: `npm test` is what fails over budget.
 */

const HEAD = fileURLToPath(new URL("..", import.meta.url));

interface Side {
  label: string;
  sizes: ResponseSizes;
}

export function compareTable(base: Side, head: Side): string {
  const rows = RESPONSES.map((name) => {
    const before = base.sizes[name];
    const after = head.sizes[name];
    const change = after - before;
    const sign = change > 0 ? "+" : "";
    const percent = before ? `${sign}${((change / before) * 100).toFixed(1)}%` : "n/a";
    const budget = budgetOf(name);
    return `| ${name} | ${before} | ${after} | ${sign}${change} (${percent}) | ${budget}${after > budget ? " **over**" : ""} |`;
  });
  return [`| Response | ${base.label} | ${head.label} | Change | Budget |`, "|---|---:|---:|---:|---:|", ...rows].join("\n");
}

const git = (...args: string[]) => execFileSync("git", ["-C", HEAD, ...args], { encoding: "utf8" }).trim();

/** Measures in a process of its own, so two checkouts' modules and state never mix. */
const measure = (checkout: string): ResponseSizes =>
  JSON.parse(execFileSync(process.execPath, [join(HEAD, "fixtures/response-sizes.ts"), checkout], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));

function measureCommit(commit: string): ResponseSizes {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-sizes-base-"));
  try {
    const archive = join(dir, "base.tar");
    git("archive", "--output", archive, commit);
    execFileSync("tar", ["-xf", archive, "-C", dir]);
    symlinkSync(join(HEAD, "node_modules"), join(dir, "node_modules"), "dir");
    execFileSync(process.execPath, [join(HEAD, "scripts/edition.mjs"), "dev", join(dir, "shared/edition.generated.ts")]);
    try {
      return measure(dir);
    } catch {
      throw new Error(`Could not measure ${commit}: fixtures/response-sizes.ts reads modules and exports this commit may not have (see above).`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const ref = process.argv[2] ?? "origin/master";
  if (!process.argv[2]) {
    try {
      git("fetch", "--quiet", "origin", "master");
    } catch {
      console.error("Could not fetch origin/master; comparing with the local copy of it.");
    }
  }
  const baseCommit = git("rev-parse", "--short", `${ref}^{commit}`);
  const dirty = git("status", "--porcelain") ? "+uncommitted" : "";
  console.log(
    compareTable(
      { label: `base ${baseCommit}`, sizes: measureCommit(baseCommit) },
      { label: `head ${git("rev-parse", "--short", "HEAD")}${dirty}`, sizes: measure(HEAD) },
    ),
  );
  console.log("\nUTF-8 bytes of each reply's JSON on fixtures/large-plan.ts (plan_find: the text an agent gets), both sides on this checkout's plan.");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
