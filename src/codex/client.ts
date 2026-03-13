import { z } from "zod";
import { DEFAULT_EFFORTS } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import type { JsonRpcId, ReasoningEffort, RuntimeSettings, TurnInput, WorklogItem } from "../types.js";
import { CodexRpcClient, type RpcNotification, type RpcServerRequest } from "./rpcClient.js";
import {
  adminDeveloperInstructions,
  dynamicToolCallParamsSchema,
  slackListChannelsArgsSchema,
  slackListChannelsToolName,
  slackSpawnWorkerArgsSchema,
  slackSpawnWorkerToolName,
  workerDeveloperInstructions,
  workerDynamicTools,
} from "../core/dynamicTools.js";

const threadStartSchema = z.object({ thread: z.object({ id: z.string(), name: z.string().nullable().optional() }) });
const turnStartSchema = z.object({ turn: z.object({ id: z.string() }) });
const threadReadSchema = z.object({ thread: z.object({ id: z.string(), status: z.unknown().optional() }).passthrough() });

interface ActiveTurnState {
  threadId: string;
  handlers: TurnHandlers;
  assistantTextByItem: Map<string, string>;
  assistantItemOrder: string[];
}

export interface TurnHandlers {
  onAgentDelta(event: { itemId: string; delta: string }): void | Promise<void>;
  onAgentMessage(event: { itemId: string; text: string }): void | Promise<void>;
  onWorklogItem(event: WorklogItem): void | Promise<void>;
  onCompleted(event: { threadId: string; turnId: string; status: string; assistantText: string; error?: string | null }): void | Promise<void>;
}

export interface DynamicToolHandlerContext {
  threadId: string;
  turnId: string;
  callId: string;
}

export interface DynamicToolHandlers {
  listChannels(args: z.infer<typeof slackListChannelsArgsSchema>, ctx: DynamicToolHandlerContext): Promise<string>;
  spawnWorker(args: z.infer<typeof slackSpawnWorkerArgsSchema>, ctx: DynamicToolHandlerContext): Promise<string>;
}

export class CodexClient {
  private readonly rpc: CodexRpcClient;
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private dynamicToolHandlers: DynamicToolHandlers | null = null;

  constructor(codexBin: string, cwd: string) {
    this.rpc = new CodexRpcClient(codexBin, cwd, {
      name: "slack-codex-workers",
      title: "Slack Codex Workers",
      version: "0.1.0",
    });

    this.rpc.on("notification", (event: RpcNotification) => {
      void this.handleNotification(event);
    });
    this.rpc.on("request", (request: RpcServerRequest) => {
      void this.handleServerRequest(request);
    });
  }

  registerDynamicToolHandlers(handlers: DynamicToolHandlers): void {
    this.dynamicToolHandlers = handlers;
  }

  async start(): Promise<void> {
    await this.rpc.start();
  }

