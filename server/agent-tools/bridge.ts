import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { McpServerConfig, ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { RunRecord } from "../runner/runs.ts";
import { bridgeScript, TOOLS } from "./bridge-script.ts";
import type { PlanCaller } from "./plan.ts";

/**
 * The plugin's side of the agent tools (05-architecture.md, 2. The agent's own report): a Unix socket
 * in plugin-data (0600) that the bridge script talks to. A call carries its run's token; it is
 * answered only for that run's own task while the run is live, so an agent cannot read or change
 * any other task through it. The plan tools of any agent (server/agent-tools/plan.ts) come over the
 * same socket with a token of their own, which reaches only those tools.
 */

export interface ToolAnswer {
  ok: boolean;
  text: string;
}

export interface BridgeOptions {
  dataDir: string;
  /** The run a token belongs to. */
  runByToken: (token: string) => RunRecord | undefined;
  handle: (run: RunRecord, tool: string, args: unknown) => Promise<ToolAnswer>;
  /** The agent a plan-tools token was given to. */
  planByToken?: (token: string) => PlanCaller | undefined;
  handlePlan?: (caller: PlanCaller, tool: string, args: unknown) => Promise<ToolAnswer>;
  log?: (message: string) => void;
}

const PLAN_SESSION_UNKNOWN =
  "Paseo Dash does not know this session: the plugin restarted or the plan tools were turned off. They work again once the session reopens.";

const MAX_REQUEST = 64 * 1024;
/** A connection that sends nothing whole is closed; the real script gives up after 15 s anyway. */
const IDLE_MS = 30_000;

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Token comparison that does not leak how much of a guess was right. */
export function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AgentToolsBridge {
  readonly scriptPath: string;
  readonly socketPath: string;
  private server: Server | undefined;
  private readonly options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.scriptPath = join(options.dataDir, "agent-tools.mjs");
    this.socketPath = join(options.dataDir, "agent-tools.sock");
  }

  /** Writes the bridge script and listens on the socket; the owner lock makes this the only listener. */
  async start(): Promise<void> {
    if (this.server) return;
    const script = bridgeScript();
    if (!existsSync(this.scriptPath) || readFileSync(this.scriptPath, "utf8") !== script) {
      writeFileSync(this.scriptPath, script, { mode: 0o600 });
    }
    chmodSync(this.scriptPath, 0o600);
    rmSync(this.socketPath, { force: true });
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    server.on("error", (error) => this.options.log?.(`agent tools socket: ${error.message}`));
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    rmSync(this.socketPath, { force: true });
  }

  /** What `agents.create` gets for a run: the stdio server with its token, and both tools preapproved. */
  forRun(token: string): { server: McpServerConfig; policy: ToolPolicy } {
    return {
      server: {
        type: "stdio",
        command: process.execPath,
        args: [this.scriptPath],
        // The plugin worker may be Paseo's Electron helper; this makes it run the script as Node.
        env: { ELECTRON_RUN_AS_NODE: "1", DASHBOARD_SOCKET: this.socketPath, DASHBOARD_TOKEN: token },
        alwaysLoad: true,
      },
      policy: { preapproved: TOOLS.map((tool) => ({ kind: "mcp" as const, server: "dashboard", tool: tool.name })) },
    };
  }

  /** The plan tools' stdio server for one agent session; the agent's permission mode decides each call. */
  forPlan(token: string): McpServerConfig {
    return {
      type: "stdio",
      command: process.execPath,
      args: [this.scriptPath],
      env: { ELECTRON_RUN_AS_NODE: "1", DASHBOARD_SOCKET: this.socketPath, DASHBOARD_TOKEN: token, DASHBOARD_TOOLS: "plan" },
    };
  }

  /** One request line per connection, one answer, then the connection is closed. */
  private serve(socket: Socket): void {
    let buffer = "";
    let done = false;
    const answer = (reply: ToolAnswer) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(reply)}\n`, () => socket.destroy());
    };
    socket.setEncoding("utf8");
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) {
        done = true;
        buffer = "";
        return answer({ ok: false, text: "The request is too large." });
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      done = true;
      const line = buffer.slice(0, end);
      buffer = "";
      void this.reply(line).then(answer, (error: unknown) => answer({ ok: false, text: `Paseo Dash could not do it: ${(error as Error).message}` }));
    });
  }

  private async reply(line: string): Promise<ToolAnswer> {
    let request: { token?: unknown; tool?: unknown; args?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      return { ok: false, text: "The request is not JSON." };
    }
    const token = typeof request.token === "string" ? request.token : undefined;
    const tool = String(request.tool ?? "");
    const run = token ? this.options.runByToken(token) : undefined;
    if (run) return this.options.handle(run, tool, request.args ?? {});
    const caller = token ? this.options.planByToken?.(token) : undefined;
    if (caller && this.options.handlePlan) return this.options.handlePlan(caller, tool, request.args ?? {});
    if (tool.startsWith("plan_")) return { ok: false, text: PLAN_SESSION_UNKNOWN };
    return { ok: false, text: "This agent is not a Paseo Dash run (unknown token)." };
  }
}
