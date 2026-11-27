import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../shared/model.ts";
import { setup } from "../api/testing.ts";
import type { CommandRunner } from "../tracker/forge.ts";
import { writeRule } from "./rules.ts";

/** A GitHub as `gh` shows it, for the project `acme/core` of the TST space: what the reconciliation reads. */
export interface FakePr {
  n: number;
  state?: "OPEN" | "MERGED" | "CLOSED";
  draft?: boolean;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  headSha?: string;
  mergeSha?: string;
  mergedAt?: string;
  createdAt?: string;
  /** Check conclusions; none by default is a PR with no check at all. */
  checks?: ("SUCCESS" | "FAILURE" | "PENDING" | "SKIPPED")[];
  review?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState?: string;
  fork?: boolean;
}

export const PR_URL = (n: number) => `https://github.com/acme/core/pull/${n}`;
/** A merge after the cards of the TST fixtures were committed and before any later edit of a test. */
export const MERGED_AT = new Date(Date.now() + 60 * 60_000).toISOString();

export class FakeGitHub {
  prs: FakePr[] = [];
  /** Every call, as `gh pr view <url>`. */
  readonly calls: string[] = [];
  /** The forge does not answer (a login that expired, a network that dropped). */
  down = false;
  /** Branch tips `git ls-remote` shows; a branch not listed is gone. */
  tips: Record<string, string> = {};
  /** PR numbers `gh pr view` cannot read. */
  unreadable: number[] = [];
  /** Runs before a call is answered, for a change that lands in the middle of a read. */
  before: ((command: string, args: string[]) => Promise<void>) | undefined;
  /** Calls under way now, and the most there ever were at once. */
  private running = 0;
  peak = 0;

  private json(pr: FakePr) {
    const state = pr.state ?? "OPEN";
    return {
      number: pr.n,
      url: PR_URL(pr.n),
      title: pr.title ?? `change ${pr.n}`,
      body: pr.body ?? "",
      state,
      isDraft: pr.draft ?? false,
      baseRefName: pr.base ?? "main",
      headRefName: pr.head ?? `feat/pr-${pr.n}`,
      headRefOid: pr.headSha ?? `${String(pr.n).padStart(2, "0")}aaaaa1111111111111111111111111111111111`.slice(0, 40),
      mergedAt: state === "MERGED" ? (pr.mergedAt ?? MERGED_AT) : null,
      createdAt: pr.createdAt ?? "2026-11-20T11:00:00Z",
      isCrossRepository: pr.fork ?? false,
      mergeCommit: state === "MERGED" ? { oid: pr.mergeSha ?? `${String(pr.n).padStart(2, "0")}bbbbb2222222222222222222222222222222222`.slice(0, 40) } : null,
      reviewDecision: pr.review ?? "",
      mergeable: pr.mergeable ?? "MERGEABLE",
      mergeStateStatus: pr.mergeState ?? "CLEAN",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      files: [],
      statusCheckRollup: (pr.checks ?? []).map((c, i) => ({
        __typename: "CheckRun",
        name: `check ${i + 1}`,
        workflowName: "ci",
        status: c === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: c === "PENDING" ? "" : c,
        startedAt: "2026-11-21T10:00:00Z",
      })),
    };
  }

  runner(): CommandRunner {
    return async (command, args) => {
      this.running += 1;
      this.peak = Math.max(this.peak, this.running);
      try {
        await this.before?.(command, args);
        await new Promise((resolve) => setImmediate(resolve));
        return this.answer(command, args);
      } finally {
        this.running -= 1;
      }
    };
  }

  private answer(command: string, args: string[]): Awaited<ReturnType<CommandRunner>> {
      if (this.down) return { code: 1, stdout: "", stderr: "gh: HTTP 401: Bad credentials" };
      if (command === "git" && args[0] === "ls-remote") {
        const branch = args[2]!.replace("refs/heads/", "");
        const tip = this.tips[branch] ?? this.prs.find((p) => (p.head ?? `feat/pr-${p.n}`) === branch)?.headSha;
        return { code: 0, stdout: tip ? `${tip}\trefs/heads/${branch}\n` : "" };
      }
      if (command !== "gh") return { code: 1, stdout: "", stderr: `unexpected ${command}` };
      if (args[0] === "pr" && args[1] === "view") {
        this.calls.push(`gh pr view ${args[2]}`);
        const pr = this.prs.find((p) => PR_URL(p.n) === args[2]);
        return pr && !this.unreadable.includes(pr.n) ? { code: 0, stdout: JSON.stringify(this.json(pr)) } : { code: 1, stdout: "", stderr: "not found" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        const head = args[args.indexOf("--head") + 1];
        if (args.includes("--head")) return { code: 0, stdout: JSON.stringify(this.prs.filter((p) => (p.head ?? `feat/pr-${p.n}`) === head).map((p) => this.json(p))) };
        const search = args.find((a) => a.startsWith("--search="))?.slice("--search=".length).split(" ")[0];
        const wanted = args[args.indexOf("--state") + 1] === "open" ? "OPEN" : "MERGED";
        const listed = this.prs.filter((p) => (p.state ?? "OPEN") === wanted && (!search || `${p.title ?? ""} ${p.body ?? ""}`.toLowerCase().includes(search.toLowerCase())));
        return { code: 0, stdout: JSON.stringify(listed.map((p) => this.json(p))) };
      }
      return { code: 0, stdout: "[]" };
  }
}

/** A card file, committed to the plan by a person's clone. */
export function cardFile(id: string, slug: string, front: string, body: { acceptance?: string[]; brief?: string } = {}): (root: string) => void {
  const lines = (body.acceptance ?? ["Code works", "Verified by hand"]).map((l) => `- ${l}`);
  return (root) =>
    writeFileSync(
      join(root, "tasks", `${id}-${slug}.md`),
      `---\nid: ${id}\ntype: task\ntitle: ${slug}\nproject: core\ncreated: 2026-11-20T10:00:00Z\n${front}---\n\n## Brief\n\n${body.brief ?? "Do it."}\n\n## Acceptance\n\n${lines.join("\n")}\n`,
    );
}

/** The TST space with a fake GitHub, and the rule `mode` for its core project on this machine. */
export async function reconcileSetup(
  mode: "report" | "close" | "off" = "close",
  options: { no_checks_ok?: boolean; paseo?: Parameters<typeof setup>[0]; dashboard?: Parameters<typeof setup>[1] } = {},
) {
  const github = new FakeGitHub();
  const { ForgeCli } = await import("../tracker/forge.ts");
  const s = await setup(options.paseo, { forge: new ForgeCli(github.runner()), reconcile: { host: "ergo-mbp" }, ...options.dashboard });
  writeRule(s.dashboard.dataDir, { space: "TST", project: "core", mode, no_checks_ok: options.no_checks_ok ?? false });
  const taskOf = (id: string) => s.task(id) as Task;
  /** A card of core, todo, with its PR linked and the given lines ticked. */
  const card = async (id: string, front: string, body?: Parameters<typeof cardFile>[3]) => {
    s.f.external("ergo", cardFile(id, id.toLowerCase(), front, body));
    await s.sync().sync();
  };
  const pass = () => s.dashboard.reconciler.pass();
  const space = () => s.dashboard.spaces.get("TST")!;
  return { ...s, github, card, pass, space, taskOf };
}
