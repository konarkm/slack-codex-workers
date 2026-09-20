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

const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

// Turn failures caused by what was sent in, as opposed to the provider, the login, or the harness.
const INPUT_FAULT_REASONS = new Set(["image_error", "prompt_too_long"]);

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
  // Messages pushed to the session and not yet reported as consumed by a finished turn: message uuid → input id.
  private readonly unconfirmed = new Map<string, string | null>();
  private lastAssistantText = "";
  private stopping = false;

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
    this.unconfirmed.clear();
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
    this.unconfirmed.set(message.uuid!, input.id);
    await this.setState("running");
    this.input!.push(message);
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt();
  }

  async compact(): Promise<void> {
    // `later`, so a compaction requested mid-turn runs as its own turn instead of being folded into the running one.
    await this.deliver({ id: null, text: "/compact", imagePaths: [], priority: "later" });
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
      // By default an agent gets only the bridge's tools and its own home directory's config; a spec can opt in to the operator's user-level setup and connectors.
      settingSources: spec.inheritUserConfig ? ["user", "project", "local"] : ["project", "local"],
      strictMcpConfig: !spec.inheritUserConfig,
      settings: spec.inheritUserConfig ? undefined : { disableClaudeAiConnectors: true },
      mcpServers: { [AGENT_TOOL_SERVER]: server },
      // Deny rules hold even with permission prompts bypassed.
      disallowedTools: spec.denyTools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      title: spec.name,
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
    const skipped: string[] = [];
    for (const imagePath of input.imagePaths) {
      const mediaType = IMAGE_MEDIA_TYPES[path.extname(imagePath).toLowerCase()];
      // An image the API rejects fails the turn, and can keep failing the session once it is in the transcript.
      if (!mediaType || (await fs.stat(imagePath)).size > MAX_INLINE_IMAGE_BYTES) {
        skipped.push(imagePath);
        continue;
      }
      const data = (await fs.readFile(imagePath)).toString("base64");
      images.push({ type: "image" as const, source: { type: "base64" as const, media_type: mediaType, data } });
    }
    const withSkipped = skipped.length > 0 ? `${input.text}\n\n[bridge notice] Not attached inline (too large or an unsupported type); open from disk if you need them: ${skipped.join(", ")}` : input.text;
    return {
      type: "user",
      message: { role: "user", content: images.length > 0 ? [{ type: "text", text: withSkipped }, ...images] : withSkipped },
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
        await events.onTurnCompleted({ status: "failed", finalText: "", error: error instanceof Error ? error.message : String(error), consumedInputIds: this.takeAllUnconfirmed(), inputFault: false });
      }
    } finally {
      if (this.session === session) {
        this.session = null;
        this.input = null;
        this.unconfirmed.clear();
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
    if (message.type === "result") {
      const errors = message.subtype === "success" ? "" : message.errors.join("; ");
      if (this.currentSessionId && /No conversation found with session ID/i.test(errors)) {
        // The transcript for the saved session is gone (moved host, pruned history). Forget it; the retry starts a new session.
        const lost = this.currentSessionId;
        this.currentSessionId = null;
        await events.onSessionChanged(null);
        await events.onProblem(`Claude session ${lost} could not be resumed; its transcript is missing. The next input starts a new session.`);
        await events.onTurnCompleted({ status: "failed", finalText: "", error: `session ${lost} could not be resumed`, consumedInputIds: this.takeAllUnconfirmed(), inputFault: false });
        this.session?.close();
        return;
      }
      const finalText = message.subtype === "success" ? message.result : this.lastAssistantText;
      this.lastAssistantText = "";
      // The result names the messages this turn took in; several sent close together can be merged into one turn.
      const consumed = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [...this.unconfirmed.keys()]);
      const consumedInputIds: string[] = [];
      for (const uuid of consumed) {
        const inputId = this.unconfirmed.get(uuid);
        if (inputId) consumedInputIds.push(inputId);
        this.unconfirmed.delete(uuid);
      }
      const interrupted = message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";
      const failed = message.subtype !== "success" || message.is_error;
      await events.onTurnCompleted({
        status: interrupted ? "interrupted" : failed ? "failed" : "completed",
        finalText,
        error: message.subtype === "success" ? (message.is_error ? message.result : null) : errors,
        consumedInputIds,
        inputFault: failed && !interrupted && INPUT_FAULT_REASONS.has(message.terminal_reason ?? ""),
      });
      // Idle only when nothing pushed is still waiting for a turn; a message can land after the CLI counted its queue.
      if ((message.queued_turn_count ?? 0) === 0 && this.unconfirmed.size === 0) await this.setState("idle");
    }
  }

  private takeAllUnconfirmed(): string[] {
    const ids = [...this.unconfirmed.values()].filter((id): id is string => id !== null);
    this.unconfirmed.clear();
    return ids;
  }

  private async setState(state: RuntimeState): Promise<void> {
    if (this.currentState === state) return;
    this.currentState = state;
    await this.options.events.onStateChanged(state);
  }
}
