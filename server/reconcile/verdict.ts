import { type ChatState, chatSaid } from "../../shared/chats.ts";
import { hasLiveRun, type Task } from "../../shared/model.ts";
import type { LoadedEntity, Plan } from "../plan/load.ts";
import type { Closure } from "../sync/ops.ts";
import { mentionOnly } from "../tracker/merged.ts";
import { type CardFacts, merged, mergedSince, named, type PrFact } from "./facts.ts";
import { scopeText } from "./history.ts";
import { planHolds } from "./plan-gate.ts";
import type { Rule } from "./rules.ts";
import { byOrder, finishWith, type Hold, type Source } from "./types.ts";

/**
 * The verdict on one card: close it by the owner's rule, or the holds in the way, strongest first.
 * Pure: the facts are read before (server/reconcile/reconciler.ts) and the plan's own holds are read
 * again when the closure is applied (plan-gate.ts). Closing needs every one of these: a merged PR/MR
 * that is the card's own; every PR/MR the card names merged into the target branch, with nothing
 * pushed after it and every check the forge reports passing, and none still open or dropped; the
 * card's scope as it was at the merge; every acceptance line ticked; no open decision, manual or QA
 * step, dependency or claim. Anything not read is a hold, never a pass.
 */

export interface Verdict {
  close: boolean;
  holds: Hold[];
  /** The card's PR/MRs as read, as evidence. */
  sources: Source[];
  /** With close: what to write. */
  closure?: Closure;
}

export interface JudgeInput {
  plan: Plan;
  task: Task;
  loaded: Pick<LoadedEntity, "acceptance" | "brief" | "clarifications">;
  rule: Rule;
  facts: CardFacts | undefined;
  /** The card's own live run is the one that would end (its PR/MR merged). */
  asRun?: boolean;
  /** What this Mac knows of the live run's agent. */
  agent?: "working" | "gone" | "failed" | "waiting" | "elsewhere";
  /** With `gone` (no agent at work): what became of its chat, once read (server/chats.ts). */
  chat?: ChatState;
  host: string;
}

const short = (sha: string) => sha.slice(0, 7);
const cut = (text: string, max = 160) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
export const sourceOf = (pr: Pick<PrFact, "label" | "url" | "state">): Source => ({ label: `${pr.label} ${pr.state}`, url: pr.url });

