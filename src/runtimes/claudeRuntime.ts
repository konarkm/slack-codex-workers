import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawnOnHost } from "../agents/hostSpawn.js";
import { logError, logInfo } from "../logger.js";
import type { AgentRuntime, RuntimeInput, RuntimeOptions, RuntimeState } from "../agents/types.js";

export const AGENT_TOOL_SERVER = "workspace";

const IMAGE_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("input queue is closed");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.items.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

// One named agent = one streaming-input Claude session that stays open and is resumed by id across restarts.
export class ClaudeRuntime implements AgentRuntime {
  private session: Query | null = null;
  private input: InputQueue | null = null;
  private currentState: RuntimeState = "down";
  private currentSessionId: string | null;
  private pendingWakes = 0;
  private lastAssistantText = "";
  private stopping = false;
  private resumeRejected = false;

  constructor(private readonly options: RuntimeOptions) {
    this.currentSessionId = options.sessionId;
  }

  state(): RuntimeState {
    return this.currentState;
  }

  sessionId(): string | null {
    return this.currentSessionId;
  }

  async start(): Promise<void> {
    if (this.session) return;
    this.stopping = false;
    const input = new InputQueue();
    const session = query({ prompt: input, options: this.buildOptions() });
    this.input = input;
    this.session = session;
    this.pendingWakes = 0;
    await this.setState("idle");
    void this.consume(session, input);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.input?.close();
    this.session?.close();
    this.session = null;
    this.input = null;
    await this.setState("down");
  }

  async deliver(input: RuntimeInput): Promise<void> {
    await this.start();
    const message = await this.buildUserMessage(input);
    this.pendingWakes += 1;
    await this.setState("running");
    this.input!.push(message);
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt();
  }

  async compact(): Promise<void> {
    await this.deliver({ text: "/compact", imagePaths: [], priority: "next" });
  }