  async stop(): Promise<void> {
    this.activeTurns.clear();
    await this.rpc.stop();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async createWorkerThread(settings: RuntimeSettings): Promise<{ threadId: string; threadName: string | null }> {
    const raw = await this.rpc.request("thread/start", {
      model: settings.model ?? undefined,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      developerInstructions: workerDeveloperInstructions,
      dynamicTools: workerDynamicTools,
    });
    const parsed = threadStartSchema.parse(raw);
    return { threadId: parsed.thread.id, threadName: parsed.thread.name ?? null };
  }

  async createAdminThread(settings: RuntimeSettings): Promise<{ threadId: string; threadName: string | null }> {
    const raw = await this.rpc.request("thread/start", {
      model: settings.model ?? undefined,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      developerInstructions: adminDeveloperInstructions,
    });
    const parsed = threadStartSchema.parse(raw);
    return { threadId: parsed.thread.id, threadName: parsed.thread.name ?? null };
  }

  async forkWorkerThread(parentThreadId: string, settings: RuntimeSettings): Promise<{ threadId: string; threadName: string | null }> {
    await this.resumeThread(parentThreadId);
    const raw = await this.rpc.request("thread/fork", {
      threadId: parentThreadId,
      model: settings.model ?? undefined,
      persistExtendedHistory: true,
    });
    const parsed = threadStartSchema.parse(raw);
    return { threadId: parsed.thread.id, threadName: parsed.thread.name ?? null };
  }

  async startTurn(threadId: string, input: TurnInput, settings: RuntimeSettings, handlers: TurnHandlers): Promise<string> {
    const raw = await this.rpc.request("turn/start", {
      threadId,
      input: buildTurnInput(input),
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: settings.model ?? undefined,
      effort: settings.effort ?? undefined,
    });
    const parsed = turnStartSchema.parse(raw);
    this.activeTurns.set(parsed.turn.id, {
      threadId,
      handlers,
      assistantTextByItem: new Map<string, string>(),
      assistantItemOrder: [],
    });
    return parsed.turn.id;
  }

  async startTurnWithResumeFallback(threadId: string, input: TurnInput, settings: RuntimeSettings, handlers: TurnHandlers): Promise<string> {
    try {
      return await this.startTurn(threadId, input, settings, handlers);
    } catch (error) {
      if (!shouldRetryWithResume(error)) throw error;
    }
    await this.resumeThread(threadId);
    return this.startTurn(threadId, input, settings, handlers);
  }

  async steerTurn(threadId: string, turnId: string, input: TurnInput): Promise<void> {
    await this.rpc.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: buildTurnInput(input),
    });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.rpc.request("thread/compact/start", { threadId });
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.rpc.request("thread/resume", { threadId, persistExtendedHistory: true });
  }

  async readThreadStatus(threadId: string): Promise<string> {
    const raw = await this.rpc.request("thread/read", { threadId, includeTurns: false });
    const parsed = threadReadSchema.parse(raw);
    return normalizeThreadStatus(parsed.thread.status);
  }

  private async handleNotification(event: RpcNotification): Promise<void> {
    if (event.method === "item/agentMessage/delta") {
      const params = event.params as Record<string, unknown>;
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : "__default__";
      const delta = typeof params.delta === "string" ? params.delta : "";
      const active = this.activeTurns.get(turnId);
      if (!active || !delta) return;
      const existing = active.assistantTextByItem.get(itemId) ?? "";
      active.assistantTextByItem.set(itemId, `${existing}${delta}`);
      if (!active.assistantItemOrder.includes(itemId)) active.assistantItemOrder.push(itemId);
      await active.handlers.onAgentDelta({ itemId, delta });
      return;
    }

    if (event.method === "item/started" || event.method === "item/completed") {
      const params = event.params as Record<string, unknown>;
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      const active = this.activeTurns.get(turnId);
      if (!active) return;
      const item = params.item;
      const phase = event.method === "item/started" ? "started" : "completed";

      if (isAgentMessage(item) && typeof item.text === "string" && phase === "completed") {
        const itemId = typeof item.id === "string" ? item.id : "__default__";
        active.assistantTextByItem.set(itemId, item.text);
        if (!active.assistantItemOrder.includes(itemId)) active.assistantItemOrder.push(itemId);
        await active.handlers.onAgentMessage({ itemId, text: item.text });
        return;
      }

      const worklog = parseWorklogItem(item, phase);
      if (worklog) {
        await active.handlers.onWorklogItem(worklog);
      }
      return;
    }

    if (event.method === "turn/completed") {
      const params = event.params as Record<string, any>;
      const turnId = typeof params.turn?.id === "string" ? params.turn.id : "";
      const active = this.activeTurns.get(turnId);
      if (!active) return;
      this.activeTurns.delete(turnId);
      const assistantText = active.assistantItemOrder
        .map((itemId) => active.assistantTextByItem.get(itemId) ?? "")
        .filter(Boolean)
        .join("\n\n")
        .trim();
      await active.handlers.onCompleted({
        threadId: active.threadId,
        turnId,
        status: String(params.turn?.status ?? ""),
        assistantText,
        error: params.turn?.error?.message ?? params.turn?.error?.error?.message ?? null,
      });
    }
  }

  private async handleServerRequest(request: RpcServerRequest): Promise<void> {
    try {
      if (
        request.method === "item/commandExecution/requestApproval"
        || request.method === "item/fileChange/requestApproval"
        || request.method === "execCommandApproval"
        || request.method === "applyPatchApproval"
      ) {
        await this.rpc.respond(request.id, { decision: request.method.startsWith("item/") ? "accept" : "allow" });
        return;
      }

      if (request.method === "item/tool/requestUserInput") {
        await this.rpc.respond(request.id, { answers: {} });
        return;
      }

      if (request.method === "account/chatgptAuthTokens/refresh") {
        await this.rpc.respond(request.id, { accepted: true });
        return;
      }

      if (request.method === "item/tool/call") {
        await this.handleDynamicToolCall(request.id, request.params);
        return;
      }

      await this.rpc.respondError(request.id, -32601, `Unsupported server request method: ${request.method}`);
    } catch (error) {
      await this.rpc.respondError(request.id, -32603, error instanceof Error ? error.message : "Internal server request error");
    }
  }

  private async handleDynamicToolCall(id: JsonRpcId, params: unknown): Promise<void> {
    const parsed = dynamicToolCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      await this.rpc.respond(id, { contentItems: [{ type: "inputText", text: "Invalid dynamic tool call payload." }], success: false });
      return;
    }
    if (!this.dynamicToolHandlers) {
      await this.rpc.respond(id, { contentItems: [{ type: "inputText", text: "Dynamic tool handlers unavailable." }], success: false });
      return;
    }

    const ctx = {
      threadId: parsed.data.threadId,
      turnId: parsed.data.turnId,
      callId: parsed.data.callId,
    };

    if (parsed.data.tool === slackListChannelsToolName) {
      const args = slackListChannelsArgsSchema.parse(parsed.data.arguments);
      const text = await this.dynamicToolHandlers.listChannels(args, ctx);
      await this.rpc.respond(id, { contentItems: [{ type: "inputText", text }], success: true });
      return;
    }

    if (parsed.data.tool === slackSpawnWorkerToolName) {
      const args = slackSpawnWorkerArgsSchema.parse(parsed.data.arguments);
      const text = await this.dynamicToolHandlers.spawnWorker(args, ctx);
      await this.rpc.respond(id, { contentItems: [{ type: "inputText", text }], success: true });
      return;
    }

    await this.rpc.respond(id, { contentItems: [{ type: "inputText", text: `Unsupported dynamic tool: ${parsed.data.tool}` }], success: false });
  }
}