/** The card's own PR/MR link, the evidence to show when nothing could be read. */
const linkSource = (task: Task): Source => {
  const url = task.run_pr ?? task.links.find((link) => /\/(?:pull|merge_requests)\/\d+/.test(link));
  return url ? { label: `${url.replace(/^.*\/(?:pull\/|-\/merge_requests\/)(\d+).*$/, (_m, n: string) => (url.includes("/pull/") ? `#${n}` : `!${n}`))} (not read)`, url } : { label: `${task.id} (the card)`, url: "" };
};

function forgeHolds(task: Task, rule: Rule, facts: CardFacts | undefined, scope: string): Hold[] {
  const card: Source = { label: `${task.id} (the card)`, url: "" };
  const markDone = `${finishWith(hasLiveRun(task))} after a look`;
  if (!facts) {
    return [{ code: "forge", text: "its PR/MR facts are not read on this Mac yet", next: "wait: they are read in the background", by: "wait", source: card }];
  }
  const holds: Hold[] = [];
  // A PR/MR that only mentions the card is never the evidence of a hold.
  const tied = facts.prs.find((pr) => !mentionOnly(pr.ways));
  if (facts.unknown.length) {
    holds.push({
      code: "forge",
      text: cut(`not all of its forge facts could be read: ${facts.unknown[0]}${facts.unknown.length > 1 ? ` (+${facts.unknown.length - 1})` : ""}`),
      next: `check this Mac's gh or glab login and the project's checkout, or look at the PR/MR yourself and ${markDone}; it is read again in a minute`,
      by: "owner",
      source: tied ? sourceOf(tied) : linkSource(task),
    });
  }
  const [limit] = facts.limits;
  if (limit) {
    holds.push({
      code: "forge",
      text: cut(`part of its work is not read: ${limit.why}${facts.limits.length > 1 ? ` (+${facts.limits.length - 1})` : ""}`, 220),
      next: `${limit.advice}, or ${markDone}`,
      by: "owner",
      source: linkSource(task),
    });
  }
  // Merged before the card existed: earlier work, whatever names it.
  const after = (pr: PrFact) => mergedSince(pr, task.created);
  const done = merged(facts).filter((pr) => pr.own && after(pr));
  const open = facts.prs.filter((pr) => (pr.state === "open" || pr.state === "draft") && named(pr));
  for (const pr of open) {
    holds.push({
      code: "open_pr",
      text: `${pr.label} is still ${pr.state === "draft" ? "a draft" : "open"}${done.length ? `: only part of the work is merged (${done.map((d) => d.label).join(", ")})` : ""}`,
      next: pr.state === "draft" ? "its author finishes it and marks it ready" : "review and merge it, or close it and take its link off the card",
      by: pr.state === "draft" ? "agent" : "owner",
      source: sourceOf(pr),
    });
  }
  for (const pr of facts.prs.filter((pr) => pr.state === "closed" && pr.ways.some((way) => way === "run" || way === "link"))) {
    holds.push({
      code: "closed_pr",
      text: `${pr.label} was closed without a merge: part of the work may be missing`,
      next: `if it was replaced, take its link off the card; else reopen it, or ${markDone}`,
      by: "owner",
      source: sourceOf(pr),
    });
  }
  if (!done.length) {
    // A merged PR/MR that only mentions the card is not merged work in doubt (tracker/merged.ts).
    const doubted = merged(facts).find((pr) => !mentionOnly(pr.ways));
    if (doubted) {
      const why = !after(doubted) ? "it merged before the card was created" : doubted.doubts[0] ?? "only its title names the card";
      holds.push({
        code: "tie",
        text: cut(`${doubted.label} is merged but is not proven to be this card's work: ${why}`),
        next: `if it did this card's work, ${markDone}; a link to a PR/MR no other card claims also ties it`,
        by: "owner",
        source: sourceOf(doubted),
      });
    } else if (!open.length && !facts.unknown.length && !facts.limits.length) {
      holds.push({ code: "no_pr", text: "no merged PR/MR of the card is known", next: `link its PR/MR on the card, or ${markDone}`, by: "owner", source: card });
    }
    return holds;
  }
  // Every merged PR/MR the card names is verified, not only its own: a shared one may carry part of its work.
  for (const pr of merged(facts).filter((pr) => named(pr) && after(pr))) {
    const source = sourceOf(pr);
    if (!facts.trunk || pr.base !== facts.trunk) {
      holds.push({
        code: "base",
        text: facts.trunk ? `${pr.label} was merged into ${pr.base || "an unknown branch"}, not ${facts.trunk}` : "the project names no target branch, so where the work landed cannot be judged",
        next: facts.trunk ? `merge the work on into ${facts.trunk}, or ${markDone}` : "set the project's trunk in Paseo Dash",
        by: "owner",
        source,
      });
    }
    if (pr.pushedAfter) {
      holds.push({ code: "pushed_after", text: `${pr.head} has commits pushed after ${pr.label} merged (${short(pr.pushedAfter)})`, next: `open a PR/MR for them, or ${markDone} if they are not this card's work`, by: "owner", source });
    }
    const checks = pr.checks;
    if (!checks) {
      holds.push({ code: "checks", text: `the checks of ${pr.label} are not known`, next: `look at them yourself, then ${markDone}`, by: "owner", source });
    } else if (checks.state === "failing") {
      holds.push({ code: "checks", text: cut(`checks of ${pr.label} fail: ${checks.failing.join(", ") || "failed"}`), next: `fix or rerun them, or ${markDone} if the failure is known`, by: "owner", source });
    } else if (checks.state === "pending" || checks.state === "waiting") {
      holds.push({
        code: "checks",
        text: `checks of ${pr.label} are ${checks.state}`,
        next: checks.state === "waiting" ? "run the manual job the pipeline waits for" : "wait for them: the card is read again",
        by: checks.state === "waiting" ? "owner" : "wait",
        source,
      });
    } else if (checks.state === "none" && !rule.no_checks_ok) {
      holds.push({
        code: "checks",
        text: `no check ran on ${pr.label}: nothing verified it`,
        next: `${markDone}, or let this project close without checks (Settings → Automatic closing)`,
        by: "owner",
        source,
      });
    }
    if (pr.review === "changes requested") {
      holds.push({ code: "checks", text: `a review of ${pr.label} requests changes`, next: `settle the review, or ${markDone}`, by: "owner", source });
    }
  }
  if (facts.scope.then !== undefined && facts.scope.then !== scope) {
    holds.push({ code: "scope", text: "its brief, acceptance or clarifications changed after the merge", next: `check the card as it reads now against the merged work: tick what is done and ${markDone}, or start it for the rest`, by: "owner", source: sourceOf(done[0]!) });
  } else if (facts.scope.then === undefined) {
    holds.push({ code: "scope", text: cut(`whether its scope changed since the merge is not known: ${facts.scope.unknown}`), next: markDone, by: "owner", source: card });
  }
  if (facts.scope.acted) {
    holds.push({ code: "scope", text: facts.scope.acted, next: `someone decided about it since the merge: ${markDone} if it is finished`, by: "owner", source: card });
  }
  return holds;
}

/** QA's hold of an app card says where QA is: the builds that cover it, shared by the cards they cover. */
function withBuilds(hold: Hold, facts: CardFacts | undefined): Hold {
  const apks = facts?.apks ?? [];
  if (hold.code !== "qa" || !apks.length || hold.by !== "owner") return hold;
  const missing = apks.filter((a) => a.state !== "available");
  if (!missing.length) {
    const builds = apks.map((a) => ({ label: `${a.variant} APK ${short(a.build!.sha)} (${a.environment})`, url: a.build!.url }));
    return {
      ...hold,
      text: `QA has not passed; ${apks.map((a) => `${a.variant} APK ${short(a.build!.sha)}`).join(", ")} is available`,
      next: "QA installs the build, tests the card and the result is recorded (update_task delivery qa passed)",
      source: builds[0]!,
      extra: builds.slice(1),
      group: builds.map((b) => b.url).join(" "),
    };
  }
  const first = missing[0]!;
  const target = facts!.trunk || "the target branch";
  // Not known is not missing: what git or the forge could not say is looked at, never built over.
  if (first.state === "unknown") {
    return {
      ...hold,
      text: cut(`whether a ${first.variant} APK (${first.environment}) covers it is not known: ${first.why}`, 220),
      next: `fetch the project's checkout (git fetch origin ${target}) or fix what could not be read; the builds are compared again`,
      group: `unknown ${first.variant} ${first.environment}`,
    };
  }
  return {
    ...hold,
    text: cut(`QA waits for the ${first.variant} APK (${first.environment}): ${first.why}`),
    next: `build the ${first.variant} APK for ${first.environment} from ${target} with the merged changes and record it (update_task delivery builds)`,
    by: "agent",
    group: `awaited ${first.variant} ${first.environment}`,
  };
}

export function judge(input: JudgeInput): Verdict {
  const { plan, task, loaded, rule, facts, asRun, host } = input;
  const holds = [...planHolds(plan, task, loaded, { asRun }).map((hold) => withBuilds(hold, facts)), ...forgeHolds(task, rule, facts, scopeText(loaded.brief, loaded.acceptance, loaded.clarifications ?? ""))];
  for (const [index, hold] of holds.entries()) {
    if (hold.code !== "claim" || !hasLiveRun(task)) continue;
    if (input.agent === "gone") {
      const next =
        input.chat === "closed"
          ? "continue its closed chat if work is left, or release it: to done if the work is finished"
          : "release it: to done if the work is finished, to todo to start it again";
      holds[index] = { ...hold, text: `${hold.text}; ${chatSaid(input.chat)}`, next, by: "owner" };
    } else if (input.agent === "failed") {
      holds[index] = { ...hold, text: `${hold.text}; its agent failed`, next: "release it: to done if the work is finished, to todo to start it again", by: "owner" };
    } else if (input.agent === "waiting") {
      holds[index] = { ...hold, text: `${hold.text}; its agent waits`, next: "answer its agent in its chat, or release the task if the work is finished", by: "owner" };
    }
  }
  holds.sort(byOrder);
  const sources = (facts?.prs ?? []).filter((pr) => !mentionOnly(pr.ways)).map(sourceOf);
  if (holds.length) return { close: false, holds, sources };
  // The same merged work the holds verified: an older PR/MR a card links is no part of its closing.
  const done = merged(facts!).filter((pr) => pr.own && mergedSince(pr, task.created));
  if (rule.mode !== "close") {
    return {
      close: false,
      holds: [
        {
          code: "report",
          text: `${done.map((pr) => pr.label).join(", ")} merged and everything the rule asks is verified; this Mac only reports for ${rule.project}`,
          next: `${finishWith(hasLiveRun(task))} after a look, or let the project close by itself (Settings → Automatic closing)`,
          by: "owner",
          source: { label: `this Mac's rule for ${rule.project}: report`, url: "" },
        },
      ],
      sources,
    };
  }
  const passed = done.map((pr) => (pr.checks!.state === "none" ? `${pr.label} no checks (allowed)` : `${pr.label} ${pr.checks!.passed} check(s) passed`));
  const note = [
    `${done.map((pr) => `${pr.label}${pr.mergeSha ? ` (${short(pr.mergeSha)})` : ""}`).join(", ")} merged into ${facts!.trunk}`,
    passed.join(", "),
    `${loaded.acceptance.length} of ${loaded.acceptance.length} acceptance lines ticked`,
    task.delivery?.qa === "passed" ? "QA passed" : "",
    `closed by this Mac's rule for ${rule.project}`,
  ]
    .filter(Boolean)
    .join("; ");
  return { close: true, holds: [], sources, closure: { at: facts!.at, by: host, prs: done.map((pr) => pr.url), note } };
}
