import fs from "node:fs";
import process from "node:process";
import { logError, logInfo, logWarn } from "../logger.js";
import { ClaudeRuntime } from "../runtimes/claudeRuntime.js";
import { CodexRuntime } from "../runtimes/codexRuntime.js";
import { AgentSlackClient, type SlackHistoryMessage, type SlackInbound } from "../slack/agentSlack.js";
import { prepareSlackAttachments, type AttachmentConfig } from "../slack/attachments.js";
import { AgentStore } from "./agentStore.js";
import { buildThreadContext, decideWake, renderEnvelope, renderSlackText, sourceKey, type EnvelopeAuthor, type ThreadContext } from "./envelope.js";
import { buildInstructions } from "./instructions.js";
import { AgentMind, type RuntimeFactory } from "./mind.js";
import { loadAgentRegistry } from "./registry.js";
import { buildSlackTools } from "./slackTools.js";
import type { AgentSpec, RuntimeState } from "./types.js";
import { WakeScheduler, buildWakeTools } from "./wakes.js";

export interface HubConfig extends AttachmentConfig {
  agentsFile: string;
  agentsRoot: string;
  databasePath: string;
  timezone: string;
  codexBin: string;
  slackUploadMaxFiles: number;
  // Slack user ids allowed to use operator commands in an agent's DM.
  adminUserIds: string[];
  // Consecutive times other agents may wake an agent in one thread before a human has to speak again.
  agentWakeBudget: number;
  threadContextLimit: number;
}

export interface SlackClientFactory {
  (spec: AgentSpec, botToken: string, appToken: string): AgentSlackClient;
}

interface Seat {
  spec: AgentSpec;
  slack: AgentSlackClient;
  mind: AgentMind;
  // Threads currently showing this agent as working.
  statusThreads: Map<string, { channelId: string; threadTs: string }>;
  lastState: RuntimeState;
}

const OPERATOR_COMMANDS = new Set([".status", ".stop", ".compact", ".reset"]);

// Runs every named agent: one Slack app, one mind, and one provider session each.
export class AgentHub {
  private readonly store: AgentStore;
  private readonly seats = new Map<string, Seat>();
  private readonly agentWakeCounts = new Map<string, number>();
  private readonly scheduler: WakeScheduler;

  constructor(
    private readonly config: HubConfig,
    private readonly createSlack: SlackClientFactory = (spec, botToken, appToken) => new AgentSlackClient(spec.name, botToken, appToken),
    private readonly createRuntime: RuntimeFactory = (options) =>
      options.spec.runtime === "claude" ? new ClaudeRuntime(options) : new CodexRuntime(options, config.codexBin),
  ) {
    this.store = new AgentStore(config.databasePath);
    this.scheduler = new WakeScheduler(this.store, async (agent, item) => {
      // A wake for an agent that is not running stays due and fires once the agent is back.
      const seat = this.seats.get(agent);
      if (!seat) throw new Error(`agent ${agent} is not running`);
      await seat.mind.receive({ ...item, wake: true, priority: "later", imagePaths: [] });
    });
  }

  async start(): Promise<void> {
    const specs = loadAgentRegistry(this.config.agentsFile, this.config.agentsRoot);
    if (specs.length === 0) throw new Error(`No agents defined in ${this.config.agentsFile}`);
    const results = await Promise.allSettled(specs.map((spec) => this.startSeat(spec)));
    results.forEach((result, index) => {
      if (result.status === "rejected") logError("agent failed to start", { agent: specs[index]!.name, error: errorMessage(result.reason) });
    });
    if (this.seats.size === 0) throw new Error("No agent could be started");
    this.scheduler.start();
    logInfo("agent hub ready", { agents: [...this.seats.keys()] });
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    await Promise.allSettled([...this.seats.values()].map(async (seat) => {
      await seat.slack.stop();
      await seat.mind.stop();
    }));
    this.seats.clear();
    this.store.close();
  }