  private buildOptions(): Options {
    const { spec, tools, instructions } = this.options;
    const server = createSdkMcpServer({
      name: AGENT_TOOL_SERVER,
      tools: tools.map((definition) =>
        tool(definition.name, definition.description, definition.shape, async (args) => {
          try {
            const text = await definition.handler(args as never);
            return { content: [{ type: "text", text }] };
          } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
          }
        }, { alwaysLoad: true }),
      ),
    });
    const remote = spec.host.kind === "ssh";
    return {
      cwd: remote ? undefined : spec.cwd,
      model: spec.model ?? undefined,
      effort: (spec.effort as Options["effort"]) ?? undefined,
      resume: this.currentSessionId ?? undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
      // An agent's capabilities are its own unless the spec opts in to the operator's user-level setup and cloud connectors.
      settingSources: spec.inheritUserConfig ? ["user", "project", "local"] : ["project", "local"],
      strictMcpConfig: !spec.inheritUserConfig,
      settings: spec.inheritUserConfig ? undefined : { disableClaudeAiConnectors: true },
      mcpServers: { [AGENT_TOOL_SERVER]: server },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      title: spec.name,
      stderr: (data) => {
        if (/No conversation found with session ID/i.test(data)) this.resumeRejected = true;
      },
      spawnClaudeCodeProcess: remote ? (spawnOptions) => this.spawnRemote(spawnOptions) : undefined,
    };
  }

  // The SDK hands us its local CLI path; on another machine the agent uses that machine's own `claude` and login.
  private spawnRemote(spawnOptions: SpawnOptions): SpawnedProcess {
    const runsScript = /(^|\/)(node|bun|deno)$/.test(spawnOptions.command);
    const args = runsScript ? spawnOptions.args.slice(1) : spawnOptions.args;
    const env = Object.fromEntries(
      Object.entries(spawnOptions.env).filter(([key]) => /^CLAUDE_(CODE|AGENT)_/.test(key) && !/TOKEN|KEY|SECRET/.test(key)),
    );
    const child = spawnOnHost({
      host: this.options.spec.host,
      command: "claude",
      args,
      cwd: this.options.spec.cwd,
      env,
      signal: spawnOptions.signal,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => logError("claude remote stderr", { agent: this.options.spec.name, chunk: chunk.trim() }));
    return child;
  }

  private async buildUserMessage(input: RuntimeInput): Promise<SDKUserMessage> {
    const images = [];
    for (const imagePath of input.imagePaths) {
      const mediaType = IMAGE_MEDIA_TYPES[path.extname(imagePath).toLowerCase()];
      if (!mediaType) continue;
      const data = (await fs.readFile(imagePath)).toString("base64");
      images.push({ type: "image" as const, source: { type: "base64" as const, media_type: mediaType, data } });
    }
    return {
      type: "user",
      message: { role: "user", content: images.length > 0 ? [{ type: "text", text: input.text }, ...images] : input.text },
      parent_tool_use_id: null,
      // Without a uuid the result never echoes which messages a turn consumed; without an origin the CLI treats the message as unattributed.
      uuid: randomUUID(),
      origin: { kind: "human" },
      priority: input.priority,
      timestamp: new Date().toISOString(),
    };
  }

  private async consume(session: Query, input: InputQueue): Promise<void> {
    const { events, spec } = this.options;
    try {
      for await (const message of session) {
        try {
          await this.handleMessage(message);
        } catch (error) {
          // A failing observer must not take the agent's session down with it.
          logError("claude message handling failed", { agent: spec.name, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      if (!this.stopping) {
        logError("claude session ended with error", { agent: spec.name, error: error instanceof Error ? error.message : String(error) });
        await events.onTurnCompleted({ status: "failed", finalText: "", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.session === session) {
        this.session = null;
        this.input = null;
        input.close();
        await this.setState("down");
      }
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    const { events, spec } = this.options;
    if (message.type === "system" && message.subtype === "init") {
      if (message.session_id !== this.currentSessionId) {
        this.currentSessionId = message.session_id;
        await events.onSessionChanged(message.session_id);
      }
      logInfo("claude session ready", { agent: spec.name, sessionId: message.session_id, model: message.model });
      // A tool schema the harness cannot serve makes it drop every bridge tool without an error, leaving the agent mute.
      const missing = this.options.tools.map((definition) => `mcp__${AGENT_TOOL_SERVER}__${definition.name}`).filter((name) => !message.tools.includes(name));
      if (missing.length > 0) {
        const problem = `The harness is not serving ${missing.length} of ${this.options.tools.length} bridge tools (first: ${missing[0]}). The agent may be unable to speak.`;
        logError(problem, { agent: spec.name });
        await events.onProblem(problem);
      }
      return;
    }
    if (message.type === "system" && message.subtype === "session_state_changed") {
      if (message.state === "running") await this.setState("running");
      return;
    }
    if (message.type === "system" && message.subtype === "status") {
      if (message.status === "compacting") await events.onCompaction({ status: "started" });
      if (message.compact_result) await events.onCompaction({ status: message.compact_result === "success" ? "completed" : "failed" });
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      await events.onCompaction({ status: "completed" });
      return;
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) this.lastAssistantText = block.text;
        if (block.type === "tool_use") {
          await events.onActivity({ id: block.id, title: block.name, status: "started", detail: null });
        }
      }
      return;
    }
    if (message.type === "result" && this.resumeRejected && this.currentSessionId) {
      // The transcript for the saved session is gone (moved host, pruned history). Forget it; the retry starts a new session.
      this.resumeRejected = false;
      const lost = this.currentSessionId;
      this.currentSessionId = null;
      await events.onSessionChanged(null);
      await events.onProblem(`Claude session ${lost} could not be resumed; its transcript is missing. The next input starts a new session.`);
      await events.onTurnCompleted({ status: "failed", finalText: "", error: `session ${lost} could not be resumed` });
      this.session?.close();
      return;
    }
    if (message.type === "result") {
      const finalText = message.subtype === "success" ? message.result : this.lastAssistantText;
      this.lastAssistantText = "";
      const queued = message.queued_turn_count ?? 0;
      this.pendingWakes = Math.min(Math.max(this.pendingWakes - 1, 0), queued);
      const interrupted = message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";
      const failed = message.subtype !== "success" || message.is_error;
      await events.onTurnCompleted({
        status: interrupted ? "interrupted" : failed ? "failed" : "completed",
        finalText,
        error: message.subtype === "success" ? (message.is_error ? message.result : null) : message.errors.join("; "),
      });
      if (queued === 0) await this.setState("idle");
    }
  }

  private async setState(state: RuntimeState): Promise<void> {
    if (this.currentState === state) return;
    this.currentState = state;
    await this.options.events.onStateChanged(state);
  }
}
