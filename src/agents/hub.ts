import fs from "node:fs";
import process from "node:process";
import { z } from "zod";
import { logError, logInfo, logWarn } from "../logger.js";
import { ClaudeRuntime } from "../runtimes/claudeRuntime.js";
import { CodexRuntime } from "../runtimes/codexRuntime.js";
import { AgentSlackClient, type SlackHistoryMessage, type SlackInbound, type SlackPersona, type SlackReaction } from "../slack/agentSlack.js";
import { prepareSlackAttachments, type AttachmentConfig } from "../slack/attachments.js";
import { WebhookIngressServer, type WebhookServerConfig } from "../webhooks/server.js";
import { AgentStore } from "./agentStore.js";
import { buildThreadContext, mentionsUser, renderEnvelope, renderReactionEnvelope, renderSlackText, sourceKey, type EnvelopeAuthor, type ThreadContext, type WakeDecision } from "./envelope.js";
import { buildInstructions } from "./instructions.js";
import { RuleJudge, type JudgeInput, type JudgeMessage, type Verdict, type WakeJudge } from "./judge.js";
import { AgentMind, type RuntimeFactory } from "./mind.js";
import { AgentRegistry, agentNamePattern } from "./registry.js";
import { buildSlackTools } from "./slackTools.js";
import type { AgentSpec, AgentTool, RuntimeState } from "./types.js";
import { WakeScheduler, buildWakeTools } from "./wakes.js";
import { WebhookWakes, buildWebhookTools } from "./webhookWakes.js";

export interface HubConfig extends AttachmentConfig {
  agentsFile: string;
  agentsRoot: string;
  databasePath: string;
  timezone: string;
  codexBin: string;
  slackUploadMaxFiles: number;
  // Slack user ids allowed to use operator commands in the agents' DM.
  adminUserIds: string[];
  // Consecutive times agents may wake an agent in one conversation before a person has to speak again.
  agentWakeBudget: number;
  threadContextLimit: number;
  // Inbound webhooks. Null turns the listener off.
  webhooks: (WebhookServerConfig & { storageDir: string; publicBaseUrl: string | null }) | null;
}

export interface SlackClientFactory {
  (botToken: string, appToken: string): AgentSlackClient;
}

interface Seat {
  spec: AgentSpec;
  mind: AgentMind;
  // Threads currently showing this agent as working.
  statusThreads: Map<string, { channelId: string; threadTs: string }>;
  lastState: RuntimeState;
}

// An agent-to-agent exchange that has been quiet this long starts over with a full budget.
const AGENT_WAKE_BUDGET_QUIET_MS = 30 * 60_000;
// How sure the judgment must be before a message in plain words stops a working agent.
const STOP_THRESHOLD = 0.8;
// Between agents, a message this likely to be a bare acknowledgement wakes nobody.
const BARE_ACK_THRESHOLD = 0.7;
const RECENT_MESSAGES = 8;

const OPERATOR_COMMANDS = new Set([".status", ".stop", ".compact", ".reset"]);
// Reactions that only acknowledge. With the judgment model away, these do not wake the agent; anything else does.
const ACK_REACTIONS = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark", "ballot_box_with_check", "ok_hand", "ok", "heart", "tada", "pray", "raised_hands", "clap", "100", "fire", "rocket"]);
// The most recent search token Slack handed the app is kept under this key.
const ANY_CONVERSATION = "*";

export function personaOf(spec: AgentSpec): SlackPersona {
  return { username: spec.name, icon: spec.icon };
}

