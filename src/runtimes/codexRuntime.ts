import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { spawnOnHost } from "../agents/hostSpawn.js";
import { RuntimeError, type AgentRuntime, type RuntimeInput, type RuntimeOptions, type RuntimeState, type TurnStatus } from "../agents/types.js";
import { CodexRpcClient, type RpcNotification, type RpcServerRequest } from "../codex/rpcClient.js";
import { logError, logInfo } from "../logger.js";
import { TOOL_SERVER_NAME, TOOL_TOKEN_ENV } from "../agents/toolServer.js";

export interface CodexRpc {
  start(): Promise<void>;
  stop(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  respond(id: string | number, result: unknown): Promise<void>;
  respondError(id: string | number, code: number, message: string): Promise<void>;
  on(event: "notification", listener: (event: RpcNotification) => void): unknown;
  on(event: "request", listener: (event: RpcServerRequest) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  on(event: "stderr", listener: (chunk: string) => void): unknown;
}

const threadResponseSchema = z.object({ thread: z.object({ id: z.string() }) });
const turnResponseSchema = z.object({ turn: z.object({ id: z.string() }) });

const CODEX_APPS_SERVER = "codex_apps";

const CLIENT_INFO = { name: "slack-agents", title: "Slack Agents", version: "0.2.0" };

// One named agent = one Codex app-server thread. The agent gets its own app-server process so it can live on any host.
export class CodexRuntime implements AgentRuntime {
  private rpc: CodexRpc | null = null;
  private threadId: string | null;
  private activeTurnId: string | null = null;
  private currentState: RuntimeState = "down";
  private lastAgentText = "";
  private starting: Promise<void> | null = null;
  // Turn ids already seen to complete, so a late turn/start response cannot mark a finished turn as running.
  private readonly completedTurnIds = new Set<string>();
  private resumeFailures = 0;
  // Inputs taken by the current turn (the one that started it and any steered in).
  private turnInputIds: string[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: RuntimeOptions,
    private readonly codexBin = "codex",
    private readonly createRpc?: () => CodexRpc,
  ) {
    this.threadId = options.sessionId;
  }

  state(): RuntimeState {
    return this.currentState;
  }

  sessionId(): string | null {
    return this.threadId;
  }

  start(): Promise<void> {
    if (this.rpc && this.currentState !== "down") return Promise.resolve();
    this.starting ??= this.startInner().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = null;
    this.activeTurnId = null;
    await rpc?.stop();
    await this.setState("down");
  }

  async deliver(input: RuntimeInput): Promise<void> {
    await this.start();
    const items = [
      { type: "text", text: input.text, text_elements: [] },
      // Local paths only resolve on the agent's own host.
      ...(this.options.spec.host.kind === "local" ? input.imagePaths.map((path) => ({ type: "localImage", path })) : []),
    ];
    if (this.activeTurnId) {
      try {
        await this.rpc!.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: items });
        if (input.id) this.turnInputIds.push(input.id);
        return;
      } catch (error) {
        // A timeout leaves the outcome unknown; sending the input again as a new turn could make the agent answer twice.
        if (classifyCodexError(error) === "transient") throw error;
        // Otherwise the turn ended between our last notification and this call; start a new one.
        logInfo("codex steer fell through to a new turn", { agent: this.options.spec.name, error: errorMessage(error) });
        this.activeTurnId = null;
      }
    }
    let startedId: string;
    if (input.id) this.turnInputIds.push(input.id);
    try {
      const raw = await this.rpc!.request("turn/start", {
        threadId: this.threadId,
        input: items,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: this.options.spec.model ?? undefined,
        effort: this.options.spec.effort ?? undefined,
      });
      startedId = turnResponseSchema.parse(raw).turn.id;
    } catch (error) {
      // If a turn/started notification arrived while the request was failing, the turn is running and the input was taken.
      if (this.activeTurnId) return;
      this.turnInputIds = this.turnInputIds.filter((id) => id !== input.id);
      throw error;
    }
    // A fast turn can finish before this response is handled.
    if (this.completedTurnIds.has(startedId)) return;
    this.activeTurnId = startedId;
    await this.setState("running");
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.activeTurnId) return;
    await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
  }

  async compact(): Promise<void> {
    await this.start();
    await this.rpc!.request("thread/compact/start", { threadId: this.threadId });
  }

  private async startInner(): Promise<void> {
    const { spec } = this.options;
    const rpc = this.createRpc?.() ?? new CodexRpcClient(this.codexBin, spec.cwd, CLIENT_INFO, () =>
      spawnOnHost({ host: spec.host, command: this.codexBin, args: ["app-server", ...this.toolServerArgs(), ...this.denyArgs()], cwd: spec.cwd, env: this.spawnEnv() }),
    );
    rpc.on("notification", (event) => {
      this.chain = this.chain.then(() => this.handleNotification(event)).catch((error) => {
        logError("codex notification handling failed", { agent: spec.name, error: errorMessage(error) });
      });
    });
    rpc.on("request", (event) => {
      void this.handleServerRequest(rpc, event).catch((error) => {
        logError("codex server request failed", { agent: spec.name, method: event.method, error: errorMessage(error) });
      });
    });
    rpc.on("stderr", (chunk) => logInfo("codex stderr", { agent: spec.name, chunk: chunk.trim().slice(0, 300) }));
    rpc.on("exit", () => {
      if (this.rpc !== rpc) return;
      this.rpc = null;
      const wasRunning = this.activeTurnId !== null;
      this.activeTurnId = null;
      void (async () => {
        if (wasRunning) await this.options.events.onTurnCompleted({ status: "failed", finalText: "", error: "codex app-server exited mid-turn", consumedInputIds: this.takeTurnInputs(), inputFault: false });
        await this.setState("down");
      })();
    });
    await rpc.start();
    this.rpc = rpc;
    try {
      await this.openThread(rpc);
    } catch (error) {
      // Leave nothing half-started behind; the next attempt spawns a fresh app-server.
      this.rpc = null;
      await rpc.stop().catch(() => {});
      throw error;
    }
    await this.setState("idle");
  }

  private async openThread(rpc: CodexRpc): Promise<void> {
    const { spec, events } = this.options;
    if (this.threadId) {
      try {
        // Instructions and policy are sent again on resume, so changes to them reach an existing thread.
        await rpc.request("thread/resume", { threadId: this.threadId, ...this.threadSettings() });
        this.resumeFailures = 0;
        logInfo("codex thread resumed", { agent: spec.name, threadId: this.threadId });
        return;
      } catch (error) {
        this.resumeFailures += 1;
        // Codex words this failure differently across versions, so repeated failures of any kind also give up on the thread.
        if (classifyCodexError(error) !== "session_missing" && this.resumeFailures < 3) throw error;
        logError("codex thread cannot be resumed; starting a new one", { agent: spec.name, threadId: this.threadId, error: errorMessage(error) });
        await events.onProblem(`Codex thread ${this.threadId} could not be resumed (${errorMessage(error)}). A new thread was started.`);
        this.resumeFailures = 0;
      }
    }
    const raw = await rpc.request("thread/start", this.threadSettings());
    this.threadId = threadResponseSchema.parse(raw).thread.id;
    await events.onSessionChanged(this.threadId);
    logInfo("codex thread started", { agent: spec.name, threadId: this.threadId });
  }

  // An agent that does not inherit the operator's setup gets its own Codex home: the operator's login, and nothing else
  // (no MCP servers, no user instructions; the app connectors are switched off separately, since they follow the login).
  // Local agents only; a remote host keeps its own home.
  private spawnEnv(): Record<string, string> {
    const { spec } = this.options;
    const env: Record<string, string> = { [TOOL_TOKEN_ENV]: this.options.toolAccess.token };
    if (spec.inheritUserConfig || spec.host.kind !== "local") return env;
    const home = this.codexHome();
    fs.mkdirSync(home, { recursive: true });
    const link = path.join(home, "auth.json");
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(operatorCodexHome(), "auth.json"), link);
    return { ...env, CODEX_HOME: home };
  }

  // The bridge's tools reach Codex as an MCP server it reads from config at every session start, so a tool added
  // later is there on the next wake. Passed as overrides: nothing is written into any config file.
  private toolServerArgs(): string[] {
    return codexToolServerArgs(this.options.toolAccess.url);
  }

  // Where this agent's Codex keeps its state on this machine.
  private codexHome(): string {
    const { spec } = this.options;
    return spec.inheritUserConfig ? operatorCodexHome() : path.join(spec.cwd, ".codex-home");
  }

  private denyArgs(): string[] {
    const { spec } = this.options;
    // An isolated agent has no configured servers; the app connectors follow the login, so they are always switched off for it.
    if (!spec.inheritUserConfig) return codexDenyArgs([`mcp__${CODEX_APPS_SERVER}`], []);
    // On another machine the config cannot be read from here, so only the app connectors can be denied safely.
    const configured = spec.host.kind === "local" ? configuredCodexServers(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")) : [];
    return codexDenyArgs(spec.denyTools, configured);
  }

  private threadSettings(): Record<string, unknown> {
    const { spec } = this.options;
    return {
      cwd: spec.cwd,
      model: spec.model ?? undefined,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: this.options.instructions,
    };
  }

  private async handleNotification(event: RpcNotification): Promise<void> {
    const params = (event.params ?? {}) as Record<string, unknown>;
    if (params.threadId !== this.threadId) return;
    const { events } = this.options;
    if (event.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurnId = turn.id;
      await this.setState("running");
      return;
    }
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = params.item as { id?: string; type?: string; text?: string; status?: string; tool?: string; command?: string } | undefined;
      if (!item?.type) return;
      const phase = event.method === "item/started" ? "started" : "completed";
      if (item.type === "contextCompaction") {
        await events.onCompaction({ status: phase });
        return;
      }
      if (item.type === "agentMessage") {
        if (phase === "completed" && typeof item.text === "string") this.lastAgentText = item.text;
        return;
      }
      if (item.type === "userMessage" || item.type === "reasoning") return;
      await events.onActivity({
        id: item.id ?? "",
        title: item.tool ?? item.command ?? item.type,
        status: phase === "started" ? "started" : item.status === "failed" ? "failed" : "completed",
        detail: null,
      });
      return;
    }
    if (event.method === "turn/completed") {
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
      if (turn?.id && this.activeTurnId && turn.id !== this.activeTurnId) return;
      if (turn?.id) {
        this.completedTurnIds.add(turn.id);
        if (this.completedTurnIds.size > 50) this.completedTurnIds.delete(this.completedTurnIds.values().next().value!);
      }
      this.activeTurnId = null;
      const status: TurnStatus = turn?.status === "completed" ? "completed" : turn?.status === "interrupted" ? "interrupted" : "failed";
      const finalText = this.lastAgentText;
      this.lastAgentText = "";
      await events.onTurnCompleted({ status, finalText, error: status === "failed" ? (turn?.error?.message ?? "turn failed") : null, consumedInputIds: this.takeTurnInputs(), inputFault: false });
      await this.setState("idle");
    }
  }

  private async handleServerRequest(rpc: CodexRpc, request: RpcServerRequest): Promise<void> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        await rpc.respond(request.id, { decision: "accept" });
        return;
      case "item/permissions/requestApproval":
        await rpc.respond(request.id, { permissions: params.permissions ?? {}, scope: "session" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        await rpc.respond(request.id, { decision: "approved_for_session" });
        return;
      default:
        await rpc.respondError(request.id, -32601, `Unsupported server request method: ${request.method}`);
    }
  }

  private takeTurnInputs(): string[] {
    const ids = this.turnInputIds;
    this.turnInputIds = [];
    return ids;
  }

  private async setState(state: RuntimeState): Promise<void> {
    if (this.currentState === state) return;
    this.currentState = state;
    await this.options.events.onStateChanged(state);
  }
}