function buildTurnInput(input: TurnInput): Array<{ type: string; [key: string]: unknown }> {
  const items: Array<{ type: string; [key: string]: unknown }> = [
    { type: "text", text: input.text, textElements: [] },
  ];
  for (const imagePath of input.imagePaths ?? []) {
    items.push({ type: "localImage", path: imagePath });
  }
  return items;
}

function isAgentMessage(item: any): item is { id?: string; type: string; text: string } {
  return item && typeof item === "object" && item.type === "agentMessage" && typeof item.text === "string";
}

function normalizeThreadStatus(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "type" in status && typeof (status as { type?: unknown }).type === "string") {
    return (status as { type: string }).type;
  }
  return "";
}

function shouldRetryWithResume(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("thread not loaded")
    || message.includes("no active rollout found")
    || message.includes("no rollout found")
    || (message.includes("thread") && message.includes("not found"));
}

function parseWorklogItem(itemRaw: unknown, phase: "started" | "completed"): WorklogItem | null {
  if (!itemRaw || typeof itemRaw !== "object") return null;
  const item = itemRaw as Record<string, unknown>;
  const itemId = typeof item.id === "string" ? item.id : null;
  const type = typeof item.type === "string" ? item.type : null;
  if (!itemId || !type || type === "agentMessage" || type === "reasoning") return null;

  const started = phase === "started";
  const status = started ? "started" : hasFailure(item) ? "failed" : "completed";

  if (type === "commandExecution") {
    return {
      itemId,
      type,
      title: `Run command: ${String(item.command ?? "").slice(0, 100) || "command"}`,
      status,
      detail: !started ? summarizeCommandResult(item) : null,
    };
  }

  if (type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "mcp";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return {
      itemId,
      type,
      title: `MCP: ${server}/${tool}`,
      status,
      detail: !started ? summarizeResult(item.result) : null,
    };
  }

  if (type === "dynamicToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return {
      itemId,
      type,
      title: `Tool: ${tool}`,
      status,
      detail: !started ? summarizeResult(item.contentItems ?? item.result) : null,
    };
  }

  if (type === "contextCompaction") {
    return {
      itemId,
      type,
      title: "Compact context",
      status,
      detail: null,
    };
  }

  if (type === "fileChange") {
    return {
      itemId,
      type,
      title: "Apply file edits",
      status,
      detail: !started ? summarizeResult(item.changes) : null,
    };
  }

  return {
    itemId,
    type,
    title: prettifyItemType(type),
    status,
    detail: !started ? summarizeResult(item) : null,
  };
}

function hasFailure(item: Record<string, unknown>): boolean {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : 0;
  return status.includes("failed") || status.includes("declined") || Boolean(item.error) || exitCode !== 0;
}

function summarizeCommandResult(item: Record<string, unknown>): string | null {
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.trim() : "";
  if (output) {
    return truncateOneLine(output);
  }
  if (exitCode !== null) {
    return `exit ${exitCode}`;
  }
  return null;
}

function summarizeResult(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return truncateOneLine(value);
  try {
    return truncateOneLine(JSON.stringify(value));
  } catch {
    return null;
  }
}

function truncateOneLine(value: string, max = 140): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 13)} [truncated]`;
}

function prettifyItemType(type: string): string {
  return type
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isAllowedEffort(value: string | null): value is ReasoningEffort {
  return Boolean(value && DEFAULT_EFFORTS.includes(value as ReasoningEffort));
}
