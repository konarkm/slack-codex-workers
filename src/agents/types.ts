import type { z } from "zod";

export type RuntimeKind = "claude" | "codex";

export type AgentHost =
  | { kind: "local" }
  | { kind: "ssh"; target: string };

// How an agent gets woken. Every message in a conversation the agent is part of reaches its inbox either way;
// this only decides which ones interrupt it.
export interface WakePolicy {
  // true: a judgment model reads each message the way a person would and decides whether it is for this agent, @ or no @.
  // false: only plain rules apply (the agent's name appears, a DM, a thread it is already in).
  natural: boolean;
  // How sure the judgment has to be (0 to 1) before the agent is woken. Lower means it jumps in more readily.
  threshold: number;
}

export const DEFAULT_WAKE_POLICY: WakePolicy = { natural: true, threshold: 0.5 };

// The model an agent runs when its entry names none. The roster file's `defaults` overrides these per runtime.
export const DEFAULT_MODELS: Record<RuntimeKind, string> = { claude: "claude-opus-5-5", codex: "gpt-6-sol" };

// How hard an agent thinks, as each harness names it. A model may support fewer levels than its harness does.
export const EFFORT_LEVELS: Record<RuntimeKind, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
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
  // Emoji name (":brain:") or image URL shown beside the agent's messages. All agents post through one shared Slack app.
  icon: string | null;
  instructionsPath: string | null;
  // Load the operator's user-level harness config (settings, MCP servers, cloud connectors) into this agent.
  inheritUserConfig: boolean;
  // Tools removed from the agent's reach, as harness tool specs (a whole MCP server: "mcp__server").
  denyTools: string[];
  // A retired agent keeps its name, home, and session but does not listen. It can be brought back.
  retired: boolean;
}

// Inherited connectors an agent never gets unless its entry lifts the denial: the ones that speak as the operator (their
// own Slack, their iMessage), connector hubs that include those, and the ones that move money. Approvals are off, and what
// an agent reads is not trusted. Found the hard way: a test agent posted to the operator's Slack under the operator's name.
export const DEFAULT_DENY_TOOLS = [
  "mcp__claude_ai_Slack",
  "mcp__plugin_productivity_slack",
  "mcp__slack",
  "mcp__claude_ai_Robinhood",
  "mcp__claude_ai_Natural",
  "mcp__mac_messages",
  "mcp__messages",
  // Connector hubs that can post to Slack and other accounts as the operator.
  "mcp__composio",
  "mcp__codex_apps",
];

export type InputPriority = "now" | "next" | "later";

export interface RuntimeInput {
  // Identifies this input in turn-completion reports. Null for bridge notices that have no inbox rows behind them.
  id: string | null;
  text: string;
  imagePaths: string[];
  priority: InputPriority;
}

export type RuntimeState = "down" | "idle" | "running";

export type TurnStatus = "completed" | "interrupted" | "failed";

export interface TurnCompletion {
  status: TurnStatus;
  finalText: string;
  error: string | null;
  // Ids of the inputs this turn took in.
  consumedInputIds: string[];
  // True when a failure was caused by the input itself (an unreadable image, an over-long prompt) rather than by the provider or the harness.
  inputFault: boolean;
}

export interface ActivityItem {
  id: string;
  title: string;
  status: "started" | "completed" | "failed";
  detail: string | null;
}

export interface RuntimeEvents {
  // null when the provider session is gone and the next input will start a new one.
  onSessionChanged(sessionId: string | null): void | Promise<void>;
  onStateChanged(state: RuntimeState): void | Promise<void>;
  onTurnCompleted(event: TurnCompletion): void | Promise<void>;
  onActivity(item: ActivityItem): void | Promise<void>;
  onCompaction(event: { status: "started" | "completed" | "failed" }): void | Promise<void>;
  // The runtime is up but something is wrong with it that an operator should see.
  onProblem(message: string): void | Promise<void>;
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
  // The bridge's tools for this agent. Served by the hub's tool server; runtimes only need the names.
  tools: AgentTool[];
  // Where the harness fetches those tools over MCP, with this agent's token.
  toolAccess: { url: string; token: string };
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