  private async startSeat(spec: AgentSpec): Promise<void> {
    const botToken = process.env[spec.slackBotTokenEnv];
    const appToken = process.env[spec.slackAppTokenEnv];
    if (!botToken || !appToken) throw new Error(`Missing Slack credentials: set ${spec.slackBotTokenEnv} and ${spec.slackAppTokenEnv}`);
    if (spec.host.kind === "local") fs.mkdirSync(spec.cwd, { recursive: true });

    const slack = this.createSlack(spec, botToken, appToken);
    const seat: Seat = { spec, slack, mind: null as unknown as AgentMind, statusThreads: new Map(), lastState: "down" };
    slack.onMessage((message) => this.handleInbound(seat, message));
    slack.onStopRequested(async () => {
      logInfo("stop requested from Slack", { agent: spec.name });
      await seat.mind.interrupt();
    });
    const identity = await slack.start();

    const tools = [...buildWakeTools(spec.name, this.store, this.config.timezone), ...buildSlackTools({
      slack,
      noteVisibleAction: () => seat.mind.noteVisibleAction(),
      recordThreadParticipation: (channelId, threadTs) => this.store.recordThreadParticipation(spec.name, channelId, threadTs),
      uploadConfig: {
        slackUploadMaxFiles: this.config.slackUploadMaxFiles,
        workspaceRoot: spec.cwd,
        attachmentStorageDir: this.config.attachmentStorageDir,
        attachmentMaxBytes: this.config.attachmentMaxBytes,
      },
      timezone: this.config.timezone,
      canUploadLocalFiles: spec.host.kind === "local",
    })];
    const ownInstructions = spec.instructionsPath && fs.existsSync(spec.instructionsPath) ? fs.readFileSync(spec.instructionsPath, "utf8") : null;
    const instructions = buildInstructions({ spec, ownUserId: identity.botUserId, workspaceName: identity.teamName, ownInstructions });
    seat.mind = new AgentMind(spec, this.store, this.createRuntime, instructions, tools, {
      onStateChanged: (_agent, state) => this.onMindState(seat, state),
      onTurnCompleted: (_agent, event) => {
        if (event.status === "failed") logError("agent turn failed", { agent: spec.name, error: event.error });
      },
    });
    this.seats.set(spec.name, seat);
    await seat.mind.start();
  }

  private async onMindState(seat: Seat, state: RuntimeState): Promise<void> {
    const wasRunning = seat.lastState === "running";
    seat.lastState = state;
    // Starting up also passes through idle; only the end of a turn clears the working indicator.
    if (state === "running" || !wasRunning) return;
    const threads = [...seat.statusThreads.values()];
    seat.statusThreads.clear();
    await Promise.allSettled(threads.map((thread) => seat.slack.setThreadStatus(thread.channelId, thread.threadTs, "active")));
  }

