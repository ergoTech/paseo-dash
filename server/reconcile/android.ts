import { type Build, DEFAULT_ENVIRONMENT, DEFAULT_VARIANT, type Task } from "../../shared/model.ts";
import { tasksOf } from "../api/view.ts";
import type { Plan } from "../plan/load.ts";
import { type GitRunner, SAFE_BRANCH } from "../sync/git.ts";
import { type ApkFact, type CardFacts, named, type PrFact } from "./facts.ts";

/**
 * An app card's way to QA and to Google Play (03-model.md, App delivery). Four states that never
 * stand for one another: the code (ready to merge or merged), a build QA can install for each variant
 * the card needs, QA's result, and the publication. A build covers a card only when git in the
 * project's checkout shows both: the build's commit is on the target branch as this checkout last
 * fetched it, and every one of the card's merge commits is in that build; variant and environment
 * match. Builds are shared: one recorded on any card of the project covers every card whose changes
 * it holds. A card's changes are every PR/MR it names: one still open, or one that could not be read,
 * leaves it covered by nothing. An available build passes no test, and a merge publishes nothing.
 */

const GIT_MS = 10_000;

/** Whether a card's delivery is an app's: it names the variants QA needs, a build or a publication state. */
export function isApp(task: Task): boolean {
  const d = task.delivery;
  return Boolean(d && (d.variants.length || d.builds.length || d.play));
}

export const variantsOf = (task: Task): string[] => (task.delivery?.variants.length ? task.delivery.variants : [DEFAULT_VARIANT]);
export const environmentOf = (task: Task): string => task.delivery?.environment ?? DEFAULT_ENVIRONMENT;

/** Every build recorded on a card of the project, each artifact once, the latest recorded first. */
export function buildPool(plan: Plan, project: string): Build[] {
  const pool = new Map<string, Build>();
  for (const task of tasksOf(plan)) {
    if (task.project !== project) continue;
    for (const build of task.delivery?.builds ?? []) {
      const key = [build.variant, build.environment, build.sha.toLowerCase(), build.url ?? ""].join("\n");
      const seen = pool.get(key);
      if (!seen || (build.at ?? "") > (seen.at ?? "")) pool.set(key, build);
    }
  }
  return [...pool.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.sha.localeCompare(b.sha));
}

const SHA = /^[0-9a-f]{7,64}$/i;
const short = (sha: string) => sha.slice(0, 7);

type Answer = "yes" | "no" | "unknown";

/** git merge-base --is-ancestor; anything but a clean yes or no (a commit the checkout lacks) is unknown. */
async function ancestor(git: GitRunner, root: string, commit: string, of: string): Promise<Answer> {
  const result = await git.run(root, ["merge-base", "--is-ancestor", commit, of], GIT_MS).catch(() => undefined);
  if (!result || result.timedOut) return "unknown";
  return result.code === 0 ? "yes" : result.code === 1 ? "no" : "unknown";
}

/**
 * The state of each variant the card needs, from a reading of its PR/MRs: all it names must be merged
 * and read, or no build covers it, whatever the others hold.
 */
export async function apkStates(
  git: GitRunner,
  root: string | undefined,
  trunk: string,
  task: Task,
  facts: Pick<CardFacts, "prs" | "unknown" | "limits">,
  pool: Build[],
  /** Which PR/MRs are the card's work: those it names, and for a hold whose agent is gone more (stopped.ts). */
  counts: (pr: PrFact) => boolean = named,
): Promise<ApkFact[]> {
  const environment = environmentOf(task);
  const merged = facts.prs.filter((pr) => counts(pr) && pr.state === "merged");
  const waiting = facts.prs.filter((pr) => counts(pr) && (pr.state === "open" || pr.state === "draft"));
  const unread = facts.unknown[0] ?? facts.limits[0]?.why;
  const out: ApkFact[] = [];
  for (const variant of variantsOf(task)) {
    const fact = (state: ApkFact["state"], why: string, build?: Build): ApkFact => ({
      variant,
      environment,
      state,
      why,
      ...(build ? { build: { sha: build.sha, url: build.url ?? "", version: build.version ?? "" } } : {}),
    });
    if (unread) {
      out.push(fact("unknown", `not every PR/MR of the card could be read: ${unread}`));
      continue;
    }
    if (waiting.length) {
      out.push(fact("awaited", `${waiting.map((pr) => pr.label).join(", ")} is not merged yet`));
      continue;
    }
    if (!merged.length) {
      out.push(fact("awaited", "no merged PR/MR of the card is known"));
      continue;
    }
    const unnamed = merged.find((pr) => !SHA.test(pr.mergeSha));
    if (unnamed) {
      out.push(fact("unknown", `the forge names no merge commit of ${unnamed.label}`));
      continue;
    }
    const matching = pool.filter((build) => build.variant === variant && build.environment === environment && SHA.test(build.sha));
    if (!matching.length) {
      out.push(fact("awaited", `no ${variant} build for ${environment} is recorded`));
      continue;
    }
    if (!root || !SAFE_BRANCH.test(trunk)) {
      out.push(fact("unknown", root ? "the project names no target branch to confirm the build against" : "the project is not checked out on this Mac, so no build can be compared"));
      continue;
    }
    let found: ApkFact | undefined;
    const reasons: { state: ApkFact["state"]; why: string }[] = [];
    for (const build of matching) {
      const onTrunk = await ancestor(git, root, build.sha, `refs/remotes/origin/${trunk}`);
      if (onTrunk !== "yes") {
        reasons.push(
          onTrunk === "no"
            ? { state: "awaited", why: `build ${short(build.sha)} is not on origin/${trunk} as this checkout last fetched it` }
            : { state: "unknown", why: `git cannot tell whether build ${short(build.sha)} is on origin/${trunk}: fetch the project's checkout` },
        );
        continue;
      }
      let missing = "";
      let untold = "";
      for (const pr of merged) {
        const held = await ancestor(git, root, pr.mergeSha, build.sha);
        if (held === "no") missing = missing || `build ${short(build.sha)} does not hold ${pr.label} (${short(pr.mergeSha)})`;
        if (held === "unknown") untold = untold || `git cannot tell whether build ${short(build.sha)} holds ${pr.label}: fetch the project's checkout`;
      }
      if (missing) reasons.push({ state: "awaited", why: missing });
      else if (untold) reasons.push({ state: "unknown", why: untold });
      else if (!build.url) reasons.push({ state: "awaited", why: `build ${short(build.sha)} holds the changes but no link to install it is recorded` });
      else {
        found = fact("available", `build ${short(build.sha)}${build.version ? ` (${build.version})` : ""} on origin/${trunk} holds ${merged.map((pr) => pr.label).join(", ")}`, build);
        break;
      }
    }
    // What git could not tell comes first: it may be the build that covers the card.
    const reason = reasons.find((r) => r.state === "unknown") ?? reasons[0]!;
    out.push(found ?? fact(reason.state, reason.why));
  }
  return out;
}

/** "APK phone (staging): build abc1234 …; APK wear (staging): no wear build for staging is recorded". */
export const apkText = (apks: ApkFact[]): string => apks.map((a) => `${a.variant} APK (${a.environment}) ${a.state}: ${a.why}`).join("; ");
