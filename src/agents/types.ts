import type { z } from "zod";

export type RuntimeKind = "claude" | "codex";

export type AgentHost =
  | { kind: "local" }
  | { kind: "ssh"; target: string };

// What wakes the agent's mind. Everything else it can see is still delivered, as context.
export interface WakePolicy {
  mentions: boolean;
  directMessages: boolean;
  // Replies in threads the agent has already spoken in.
  participatingThreads: boolean;
  // Every message in channels the agent is a member of.
  ambient: boolean;
}

export const DEFAULT_WAKE_POLICY: WakePolicy = {
  mentions: true,
  directMessages: true,
  participatingThreads: false,
  ambient: false,
};

export interface AgentSpec {
  name: string;
  title: string | null;
  runtime: RuntimeKind;
  model: string | null;
  effort: string | null;
  host: AgentHost;
  // The agent's home directory on its host.
  cwd: string;
  wake: WakePolicy;
  // Names of the env vars holding this agent's Slack app credentials.
  slackBotTokenEnv: string;
  slackAppTokenEnv: string;
  instructionsPath: string | null;
  // Load the operator's user-level harness config (settings, MCP servers, cloud connectors) into this agent.
  inheritUserConfig: boolean;
}

export type InputPriority = "now" | "next" | "later";

export interface RuntimeInput {
  text: string;
  imagePaths: string[];
  priority: InputPriority;
}

export type RuntimeState = "down" | "idle" | "running";

export type TurnStatus = "completed" | "interrupted" | "failed";

export interface ActivityItem {
  id: string;
  title: string;
  status: "started" | "completed" | "failed";
  detail: string | null;
}

export interface RuntimeEvents {
  onSessionChanged(sessionId: string): void | Promise<void>;
  onStateChanged(state: RuntimeState): void | Promise<void>;
  onTurnCompleted(event: { status: TurnStatus; finalText: string; error: string | null }): void | Promise<void>;
  onActivity(item: ActivityItem): void | Promise<void>;
  onCompaction(event: { status: "started" | "completed" | "failed" }): void | Promise<void>;
}

export interface AgentTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: Shape;
  handler(args: z.infer<z.ZodObject<Shape>>): Promise<string>;
}

export interface RuntimeOptions {
  spec: AgentSpec;
  // Persisted provider session id to resume, if any.
  sessionId: string | null;
  instructions: string;
  tools: AgentTool[];
  events: RuntimeEvents;
}

// One named agent's mind: a single long-lived provider session.
export interface AgentRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(input: RuntimeInput): Promise<void>;
  interrupt(): Promise<void>;
  compact(): Promise<void>;
  state(): RuntimeState;
  sessionId(): string | null;
}

export class RuntimeError extends Error {
  constructor(
    readonly kind: "session_missing" | "auth" | "transient" | "fatal",
    message: string,
  ) {
    super(message);
  }
}