  // Exposed for tests; Slack events arrive here.
  async handleInbound(seat: Seat, message: SlackInbound): Promise<void> {
    const { spec, slack } = seat;
    try {
      const key = sourceKey(message);
      if (this.store.hasSource(spec.name, key)) return;
      if (await this.handleOperatorCommand(seat, message)) return;

      const identity = slack.identity();
      const threadRoot = message.threadTs ?? message.ts;
      const participant = message.threadTs ? this.store.isThreadParticipant(spec.name, message.channelId, message.threadTs) : false;
      let decision = decideWake(message, identity.botUserId, spec.wake, participant);

      const budgetKey = `${spec.name}:${message.channelId}:${threadRoot}`;
      if (!message.botId) {
        this.agentWakeCounts.delete(budgetKey);
      } else if (decision.wake) {
        const count = (this.agentWakeCounts.get(budgetKey) ?? 0) + 1;
        this.agentWakeCounts.set(budgetKey, count);
        if (count > this.config.agentWakeBudget) {
          logWarn("agent-to-agent wake budget spent; delivering as context", { agent: spec.name, channelId: message.channelId, threadRoot });
          decision = { ...decision, wake: false, budgetExhausted: true };
        }
      }

      const author = await this.describeAuthor(seat, message);
      const names = new Map<string, string>();
      for (const match of message.text.matchAll(/<@([A-Z0-9]+)/g)) {
        if (!names.has(match[1]!)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
      }
      const conversation = await slack.getConversation(message.channelId).catch(() => null);

      let imagePaths: string[] = [];
      let fileNotes: string[] = [];
      if (message.files.length > 0) {
        const prepared = await prepareSlackAttachments(`${spec.name}:${key}`, message.files, [], slack.botTokenForDownloads(), this.config);
        imagePaths = prepared.imagePaths;
        // Downloaded paths exist on the bridge machine only.
        fileNotes = spec.host.kind === "local" ? prepared.fileNotes : message.files.map((file) => `${file.name} (not available on your machine)`);
      }

      let threadContext: ThreadContext | null = null;
      if (decision.wake && message.threadTs && !this.store.hasSeenThread(spec.name, message.channelId, message.threadTs)) {
        threadContext = await this.fetchThreadContext(seat, message).catch((error) => {
          logWarn("thread context fetch failed", { agent: spec.name, error: errorMessage(error) });
          return null;
        });
      }
      this.store.markThreadSeen(spec.name, message.channelId, threadRoot);

      const text = renderEnvelope({
        message,
        channelName: conversation?.name ?? null,
        author,
        decision,
        ownUserId: identity.botUserId,
        names,
        fileNotes,
        imageCount: imagePaths.length,
        timezone: this.config.timezone,
        threadContext,
      });

      if (decision.wake) {
        seat.statusThreads.set(`${message.channelId}:${threadRoot}`, { channelId: message.channelId, threadTs: threadRoot });
        void seat.slack.setThreadStatus(message.channelId, threadRoot, "processing");
      }
      await seat.mind.receive({ sourceKey: key, wake: decision.wake, priority: decision.wake ? "next" : "later", text, imagePaths });
    } catch (error) {
      logError("inbound handling failed", { agent: spec.name, channelId: message.channelId, ts: message.ts, error: errorMessage(error) });
    }
  }

  private async describeAuthor(seat: Seat, message: SlackInbound): Promise<EnvelopeAuthor> {
    if (message.userId) {
      const person = await seat.slack.getPerson(message.userId);
      return { id: person.id, name: person.name, kind: person.isBot ? "agent" : "human" };
    }
    const fleetAgent = [...this.seats.values()].find((other) => other.slack.identity().botId === message.botId);
    if (fleetAgent) return { id: fleetAgent.slack.identity().botUserId, name: fleetAgent.spec.name, kind: "agent" };
    if (message.botUserId) {
      const person = await seat.slack.getPerson(message.botUserId);
      return { id: person.id, name: person.name, kind: "app" };
    }
    return { id: message.botId ?? "unknown", name: "unknown app", kind: "app" };
  }

  private async fetchThreadContext(seat: Seat, message: SlackInbound): Promise<ThreadContext> {
    const history = await seat.slack.readHistory({ channelId: message.channelId, threadTs: message.threadTs, limit: 200 });
    const own = seat.slack.identity();
    const authors = new Map<string, string>();
    const names = new Map<string, string>();
    for (const item of history) {
      if (item.userId && !authors.has(item.userId)) authors.set(item.userId, (await seat.slack.getPerson(item.userId)).name);
      for (const match of item.text.matchAll(/<@([A-Z0-9]+)/g)) {
        if (!names.has(match[1]!)) names.set(match[1]!, (await seat.slack.getPerson(match[1]!)).name);
      }
    }
    const describe = (item: SlackHistoryMessage): string =>
      item.userId === own.botUserId || item.botId === own.botId ? "you" : item.userId ? `${authors.get(item.userId) ?? item.userId} (${item.userId})` : `app ${item.botId ?? "unknown"}`;
    return buildThreadContext(history, message.ts, this.config.threadContextLimit, describe, (text) => renderSlackText(text, own.botUserId, names));
  }

  // Operator controls for the harness itself, available to admins in the agent's DM. Replies are marked as coming from the bridge, not the agent.
  private async handleOperatorCommand(seat: Seat, message: SlackInbound): Promise<boolean> {
    const command = message.text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (message.channelType !== "im" || !message.userId || !OPERATOR_COMMANDS.has(command)) return false;
    if (!this.config.adminUserIds.includes(message.userId)) return false;
    const { mind, spec, slack } = seat;
    let reply: string;
    if (command === ".status") {
      const state = this.store.getAgentState(spec.name);
      reply = [
        `state: ${mind.state()}`,
        `runtime: ${spec.runtime}${spec.model ? ` (${spec.model})` : ""} on ${spec.host.kind === "local" ? "this machine" : spec.host.target}`,
        `session: ${mind.sessionId() ?? "none yet"}`,
        `queued input: ${this.store.listQueued(spec.name).length}`,
        `last error: ${state?.lastError ?? "none"}`,
      ].join("\n");
    } else if (command === ".stop") {
      await mind.interrupt();
      reply = "interrupt sent";
    } else if (command === ".compact") {
      await mind.compact();
      reply = "compaction requested";
    } else {
      await mind.resetSession();
      reply = "session forgotten; the next message starts a new one";
    }
    await slack.postMessage({ channelId: message.channelId, threadTs: message.threadTs, text: `_bridge (${spec.name})_\n${reply}` });
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
