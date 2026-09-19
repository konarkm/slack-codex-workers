import { z } from "zod";
import { spawnOnHost } from "../agents/hostSpawn.js";
import { RuntimeError, type AgentRuntime, type RuntimeInput, type RuntimeOptions, type RuntimeState, type TurnStatus } from "../agents/types.js";
import { CodexRpcClient, type RpcNotification, type RpcServerRequest } from "../codex/rpcClient.js";
import { logError, logInfo } from "../logger.js";

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
const toolCallSchema = z.object({ tool: z.string(), arguments: z.unknown().optional() });

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
      spawnOnHost({ host: spec.host, command: this.codexBin, args: ["app-server"], cwd: spec.cwd }),
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
    rpc.on("stderr", (chunk) => logError("codex stderr", { agent: spec.name, chunk: chunk.trim() }));
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
        await rpc.request("thread/resume", { threadId: this.threadId });
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
    const raw = await rpc.request("thread/start", {
      cwd: spec.cwd,
      model: spec.model ?? undefined,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: this.options.instructions,
      dynamicTools: this.options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(z.object(tool.shape)),
      })),
    });
    this.threadId = threadResponseSchema.parse(raw).thread.id;
    await events.onSessionChanged(this.threadId);
    logInfo("codex thread started", { agent: spec.name, threadId: this.threadId });
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
      case "item/tool/call": {
        const call = toolCallSchema.parse(params);
        const tool = this.options.tools.find((candidate) => candidate.name === call.tool);
        if (!tool) {
          await rpc.respond(request.id, { contentItems: [{ type: "inputText", text: `Unknown tool: ${call.tool}` }], success: false });
          return;
        }
        try {
          const args = z.object(tool.shape).parse(call.arguments ?? {});
          const text = await tool.handler(args);
          await rpc.respond(request.id, { contentItems: [{ type: "inputText", text }], success: true });
        } catch (error) {
          await rpc.respond(request.id, { contentItems: [{ type: "inputText", text: `Error: ${errorMessage(error)}` }], success: false });
        }
        return;
      }
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