// Codex has no per-tool deny list, so a denied MCP server is switched off for the agent's whole app-server process.
// The ChatGPT app connectors (Slack, mail, payments, and the rest) follow the login, not the config, and come as one
// built-in server; denying it turns the feature off.
// Codex refuses to start if an override names a server its config does not define, so only configured servers are named.
// TOML values for the override flags; the URL is a plain string and the token comes from the environment, never argv.
// Bridge tools can run long (a workspace search, a large upload), so the per-call timeout is well above Codex's default.
export function codexToolServerArgs(url: string): string[] {
  const key = `mcp_servers.${TOOL_SERVER_NAME}`;
  return ["-c", `${key}.url=${JSON.stringify(url)}`, "-c", `${key}.bearer_token_env_var=${JSON.stringify(TOOL_TOKEN_ENV)}`, "-c", `${key}.tool_timeout_sec=900`];
}

export function codexDenyArgs(denyTools: string[], configuredServers: string[]): string[] {
  const servers = denyTools.map((entry) => /^mcp__([A-Za-z0-9_-]+)$/.exec(entry)?.[1]).filter((name): name is string => Boolean(name));
  return servers.flatMap((name) =>
    name === CODEX_APPS_SERVER ? ["-c", "features.apps=false"] : configuredServers.includes(name) ? ["-c", `mcp_servers.${name}.enabled=false`] : [],
  );
}

// The MCP servers a Codex home defines, read from its config file's table headers.
export function configuredCodexServers(codexHome: string): string[] {
  try {
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    return [...config.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm)].map((match) => match[1] ?? match[2]!);
  } catch {
    return [];
  }
}

function operatorCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

// Codex reports these conditions only as English error text.
export function classifyCodexError(error: unknown): RuntimeError["kind"] {
  const message = errorMessage(error).toLowerCase();
  if (/no (active )?rollout found|no thread found|thread .*(not found|does not exist)/.test(message)) return "session_missing";
  if (/unauthorized|not logged in|authenticat|401/.test(message)) return "auth";
  if (/timed out|thread is closing|not loaded/.test(message)) return "transient";
  return "fatal";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
