import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, ForgeCli } from "../tracker/forge.ts";
import { IssueWriter } from "./forge-write.ts";

/** What the mirror sends to GitLab and GitHub, checked on the CLI's arguments and the request body. */

function recorder(answer: (args: string[]) => { code: number; stdout: string; stderr?: string }) {
  const calls: { command: string; args: string[]; body?: Record<string, unknown>; mode?: number }[] = [];
  const runner: CommandRunner = async (command, args) => {
    const at = args.indexOf("--input");
    const file = at > 0 ? args[at + 1]! : undefined;
    calls.push({
      command,
      args,
      ...(file ? { body: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, mode: statSync(file).mode & 0o777 } : {}),
    });
    return answer(args);
  };
  return { calls, cli: new ForgeCli(runner) };
}

const CONTENT = { title: "Dark mode", body: "Brief.", labels: ["ui", "a,b"], assignee: "anna", state: "open" as const };

test("GitLab: create, update and close go to the web host's API with the project path encoded", async () => {
  const { calls, cli } = recorder((args) => {
    if (args.some((a) => a.startsWith("users?username="))) return { code: 0, stdout: JSON.stringify([{ id: 42, username: "anna" }]) };
    return { code: 0, stdout: JSON.stringify({ iid: 3, web_url: "https://gitlab.example.com/frontend/site/-/issues/3" }) };
  });
  const dir = mkdtempSync(join(tmpdir(), "dashboard-write-"));
  const writer = new IssueWriter(cli, dir);
  const repo = { forge: "gitlab" as const, host: "gitlab.example.com", repo: "frontend/site" };

  const made = await writer.create(repo, CONTENT);
  assert.deepEqual(made, { ok: true, value: { url: "https://gitlab.example.com/frontend/site/-/issues/3" } });
  const create = calls.find((c) => c.args.includes("POST"))!;
  assert.deepEqual(create.args.slice(0, 6), ["api", "--hostname", "gitlab.example.com", "-X", "POST", "projects/frontend%2Fsite/issues"]);
  assert.deepEqual(create.body, { title: "Dark mode", description: "Brief.", labels: "ui", assignee_ids: [42] }, "a label with a comma stays off");
  assert.equal(create.mode, 0o600);
  assert.equal(existsSync(create.args[create.args.indexOf("--input") + 1]!), false, "the body file is gone after the call");

  await writer.update(made.ok ? made.value.url : "", { ...CONTENT, labels: [], assignee: "", state: "completed" });
  const update = calls.at(-1)!;
  assert.deepEqual(update.args.slice(0, 6), ["api", "--hostname", "gitlab.example.com", "-X", "PUT", "projects/frontend%2Fsite/issues/3"]);
  assert.deepEqual(update.body, { title: "Dark mode", description: "Brief.", labels: "", assignee_ids: [], state_event: "close" }, "no labels and no assignee are sent as such");

  await writer.update("https://gitlab.example.com/frontend/site/-/issues/3", CONTENT);
  assert.equal(calls.at(-1)!.body!.state_event, "reopen");
  assert.equal(calls.filter((c) => c.args.some((a) => a.startsWith("users?"))).length, 1, "the user id is read once");

  await writer.close("https://gitlab.example.com/frontend/site/-/issues/3", "Left over.");
  assert.deepEqual(calls.at(-1)!.body, { description: "Left over.", state_event: "close" });
});

test("GitHub: state reasons, and failures told apart", async () => {
  let reply = { code: 0, stdout: JSON.stringify({ number: 5, html_url: "https://github.com/acme/core/issues/5" }), stderr: "" };
  const { calls, cli } = recorder(() => reply);
  const writer = new IssueWriter(cli, mkdtempSync(join(tmpdir(), "dashboard-write-")));
  const repo = { forge: "github" as const, host: "github.com", repo: "acme/core" };

  assert.deepEqual(await writer.create(repo, CONTENT), { ok: true, value: { url: "https://github.com/acme/core/issues/5" } });
  assert.deepEqual(calls[0]!.args.slice(0, 4), ["api", "-X", "POST", "repos/acme/core/issues"]);
  assert.deepEqual(calls[0]!.body, { title: "Dark mode", body: "Brief.", labels: ["ui", "a,b"], assignees: ["anna"] });

  await writer.update("https://github.com/acme/core/issues/5", { ...CONTENT, state: "not_planned" });
  assert.deepEqual(calls.at(-1)!.args.slice(0, 4), ["api", "-X", "PATCH", "repos/acme/core/issues/5"]);
  assert.equal(calls.at(-1)!.body!.state, "closed");
  assert.equal(calls.at(-1)!.body!.state_reason, "not_planned");
  await writer.update("https://github.com/acme/core/issues/5", { ...CONTENT, assignee: "--evil" });
  assert.deepEqual(calls.at(-1)!.body!.assignees, [], "a login that is no login is not sent");

  reply = { code: 1, stdout: "", stderr: "gh: API rate limit exceeded for user (HTTP 403)" };
  const rate = await writer.create(repo, CONTENT);
  assert.equal(!rate.ok && rate.kind, "rate");
  reply = { code: 1, stdout: "", stderr: "gh: Validation Failed (HTTP 422)" };
  const invalid = await writer.create(repo, CONTENT);
  assert.equal(!invalid.ok && invalid.kind, "invalid");
  const calls0 = calls.length;
  for (const path of ["acme/x;y", "acme/../user", "./x"]) assert.equal((await writer.create({ ...repo, repo: path }, CONTENT)).ok, false, path);
  assert.equal(calls.length, calls0, "a path the CLIs are not given makes no call");
});

test("GitLab: a user lookup that fails writes nothing, and a marker quoted in a body is not the issue's own", async () => {
  let users = { code: 1, stdout: "", stderr: "glab: connection refused" };
  const { calls, cli } = recorder((args) => {
    if (args.some((a) => a.startsWith("users?username="))) return users;
    if (args.some((a) => a.includes("/issues?"))) {
      return {
        code: 0,
        stdout: JSON.stringify([
          { iid: 1, description: "Quoted:\n> <!-- paseo-dashboard mirror TST/TST-AAAAA -->\nMore.", web_url: "https://gitlab.example.com/frontend/site/-/issues/1" },
          { iid: 2, description: "Brief.\n\n<!-- paseo-dashboard mirror TST/TST-AAAAA -->\n", web_url: "https://gitlab.example.com/frontend/site/-/issues/2" },
        ]),
      };
    }
    return { code: 0, stdout: "{}" };
  });
  const writer = new IssueWriter(cli, mkdtempSync(join(tmpdir(), "dashboard-write-")));
  const repo = { forge: "gitlab" as const, host: "gitlab.example.com", repo: "frontend/site" };
  const failed = await writer.update("https://gitlab.example.com/frontend/site/-/issues/3", CONTENT);
  assert.equal(failed.ok, false);
  assert.equal(calls.filter((c) => c.args.includes("PUT")).length, 0, "not written without the assignee");
  users = { code: 0, stdout: "[]", stderr: "" };
  assert.equal((await writer.update("https://gitlab.example.com/frontend/site/-/issues/3", CONTENT)).ok, true, "no such user: written without one");
  assert.deepEqual(calls.at(-1)!.body!.assignee_ids, []);
  const found = await writer.find(repo, "<!-- paseo-dashboard mirror TST/TST-AAAAA -->", "2026-10-27T00:00:00.000Z");
  assert.deepEqual(found, { ok: true, value: "https://gitlab.example.com/frontend/site/-/issues/2" });
});
