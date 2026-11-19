import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTask } from "../api/reads.ts";
import { setup } from "../api/testing.ts";
import { releaseTask, startTask } from "../api/writes.ts";
import { settled } from "../runner/testing.ts";

const PROFILE = { id: "p1", name: "Review", provider: "claude", model: "claude-haiku-5-5", modeId: "default" };

/** The bridge script as an agent runs it: a child process spoken to over MCP stdio. */
function agentSide(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: unknown = {}) => {
    const answer = await request("tools/call", { name, arguments: args });
    return { text: answer.result.content[0].text as string, isError: answer.result.isError as boolean };
  };
  return { request, call, close: () => child.kill() };
}

async function startedWithTools() {
  const s = await setup({ profiles: [PROFILE] });
  await startTask(s.ctx, { task: "TST-FX001", profile: "Review" });
  const run = s.dashboard.runs!.byTask("TST-FX001")!;
  await settled(() => run.activity !== "launching");
  const server = ([...s.fake.agents.values()][0]!.request.config as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }).mcpServers.dashboard!;
  return { s, run, agent: agentSide(server.args[0]!, server.env), env: server.env };
}

test("an agent reads its brief and reports through the bridge: ticks, progress, review", async () => {
  const { s, run, agent } = await startedWithTools();
  try {
    const init = await agent.request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    const listed = await agent.request("tools/list");
    assert.deepEqual(listed.result.tools.map((t: { name: string }) => t.name), ["task_brief", "task_report"]);

    const brief = await agent.call("task_brief");
    assert.equal(brief.isError, false);
    assert.match(brief.text, /^TST-FX001 · Fix flaky login test\nStatus: in_progress · branch feat\/login/);
    assert.match(brief.text, /1\. \[x\] first\n2\. \[ \] second/);

    const report = await agent.call("task_report", { note: "second line works", done: [2], state: "done" });
    assert.equal(report.isError, false, report.text);
    assert.match(report.text, /2 of 2 acceptance lines done\. The task is now review\./);
    const read = getTask(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([read.status, read.progress], ["review", "2 of 2 · second line works"]);
    assert.deepEqual(read.acceptance.map((a) => a.done), [true, true]);

    const unknown = await agent.call("task_report", { done: ["no such line"], state: "working" });
    assert.match(unknown.text, /no acceptance line «no such line»/);
    const bad = await agent.call("task_report", { state: "finished" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /^Not recorded: state/);

    const pr = await agent.call("task_report", { pr_url: "https://github.com/acme/core/pull/7" });
    assert.match(pr.text, /merge request link is noted/);
    assert.equal(run.reportedPr, "https://github.com/acme/core/pull/7");
    await s.sync().sync();
    assert.match(await s.remoteFile(/TST-FX001-/) ?? "", /status: review/);
  } finally {
    agent.close();
    s.stop();
  }
});

test("the bridge answers only a live run's own token, and survives the plugin restarting", async () => {
  const { s, agent, env } = await startedWithTools();
  try {
    const stranger = agentSide(s.dashboard.bridge!.scriptPath, { ...env, DASHBOARD_TOKEN: "guessed" });
    const refused = await stranger.call("task_brief");
    stranger.close();
    assert.deepEqual([refused.isError, refused.text], [true, "This agent is not a Paseo Dash run (unknown token)."]);

    // A reload: the socket goes away and comes back at the same path; the same agent keeps working.
    s.dashboard.bridge!.stop();
    const down = await agent.call("task_brief");
    assert.equal(down.isError, true);
    assert.match(down.text, /not reachable right now/);
    await s.dashboard.bridge!.start();
    assert.equal((await agent.call("task_brief")).isError, false);

    await releaseTask(s.ctx, { task: "TST-FX001", to: "todo" });
    const ended = await agent.call("task_report", { note: "late" });
    assert.match(ended.text, /no longer holds the task/);
    assert.equal(getTask(s.ctx, { task: "TST-FX001" }).progress.includes("late"), false);
  } finally {
    agent.close();
    s.stop();
  }
});

test("the bridge script keeps characters whole when an answer arrives in pieces split inside one", async () => {
  const { createServer } = await import("node:net");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { bridgeScript } = await import("./bridge-script.ts");
  const dir = mkdtempSync(join(tmpdir(), "dashboard-bridge-"));
  const script = join(dir, "agent-tools.mjs");
  writeFileSync(script, bridgeScript());
  const socketPath = join(dir, "s.sock");
  const reply = Buffer.from(`${JSON.stringify({ ok: true, text: "Бриф: зроби «це»" })}\n`);
  const cut = reply.indexOf(Buffer.from("Б")) + 1; // inside the two bytes of «Б»
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(reply.subarray(0, cut));
      setTimeout(() => socket.end(reply.subarray(cut)), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const agent = agentSide(script, { DASHBOARD_SOCKET: socketPath, DASHBOARD_TOKEN: "t" });
  try {
    assert.equal((await agent.call("task_brief")).text, "Бриф: зроби «це»");
  } finally {
    agent.close();
    server.close();
  }
});

test("an oversized request is answered once and its connection closed", async () => {
  const { s, agent } = await startedWithTools();
  agent.close();
  const { createConnection } = await import("node:net");
  try {
    const socket = createConnection(s.dashboard.bridge!.socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (received += chunk));
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("error", () => undefined);
    socket.write("x".repeat(70 * 1024));
    await closed;
    assert.equal(received, `${JSON.stringify({ ok: false, text: "The request is too large." })}\n`);
  } finally {
    s.stop();
  }
});

test("a report made while the plan is busy is queued whole: ticks, note and the move to review all land", async () => {
  const { s, run, agent } = await startedWithTools();
  agent.close();
  const { handleTool } = await import("./tools.ts");
  try {
    const sync = s.sync();
    const real = sync.record.bind(sync);
    // The plan stays busy: the operations are journaled, but their outcome does not come in time.
    sync.record = (ops) => ({ ...real(ops), outcomes: new Promise(() => undefined) });
    const answer = await handleTool(s.dashboard, run, "task_report", { done: [2], state: "done", note: "all done" }, { waitMs: 20 });
    assert.match(answer.text, /queued/);
    sync.record = real;
    await sync.sync();
    const read = getTask(s.ctx, { task: "TST-FX001" });
    assert.deepEqual([read.status, read.progress], ["review", "2 of 2 · all done"]);
  } finally {
    s.stop();
  }
});