// Turns the judgment into who gets woken. Everyone in the conversation still receives the message.
export function decideWakes(
  verdict: Verdict,
  ruleVerdict: Verdict,
  agents: AgentSpec[],
  context: { authorKind: "human" | "agent" | "app"; authorAgent: string | null; isDirectMessage: boolean; appMentioned: boolean; defaultAgent: string | null },
): Map<string, WakeDecision> {
  const decisions = new Map<string, WakeDecision>();
  const ackBetweenAgents = context.authorKind === "agent" && verdict.bareAck >= BARE_ACK_THRESHOLD;
  for (const agent of agents) {
    if (agent.name === context.authorAgent) continue;
    const used = agent.wake.natural ? verdict : ruleVerdict;
    const probability = used.needs.get(agent.name) ?? 0;
    const wake = !ackBetweenAgents && probability >= agent.wake.threshold;
    decisions.set(agent.name, { wake, reason: wake ? "addressed" : "none", probability, source: used.source });
  }
  // A person who DMs the agents, or @s the app, is never left with nobody listening.
  const someoneWoke = [...decisions.values()].some((decision) => decision.wake);
  const fallbackName = context.defaultAgent && decisions.has(context.defaultAgent) ? context.defaultAgent : [...decisions.keys()][0];
  if (!someoneWoke && context.authorKind === "human" && (context.isDirectMessage || context.appMentioned) && fallbackName) {
    decisions.set(fallbackName, { ...decisions.get(fallbackName)!, wake: true, reason: "default" });
  }
  return decisions;
}

// Runs the workspace's agents: one shared Slack app, and for each agent one mind and one provider session.
export class AgentHub {
  private readonly store: AgentStore;
  private readonly seats = new Map<string, Seat>();
  private readonly agentWakeCounts = new Map<string, { count: number; lastAt: number }>();
  private readonly recent = new Map<string, JudgeMessage[]>();
  // Search tokens Slack attaches to @-mentions and DMs, by conversation. Slack does not say how long they last.
  private readonly actionTokens = new Map<string, { token: string; at: number }>();
  private readonly scheduler: WakeScheduler;
  private readonly webhookWakes: WebhookWakes | null;
  private readonly ruleJudge = new RuleJudge();
  private webhookServer: WebhookIngressServer | null = null;
  private registry: AgentRegistry | null = null;
  private slack: AgentSlackClient | null = null;
  // Slack delivers events concurrently, and a mention twice. One line keeps order and makes the dedupe check reliable.
  private intake: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly config: HubConfig,
    private readonly judge: WakeJudge = new RuleJudge(),
    private readonly createSlack: SlackClientFactory = (botToken, appToken) => new AgentSlackClient("workspace", botToken, appToken),
    private readonly createRuntime: RuntimeFactory = (options) =>
      options.spec.runtime === "claude" ? new ClaudeRuntime(options) : new CodexRuntime(options, config.codexBin),
  ) {
    this.store = new AgentStore(config.databasePath);
    const deliverWake = async (agent: string, item: { sourceKey: string; text: string }): Promise<void> => {
      if (!this.registry?.has(agent)) throw new Error(`agent ${agent} is not in the registry`);
      const input = { ...item, wake: true, priority: "later" as const, imagePaths: [] };
      const seat = this.seats.get(agent);
      // The inbox is the durable step. An agent that is down finds the wake waiting when it starts.
      if (!seat) {
        this.store.enqueue({ ...input, agent });
        return;
      }
      await seat.mind.receive(input).catch((error) => {
        logWarn("wake queued; the agent could not take it yet", { agent, error: errorMessage(error) });
      });
    };
    this.scheduler = new WakeScheduler(this.store, deliverWake);
    this.webhookWakes = config.webhooks
      ? new WebhookWakes(this.store, { storageDir: config.webhooks.storageDir, webhookPath: config.webhooks.webhookPath, publicBaseUrl: config.webhooks.publicBaseUrl }, deliverWake)
      : null;
  }

  async start(): Promise<void> {
    this.registry = new AgentRegistry(this.config.agentsFile, this.config.agentsRoot);
    const specs = this.registry.specs();
    if (specs.length === 0) throw new Error(`No agents defined in ${this.config.agentsFile}`);
    const env = this.registry.slackEnv();
    const botToken = process.env[env.botTokenEnv];
    const appToken = process.env[env.appTokenEnv];
    if (!botToken || !appToken) throw new Error(`Missing Slack credentials: set ${env.botTokenEnv} and ${env.appTokenEnv}`);

    const slack = this.createSlack(botToken, appToken);
    this.slack = slack;
    slack.onMessage(async (message) => {
      // Operator commands skip the line: a stop must not wait behind a large download.
      if (await this.handleOperatorCommand(message)) return;
      this.intake = this.intake.then(() => this.handleInbound(message));
      return this.intake;
    });
    slack.onReaction(async (reaction) => {
      this.intake = this.intake.then(() => this.handleReaction(reaction));
      return this.intake;
    });
    slack.onStopRequested(async (where) => {
      for (const seat of this.seats.values()) {
        const showing = [...seat.statusThreads.values()].some((thread) => thread.channelId === where.channelId && (!where.threadTs || thread.threadTs === where.threadTs));
        if (!showing) continue;
        logInfo("stop requested from Slack", { agent: seat.spec.name });
        await seat.mind.interrupt();
      }
    });
    await slack.identify();

    const results = await Promise.allSettled(specs.map((spec) => this.startSeat(spec)));
    results.forEach((result, index) => {
      if (result.status === "rejected") logError("agent failed to start", { agent: specs[index]!.name, error: errorMessage(result.reason) });
    });
    if (this.seats.size === 0) throw new Error("No agent could be started");
    // Every mind exists before the socket opens, so no event can arrive with nowhere to go.
    await slack.connect();
    await Promise.allSettled([...this.seats.values()].map((seat) => seat.mind.start()));

    this.scheduler.start();
    if (this.config.webhooks && this.webhookWakes) {
      const wakes = this.webhookWakes;
      const server = new WebhookIngressServer(this.config.webhooks, (token) => wakes.resolveSource(token), (input) => wakes.ingest(input));
      try {
        await server.start();
        this.webhookServer = server;
      } catch (error) {
        logError("webhook listener failed to start; agents run without inbound webhooks", { error: errorMessage(error) });
      }
    }
    logInfo("agent hub ready", { agents: [...this.seats.keys()] });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler.stop();
    await this.webhookServer?.stop().catch(() => {});
    this.webhookServer = null;
    await this.slack?.stop().catch(() => {});
    await Promise.allSettled([...this.seats.values()].map((seat) => seat.mind.stop()));
    this.seats.clear();
    this.store.close();
  }

  private requireSlack(): AgentSlackClient {
    if (!this.slack) throw new Error("the hub is not started");
    return this.slack;
  }

  private startSeat(spec: AgentSpec): Seat {
    const slack = this.requireSlack();
    if (spec.host.kind === "local") fs.mkdirSync(spec.cwd, { recursive: true });
    const seat: Seat = { spec, mind: null as unknown as AgentMind, statusThreads: new Map(), lastState: "down" };
    const tools = [
      ...this.buildTeamTools(seat),
      ...buildWakeTools(spec.name, this.store, this.config.timezone),
      // Handler files and payloads live on the bridge machine, so only agents that share its disk get the webhook tools.
      ...(this.webhookWakes && spec.host.kind === "local" ? buildWebhookTools(spec.name, this.store, this.webhookWakes) : []),
      ...buildSlackTools({
        slack,
        persona: personaOf(spec),
        noteVisibleAction: () => seat.mind.noteVisibleAction(),
        recordThreadParticipation: (channelId, threadTs) => this.store.recordThreadParticipation(spec.name, channelId, threadTs),
        afterSend: (sent) => this.relayAgentMessage(seat, sent),
        uploadConfig: {
          slackUploadMaxFiles: this.config.slackUploadMaxFiles,
          workspaceRoot: spec.cwd,
          attachmentStorageDir: this.config.attachmentStorageDir,
          attachmentMaxBytes: this.config.attachmentMaxBytes,
        },
        timezone: this.config.timezone,
        canUploadLocalFiles: spec.host.kind === "local",
        actionTokenFor: (channelId) => (channelId ? this.actionTokens.get(channelId) : undefined)?.token ?? this.actionTokens.get(ANY_CONVERSATION)?.token ?? null,
      }),
    ];
    const ownInstructions = spec.instructionsPath && fs.existsSync(spec.instructionsPath) ? fs.readFileSync(spec.instructionsPath, "utf8") : null;
    const instructions = buildInstructions({ spec, workspaceName: slack.identity().teamName, operatorUserIds: this.config.adminUserIds, ownInstructions });
    seat.mind = new AgentMind(spec, this.store, this.createRuntime, instructions, tools, {
      onStateChanged: (_agent, state) => this.onMindState(seat, state),
      onTurnCompleted: (_agent, event) => {
        if (event.status === "failed") logError("agent turn failed", { agent: spec.name, error: event.error });
      },
      onAbandoned: (_agent, items, reason) =>
        this.tellOperators(spec.name, `I stopped trying to deliver ${items.length} message(s) to ${spec.name}; each made three turns fail (${reason}). Whoever sent them is still waiting: ${items.map((item) => item.sourceKey).join(", ")}`),
      onTrouble: (_agent, message) => this.tellOperators(spec.name, `${spec.name} is in trouble: ${message}`),
    });
    this.seats.set(spec.name, seat);
    return seat;
  }

  // Agents know their team, and can grow it. A new agent is a registry entry and a mind; nobody clicks anything.
  private buildTeamTools(seat: Seat): AgentTool[] {
    const define = <Shape extends z.ZodRawShape>(tool: AgentTool<Shape>): AgentTool => tool as unknown as AgentTool;
    return [
      define({
        name: "list_agents",
        description: "List the agents on your team: their names, roles, and whether they are working right now. Address an agent by writing its name in a message, the way you would a person.",
        shape: {},
        handler: async () =>
          [...this.seats.values()]
            // An agent at rest has no process running; it still wakes the moment it is addressed, so it is never shown as "down".
            .map((other) => `${other.spec.name}${other.spec.name === seat.spec.name ? " (you)" : ""} · ${other.spec.title ?? "teammate"} · ${other.mind.state() === "running" ? "working right now" : "available, wakes when addressed"}`)
            .join("\n"),
      }),
      define({
        name: "create_agent",
        description:
          "Create a new agent teammate. It gets its own mind, name, and icon, and is reachable in Slack at once. Create one when there is a standing responsibility worth its own teammate, not for a one-off task (use a subagent for that). Say in Slack that you created it and why.",
        shape: {
          name: z.string().regex(agentNamePattern).describe("Lowercase handle people will call it by, e.g. scout."),
          title: z.string().min(1).describe("Short role line, e.g. release manager."),
          runtime: z.enum(["claude", "codex"]),
          model: z.string().optional().describe("Omit for the runtime's default."),
          icon: z.string().optional().describe("Emoji name such as :satellite:, or an image URL."),
          instructions: z.string().min(1).describe("The new agent's standing instructions: what it owns, how it works, who it answers to."),
        },
        handler: async (args) => {
          if (!this.registry) throw new Error("the hub is not started");
          const spec = this.registry.add({ name: args.name, title: args.title, runtime: args.runtime, model: args.model, icon: args.icon, createdBy: seat.spec.name }, args.instructions);
          const created = this.startSeat(spec);
          await created.mind.start();
          logInfo("agent created by an agent", { agent: spec.name, createdBy: seat.spec.name });
          return `created ${spec.name}. It is listening now; say its name in a message to reach it.`;
        },
      }),
    ];
  }

  // Harness trouble goes to the operators as the bridge, in the agents' DM with them. It is never posted as an agent.
  private async tellOperators(agent: string, text: string): Promise<void> {
    const slack = this.requireSlack();
    for (const userId of this.config.adminUserIds) {
      try {
        await slack.postMessage({ channelId: await slack.openDm(userId), text: `_bridge (${agent})_\n${text}` });
      } catch (error) {
        logError("could not reach an operator", { agent, userId, error: errorMessage(error) });
      }
    }
  }

  private async onMindState(seat: Seat, state: RuntimeState): Promise<void> {
    const wasRunning = seat.lastState === "running";
    seat.lastState = state;
    // Starting up also passes through idle; only the end of a turn clears the working indicator.
    if (state === "running" || !wasRunning) return;
    const threads = [...seat.statusThreads.values()];
    seat.statusThreads.clear();
    await Promise.allSettled(threads.map((thread) => this.requireSlack().setThreadStatus(thread.channelId, thread.threadTs, "active", personaOf(seat.spec))));
  }

  // What an agent says in Slack reaches the other agents through the bridge itself, attributed to the agent that said it.
  // (Slack echoes the shared app's own posts without saying which agent wrote them, so the echo is ignored.)
  private relayAgentMessage(author: Seat, sent: { channelId: string; threadTs: string | null; ts: string; text: string }): void {
    const identity = this.requireSlack().identity();
    const message: SlackInbound = {
      teamId: identity.teamId,
      channelId: sent.channelId,
      channelType: sent.channelId.startsWith("D") ? "im" : sent.channelId.startsWith("G") ? "group" : "channel",
      ts: sent.ts,
      threadTs: sent.threadTs,
      userId: null,
      botId: identity.botId,
      botUserId: identity.botUserId,
      text: sent.text,
      files: [],
      unavailableFiles: [],
      editedAt: null,
      agentAuthor: author.spec.name,
    };
    this.intake = this.intake.then(() => this.handleInbound(message));
  }

  // Slack events and agents' own posts arrive here, one at a time.
  async handleInbound(message: SlackInbound): Promise<void> {
    const slack = this.requireSlack();
    try {
      if (message.actionToken) {
        const entry = { token: message.actionToken, at: Date.now() };
        this.actionTokens.set(message.channelId, entry);
        this.actionTokens.set(ANY_CONVERSATION, entry);
      }
      const key = sourceKey(message);
      const listeners = [...this.seats.values()].filter((seat) => seat.spec.name !== message.agentAuthor && !this.store.hasSource(seat.spec.name, key));
      if (listeners.length === 0) return;

      const identity = slack.identity();
      const threadRoot = message.threadTs ?? message.ts;
      const conversationKey = `${message.channelId}:${message.threadTs ?? "top"}`;
      const author = await this.describeAuthor(message);
      const names = new Map<string, string>();
      for (const match of message.text.matchAll(/<@([A-Z0-9]+)/g)) {
        if (!names.has(match[1]!)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
      }
      const conversation = await slack.getConversation(message.channelId).catch(() => null);
      const plainText = renderSlackText(message.text, identity.botUserId, names);

      const judgeInput: JudgeInput = {
        conversation: {
          kind: message.channelType === "im" ? "direct message with the agents" : message.channelType === "mpim" ? "group DM" : message.channelType === "group" ? "private channel" : "channel",
          name: conversation?.name ?? null,
          inThread: Boolean(message.threadTs),
        },
        agents: listeners.map((seat) => ({
          name: seat.spec.name,
          role: seat.spec.title,
          inThisConversation:
            this.store.isThreadParticipant(seat.spec.name, message.channelId, threadRoot) ||
            (this.recent.get(conversationKey) ?? []).some((earlier) => earlier.from === `${seat.spec.name} (agent)`),
          working: seat.mind.state() === "running",
        })),
        recent: [...(this.recent.get(conversationKey) ?? [])],
        message: { from: `${author.name} (${author.kind})`, text: plainText },
        authorKind: author.kind,
      };
      const naturalWanted = listeners.some((seat) => seat.spec.wake.natural);
      const ruleVerdict = await this.ruleJudge.judge(judgeInput);
      const verdict = naturalWanted ? await this.judge.judge(judgeInput) : ruleVerdict;
      const decisions = decideWakes(verdict, ruleVerdict, listeners.map((seat) => seat.spec), {
        authorKind: author.kind,
        authorAgent: message.agentAuthor ?? null,
        isDirectMessage: message.channelType === "im",
        appMentioned: mentionsUser(message.text, identity.botUserId),
        defaultAgent: this.registry?.defaultAgent() ?? null,
      });
      this.remember(conversationKey, judgeInput.message);

      // The loop breaker is for our own agents talking to each other. People and other apps always get through.
      const channelPrefix = `${message.channelId}:`;
      const now = Date.now();
      for (const [existing, entry] of this.agentWakeCounts) {
        if (now - entry.lastAt > AGENT_WAKE_BUDGET_QUIET_MS) this.agentWakeCounts.delete(existing);
      }
      if (author.kind === "human") {
        for (const existing of this.agentWakeCounts.keys()) {
          if (existing.endsWith(`|${conversationKey}`) || (!message.threadTs && existing.includes(`|${channelPrefix}`))) this.agentWakeCounts.delete(existing);
        }
      }

      const anyWake = [...decisions.values()].some((decision) => decision.wake);
      let imagePaths: string[] = [];
      let fileNotes: string[] = [];
      if (message.files.length > 0 && !anyWake) {
        // Background messages list their files; an agent can fetch history if it wants them.
        fileNotes = message.files.map((file) => `${file.name} (not downloaded)`);
      } else if (message.files.length > 0) {
        const prepared = await prepareSlackAttachments(key, message.files, [], slack.botTokenForDownloads(), this.config);
        imagePaths = prepared.imagePaths;
        fileNotes = prepared.fileNotes;
      }
      fileNotes.push(...message.unavailableFiles.map((name) => `${name} (Slack gave no download link)`));

      for (const seat of listeners) {
        const { spec } = seat;
        let decision = decisions.get(spec.name);
        if (!decision) continue;

        // A person telling a working agent to stop, in plain words, stops it. The message is still delivered, so it knows why.
        if (author.kind === "human" && (verdict.stop.get(spec.name) ?? 0) >= STOP_THRESHOLD) {
          logInfo("stop requested in conversation", { agent: spec.name });
          await seat.mind.interrupt();
        }

        if (author.kind === "agent" && decision.wake) {
          const budgetKey = `${spec.name}|${conversationKey}`;
          const count = (this.agentWakeCounts.get(budgetKey)?.count ?? 0) + 1;
          this.agentWakeCounts.set(budgetKey, { count, lastAt: now });
          if (count > this.config.agentWakeBudget) {
            logWarn("agent-to-agent wake budget spent; delivering as context", { agent: spec.name, channelId: message.channelId, threadRoot });
            decision = { ...decision, wake: false, budgetExhausted: true };
          }
        }

        let threadContext: ThreadContext | null = null;
        if (decision.wake && message.threadTs && !this.store.hasSeenThread(spec.name, message.channelId, message.threadTs)) {
          threadContext = await this.fetchThreadContext(spec.name, message).catch((error) => {
            logWarn("thread context fetch failed", { agent: spec.name, error: errorMessage(error) });
            return null;
          });
        }
        this.store.markThreadSeen(spec.name, message.channelId, threadRoot);

        // Files on the bridge's disk are no use to an agent on another machine.
        const notesForAgent = spec.host.kind === "local" ? fileNotes : message.files.map((file) => `${file.name} (not available on your machine)`).concat(message.unavailableFiles.map((name) => `${name} (Slack gave no download link)`));
        const text = renderEnvelope({
          message,
          channelName: conversation?.name ?? null,
          author,
          decision,
          appUserId: identity.botUserId,
          names,
          fileNotes: notesForAgent,
          imageCount: decision.wake ? imagePaths.length : 0,
          timezone: this.config.timezone,
          threadContext,
        });

        if (decision.wake) {
          seat.statusThreads.set(`${message.channelId}:${threadRoot}`, { channelId: message.channelId, threadTs: threadRoot });
          void slack.setThreadStatus(message.channelId, threadRoot, "processing", personaOf(spec));
        }
        await seat.mind
          .receive({ sourceKey: key, wake: decision.wake, priority: decision.wake ? verdict.urgency : "later", text, imagePaths: decision.wake ? imagePaths : [] })
          .catch((error) => logWarn("input queued; the agent could not take it yet", { agent: spec.name, error: errorMessage(error) }));
      }
    } catch (error) {
      logError("inbound handling failed", { channelId: message.channelId, ts: message.ts, error: errorMessage(error) });
    }
  }

  // A reaction on an agent's own message reaches that agent. A plain acknowledgement is delivered as context; anything that
  // asks something of the agent wakes it. The judgment model decides which; without it, a short list of acknowledgement emoji does.
  async handleReaction(reaction: SlackReaction): Promise<void> {
    const slack = this.requireSlack();
    try {
      const target = await slack.lookupMessage(reaction.channelId, reaction.itemTs);
      if (!target || target.botId !== slack.identity().botId || !target.username) return;
      const seat = this.seats.get(target.username);
      if (!seat) return;
      const key = `slack:${reaction.channelId}:${reaction.itemTs}:reaction:${reaction.emoji}:${reaction.userId}:${reaction.eventTs}`;
      if (this.store.hasSource(seat.spec.name, key)) return;

      const person = await slack.getPerson(reaction.userId);
      const author: EnvelopeAuthor = { id: person.id, name: person.name, kind: person.isBot ? "app" : "human" };
      const conversation = await slack.getConversation(reaction.channelId).catch(() => null);
      const channelType = conversation?.type ?? (reaction.channelId.startsWith("D") ? "im" : "channel");
      const threadRoot = target.threadTs ?? reaction.itemTs;
      const conversationKey = `${reaction.channelId}:${target.threadTs ?? "top"}`;
      const excerpt = renderSlackText(target.text, slack.identity().botUserId, new Map()).replace(/[\r\n]+/g, " ").slice(0, 200);
      const judgeMessage: JudgeMessage = { from: `${author.name} (${author.kind})`, text: `(reacted :${reaction.emoji}: to ${seat.spec.name}'s message "${excerpt}")` };

      let wake: boolean;
      if (seat.spec.wake.natural) {
        const verdict = await this.judge.judge({
          conversation: {
            kind: channelType === "im" ? "direct message with the agents" : channelType === "mpim" ? "group DM" : channelType === "group" ? "private channel" : "channel",
            name: conversation?.name ?? null,
            inThread: Boolean(target.threadTs),
          },
          agents: [{ name: seat.spec.name, role: seat.spec.title, inThisConversation: true, working: seat.mind.state() === "running" }],
          recent: [...(this.recent.get(conversationKey) ?? [])],
          message: judgeMessage,
          authorKind: author.kind,
        });
        wake = verdict.source === "jev" ? (verdict.needs.get(seat.spec.name) ?? 0) >= seat.spec.wake.threshold && verdict.bareAck < BARE_ACK_THRESHOLD : !ACK_REACTIONS.has(reaction.emoji);
      } else {
        wake = !ACK_REACTIONS.has(reaction.emoji);
      }
      this.remember(conversationKey, judgeMessage);

      const text = renderReactionEnvelope({
        reaction,
        channelType,
        channelName: conversation?.name ?? null,
        author,
        wake,
        target: { threadTs: target.threadTs, text: target.text },
        appUserId: slack.identity().botUserId,
        timezone: this.config.timezone,
      });
      if (wake) {
        seat.statusThreads.set(`${reaction.channelId}:${threadRoot}`, { channelId: reaction.channelId, threadTs: threadRoot });
        void slack.setThreadStatus(reaction.channelId, threadRoot, "processing", personaOf(seat.spec));
      }
      await seat.mind
        .receive({ sourceKey: key, wake, priority: wake ? "next" : "later", text, imagePaths: [] })
        .catch((error) => logWarn("input queued; the agent could not take it yet", { agent: seat.spec.name, error: errorMessage(error) }));
    } catch (error) {
      logError("reaction handling failed", { channelId: reaction.channelId, ts: reaction.itemTs, error: errorMessage(error) });
    }
  }

  private remember(conversationKey: string, message: JudgeMessage): void {
    const list = this.recent.get(conversationKey) ?? [];
    list.push({ from: message.from, text: message.text.slice(0, 600) });
    this.recent.set(conversationKey, list.slice(-RECENT_MESSAGES));
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
  }

  private async describeAuthor(message: SlackInbound): Promise<EnvelopeAuthor> {
    if (message.agentAuthor) return { id: message.agentAuthor, name: message.agentAuthor, kind: "agent" };
    const slack = this.requireSlack();
    if (message.userId) {
      const person = await slack.getPerson(message.userId);
      return { id: person.id, name: person.name, kind: person.isBot ? "app" : "human" };
    }
    if (message.botUserId) {
      const person = await slack.getPerson(message.botUserId);
      return { id: person.id, name: person.name, kind: "app" };
    }
    return { id: message.botId ?? "unknown", name: "unknown app", kind: "app" };
  }

  private async fetchThreadContext(agent: string, message: SlackInbound): Promise<ThreadContext> {
    const slack = this.requireSlack();
    const history = await slack.readHistory({ channelId: message.channelId, threadTs: message.threadTs, limit: 200 });
    const own = slack.identity();
    const authors = new Map<string, string>();
    const names = new Map<string, string>();
    for (const item of history) {
      if (item.userId && !authors.has(item.userId)) authors.set(item.userId, (await slack.getPerson(item.userId)).name);
      for (const match of item.text.matchAll(/<@([A-Z0-9]+)/g)) {
        if (!names.has(match[1]!)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
      }
    }
    const describe = (item: SlackHistoryMessage): string =>
      item.botId === own.botId ? (item.username === agent ? "you" : `${item.username ?? "an agent"} (agent)`) : item.userId ? `${authors.get(item.userId) ?? item.userId} (${item.userId})` : `app ${item.botId ?? "unknown"}`;
    return buildThreadContext(history, message.ts, this.config.threadContextLimit, describe, (text) => renderSlackText(text, own.botUserId, names));
  }

  // Operator controls for the harness itself, for admins in the agents' DM: `.status`, `.stop ada`, `.compact ada`, `.reset ada`.
  // Replies are marked as coming from the bridge, never from an agent.
  private async handleOperatorCommand(message: SlackInbound): Promise<boolean> {
    const [rawCommand, target] = message.text.trim().split(/\s+/);
    const command = rawCommand?.toLowerCase() ?? "";
    if (message.channelType !== "im" || !message.userId || !OPERATOR_COMMANDS.has(command)) return false;
    if (!this.config.adminUserIds.includes(message.userId)) return false;
    const slack = this.requireSlack();
    // A redelivered command must not run twice.
    if (!this.store.recordHandled("_bridge", sourceKey(message), message.text)) return true;

    const named = target ? this.seats.get(target.toLowerCase()) : undefined;
    const targets = named ? [named] : target === "all" || command === ".status" || this.seats.size === 1 ? [...this.seats.values()] : [];
    let reply: string;
    if (targets.length === 0) {
      reply = `Which agent? Try \`${command} <name>\` or \`${command} all\`. Agents: ${[...this.seats.keys()].join(", ")}`;
    } else if (command === ".status") {
      reply = targets
        .map((seat) => {
          const state = this.store.getAgentState(seat.spec.name);
          return [
            `*${seat.spec.name}* · ${seat.mind.state()} · ${seat.spec.runtime}${seat.spec.model ? ` (${seat.spec.model})` : ""} on ${seat.spec.host.kind === "local" ? "this machine" : seat.spec.host.target}`,
            `session ${seat.mind.sessionId() ?? "none yet"} · queued input ${this.store.listQueued(seat.spec.name).length} · last error: ${state?.lastError ?? "none"}`,
          ].join("\n");
        })
        .join("\n");
    } else {
      for (const seat of targets) {
        if (command === ".stop") await seat.mind.interrupt();
        else if (command === ".compact") await seat.mind.compact();
        else await seat.mind.resetSession();
      }
      const done = command === ".stop" ? "interrupt sent to" : command === ".compact" ? "compaction requested for" : "session forgotten for";
      reply = `${done} ${targets.map((seat) => seat.spec.name).join(", ")}`;
    }
    await slack.postMessage({ channelId: message.channelId, threadTs: message.threadTs, text: `_bridge_\n${reply}` });
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
