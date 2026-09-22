import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { logError, logInfo, logWarn } from "../logger.js";
import { ClaudeRuntime } from "../runtimes/claudeRuntime.js";
import { CodexRuntime } from "../runtimes/codexRuntime.js";
import { AgentSlackClient, type SlackHistoryMessage, type SlackInbound, type SlackPersona, type SlackReaction } from "../slack/agentSlack.js";
import { prepareSlackAttachments, type AttachmentConfig } from "../slack/attachments.js";
import { WebhookIngressServer, type WebhookServerConfig } from "../webhooks/server.js";
import { AgentStore } from "./agentStore.js";
import { buildThreadContext, formatTime, mentionsUser, renderEnvelope, renderReactionEnvelope, renderSlackText, sourceKey, type EnvelopeAuthor, type ThreadContext, type WakeDecision } from "./envelope.js";
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
  // Set when the agent retired itself mid-turn; it stops when that turn ends.
  retiring: boolean;
  // Threads currently showing this agent as working.
  statusThreads: Map<string, { channelId: string; threadTs: string }>;
  // Threads the agent marked as waiting on the person or done during this turn; the end of the turn leaves them so.
  markedThreads: Set<string>;
  lastState: RuntimeState;
}

// An agent-to-agent exchange that has been quiet this long starts over with a full budget.
const AGENT_WAKE_BUDGET_QUIET_MS = 30 * 60_000;
// How sure the judgment must be before a message in plain words stops a working agent.
const STOP_THRESHOLD = 0.8;
const RECENT_MESSAGES = 8;

const OPERATOR_COMMANDS = new Set([".status", ".stop", ".compact", ".reset", ".retire", ".revive", ".delete"]);
// Marks a Slack event as taken in, whoever it woke, so a second copy of it is ignored.
const INTAKE = "_intake";
// How far back a wake in a channel looks along its main line: this many messages, and no older than this.
const CHANNEL_CATCH_UP_MESSAGES = 30;
const CHANNEL_CATCH_UP_SECONDS = 24 * 60 * 60;
// The index of who spoke where keeps this much.
const MESSAGE_INDEX_DAYS = 30;
const WHATS_NEW_CONVERSATIONS = 15;

export function personaOf(spec: AgentSpec): SlackPersona {
  return { username: spec.name, icon: spec.icon };
}

// Turns the judgment into who gets woken, which is also who receives the message.
export function decideWakes(
  verdict: Verdict,
  ruleVerdict: Verdict,
  agents: AgentSpec[],
  context: { authorKind: "human" | "agent" | "app"; authorAgent: string | null; isDirectMessage: boolean; appMentioned: boolean; defaultAgent: string | null },
): Map<string, WakeDecision> {
  const decisions = new Map<string, WakeDecision>();
  for (const agent of agents) {
    if (agent.name === context.authorAgent) continue;
    const used = agent.wake.natural ? verdict : ruleVerdict;
    const probability = used.needs.get(agent.name) ?? 0;
    const wake = probability >= agent.wake.threshold;
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
  // Conversations whose recent messages have been read back from Slack since this process started.
  private readonly hydrated = new Set<string>();
  // Agents that changed their own spec mid-turn and restart when the turn ends.
  private readonly pendingRestart = new Set<string>();
  // The latest search token Slack attached to an @-mention or DM. A search runs as the person whose message carried it.
  // Slack does not say how long one lasts.
  private actionToken: string | null = null;
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
    // The person's own title stays; the owning agent's name stays in front of it, since that is how sessions are told apart.
    slack.onSessionTitleChanged(async (change) => {
      const owner = this.store.dmOwner(change.channelId, change.threadTs);
      if (!owner || change.title.toLowerCase().startsWith(`${owner} ·`)) return;
      await slack.renameSession(change.channelId, change.threadTs, `${owner} · ${change.title}`.slice(0, 200)).catch(() => {});
    });
    // Starters at the top of the DM, built from whoever is on the roster right now.
    slack.onMessagesTabOpened(async (opened) => {
      const live = [...this.seats.values()].filter((seat) => !seat.retiring).map((seat) => seat.spec);
      const prompts = [
        { title: "Who is around?", message: "who is on the team right now, and what is each of you for?" },
        ...live.slice(0, 3).map((spec) => ({ title: `Talk to ${spec.name}`, message: `${spec.name}, what are you working on?` })),
      ];
      await slack.setSuggestedPrompts(opened.channelId, prompts, "Start with an agent");
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
    this.store.pruneMessageIndex(((Date.now() - MESSAGE_INDEX_DAYS * 86_400_000) / 1000).toFixed(6));

    const active = specs.filter((spec) => !spec.retired);
    const results = await Promise.allSettled(active.map((spec) => this.startSeat(spec)));
    results.forEach((result, index) => {
      if (result.status === "rejected") logError("agent failed to start", { agent: active[index]!.name, error: errorMessage(result.reason) });
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
    const seat: Seat = { spec, mind: null as unknown as AgentMind, retiring: false, statusThreads: new Map(), markedThreads: new Set(), lastState: "down" };
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
        latestActionToken: () => this.actionToken,
        noteRead: (channelId, threadKey, ts) => this.store.markSeen(spec.name, channelId, threadKey, ts),
        dm: {
          ownerOf: (channelId, threadTs) => this.store.dmOwner(channelId, threadTs),
          claim: (channelId, threadTs) => void this.store.claimDmSession(channelId, threadTs, spec.name),
          sessions: (channelId) => this.store.dmSessions(spec.name, channelId),
        },
        fetchFiles: (key, files) => prepareSlackAttachments(key, files, [], slack.botTokenForDownloads(), this.config),
        markSession: async (channelId, threadTs, state) => {
          seat.markedThreads.add(`${channelId}:${threadTs}`);
          await slack.setThreadStatus(channelId, threadTs, state === "waiting" ? "suspended" : "closed", personaOf(spec));
        },
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
        description: "List the agents on the roster: their names, roles, and whether they are working right now, plus any retired ones. Address an agent by writing its name in a message, the way you would a person.",
        shape: {},
        handler: async () =>
          (this.registry?.specs() ?? [])
            .map((other) => {
              const live = this.seats.get(other.name);
              // An agent at rest has no process running; it still wakes the moment it is addressed, so it is never shown as "down".
              const state = other.retired ? "retired" : live?.mind.state() === "running" ? "working right now" : "available, wakes when addressed";
              return `${other.name}${other.name === seat.spec.name ? " (you)" : ""} · ${other.title ?? "teammate"} · ${other.model ?? other.runtime} · ${state}`;
            })
            .join("\n"),
      }),
      define({
        name: "update_agent",
        description:
          "Repurpose an agent, yourself included: change its role line, its standing instructions, its model, or its icon. The agent keeps its name, memory, and session and is told its instructions changed. Say in Slack what you changed and why.",
        shape: {
          name: z.string().regex(agentNamePattern),
          title: z.string().min(1).optional().describe("New role line."),
          instructions: z.string().min(1).optional().describe("New standing instructions, replacing the old ones in full."),
          model: z.string().optional().describe("New model for its runtime."),
          icon: z.string().optional(),
        },
        handler: async (args) => {
          const registry = this.requireRegistry();
          if (!registry.has(args.name)) return `no agent named ${args.name}`;
          if (args.title === undefined && args.instructions === undefined && args.model === undefined && args.icon === undefined) return "nothing to change";
          const spec = registry.update(args.name, { title: args.title, model: args.model, icon: args.icon }, args.instructions);
          if (args.name === seat.spec.name) {
            // Its own restart waits for this turn to end, or the tool result could never come back.
            seat.retiring = false;
            this.pendingRestart.add(args.name);
            return `updated ${spec.name}. The change takes effect when this turn ends.`;
          }
          if (!spec.retired) await this.restartSeat(spec);
          logInfo("agent updated by an agent", { agent: spec.name, by: seat.spec.name, changed: Object.keys(args).filter((key) => key !== "name") });
          return `updated ${spec.name}. It is running with the change now.`;
        },
      }),
      define({
        name: "retire_agent",
        description:
          "Retire an agent whose job is done, yourself included. It stops listening but keeps its name, home, memory, and session, and can be brought back with revive_agent. Say in Slack that it retired and why. To remove an agent for good, use delete_agent.",
        shape: { name: z.string().regex(agentNamePattern), reason: z.string().min(1) },
        handler: async (args) => {
          const registry = this.requireRegistry();
          const spec = registry.spec(args.name);
          if (!spec) return `no agent named ${args.name}`;
          if (spec.retired) return `${args.name} is already retired`;
          if (this.liveAgents().length <= 1) return `${args.name} is the only agent listening; retire it and nobody would hear anyone. Create or revive another first.`;
          registry.update(args.name, { retired: true, retiredReason: args.reason });
          if (args.name === seat.spec.name) {
            seat.retiring = true;
            return `you are retired as of the end of this turn. Finish what is due, say so in Slack, and stop.`;
          }
          await this.stopSeat(args.name);
          logInfo("agent retired", { agent: args.name, by: seat.spec.name, reason: args.reason });
          return `retired ${args.name}. It no longer hears anything; revive_agent brings it back.`;
        },
      }),
      define({
        name: "revive_agent",
        description: "Bring a retired agent back, with its memory and session as they were. Pass new instructions to repurpose it at the same time.",
        shape: { name: z.string().regex(agentNamePattern), title: z.string().min(1).optional(), instructions: z.string().min(1).optional() },
        handler: async (args) => {
          const registry = this.requireRegistry();
          const known = registry.spec(args.name);
          if (!known) return `no agent named ${args.name}`;
          if (!known.retired) return `${args.name} is not retired`;
          const spec = registry.update(args.name, { retired: false, title: args.title }, args.instructions);
          const revived = this.startSeat(spec);
          await revived.mind.start();
          logInfo("agent revived", { agent: args.name, by: seat.spec.name });
          return `revived ${spec.name}. It is listening now.`;
        },
      }),
      define({
        name: "delete_agent",
        description:
          "Tear an agent down for good: its roster entry, inbox, session record, and home directory on the bridge are removed. Its Slack messages stay. You cannot delete yourself; retire instead. Prefer retire_agent unless the agent will never be needed again. Say in Slack that it was deleted and why.",
        shape: { name: z.string().regex(agentNamePattern), reason: z.string().min(1), confirm: z.literal(true).describe("You have considered retire_agent and mean to delete.") },
        handler: async (args) => {
          const registry = this.requireRegistry();
          if (args.name === seat.spec.name) return "you cannot delete yourself; retire_agent is the way to stand down.";
          if (!registry.has(args.name)) return `no agent named ${args.name}`;
          if (this.liveAgents().filter((name) => name !== args.name).length < 1) return `${args.name} is the only agent listening; create another first.`;
          await this.stopSeat(args.name);
          const spec = registry.remove(args.name);
          this.store.forgetAgent(args.name);
          // Only a home the bridge made is the bridge's to remove.
          if (spec.host.kind === "local" && spec.cwd.startsWith(`${this.config.agentsRoot}${path.sep}`)) fs.rmSync(spec.cwd, { recursive: true, force: true });
          logInfo("agent deleted", { agent: args.name, by: seat.spec.name, reason: args.reason });
          return `deleted ${args.name}.`;
        },
      }),
      define({
        name: "whats_new",
        description:
          "What has been said since you last looked, across the conversations you can see: counts only, no content, like unread badges. Asking clears them. The counts come from what the bridge saw while it was running, so treat them as a good hint, not an audit. Most of it will not concern you; read a conversation (read_history) only when your work needs it.",
        shape: {},
        handler: async () => {
          const slack = this.requireSlack();
          const rows = this.store.whatsNew(seat.spec.name, (Date.now() / 1000).toFixed(6), WHATS_NEW_CONVERSATIONS);
          if (rows.length === 0) return "nothing new since you last looked";
          const lines: string[] = [];
          for (const row of rows) {
            const conversation = await slack.getConversation(row.channelId).catch(() => null);
            const place = row.channelType === "im" ? "your direct-message session" : row.channelType === "mpim" ? "group DM" : `#${conversation?.name ?? "unknown"}`;
            const where = `${place} (channel=${row.channelId}${row.threadKey === "top" ? ", main line" : ` thread_ts=${row.threadKey}`})`;
            lines.push(`${where}: ${row.count} new, last at ${formatTime(row.lastTs, this.config.timezone)}, from ${row.authors.join(", ")}`);
          }
          return lines.join("\n");
        },
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

  private requireRegistry(): AgentRegistry {
    if (!this.registry) throw new Error("the hub is not started");
    return this.registry;
  }

  private liveAgents(): string[] {
    return [...this.seats.keys()].filter((name) => !this.seats.get(name)!.retiring);
  }

  private async stopSeat(name: string): Promise<void> {
    const seat = this.seats.get(name);
    if (!seat) return;
    this.seats.delete(name);
    await seat.mind.stop();
  }

  // The same agent, with a changed spec: same session, same inbox, new instructions and runtime options.
  private async restartSeat(spec: AgentSpec): Promise<void> {
    await this.stopSeat(spec.name);
    const seat = this.startSeat(spec);
    await seat.mind.start();
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
    // An agent that changed or retired itself during the turn is dealt with now that the turn is over.
    if (seat.retiring) {
      logInfo("agent retired itself", { agent: seat.spec.name });
      void this.stopSeat(seat.spec.name);
    } else if (this.pendingRestart.delete(seat.spec.name)) {
      const spec = this.requireRegistry().spec(seat.spec.name);
      if (spec) void this.restartSeat(spec);
    }
    const threads = [...seat.statusThreads.entries()].filter(([key]) => !seat.markedThreads.has(key)).map(([, thread]) => thread);
    seat.statusThreads.clear();
    seat.markedThreads.clear();
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

  // Slack events and agents' own posts arrive here, one at a time. Only the agents a message is said to receive it.
  // Each is handed what it missed in that conversation, and can read further back itself, the way a person catches up
  // when a notification pulls them in.
  async handleInbound(message: SlackInbound): Promise<void> {
    const slack = this.requireSlack();
    try {
      if (message.actionToken) this.actionToken = message.actionToken;
      const key = sourceKey(message);
      // Slack sends a mention twice, and sends events again after a dropped connection.
      if (this.store.hasSource(INTAKE, key)) return;
      const identity = slack.identity();
      const threadRoot = message.threadTs ?? message.ts;
      // In the app's direct message every thread is a session of its own, so a top-level message there opens one.
      const isDm = message.channelType === "im";
      const threadKey = isDm ? threadRoot : (message.threadTs ?? "top");
      const conversationKey = `${message.channelId}:${threadKey}`;
      const author = await this.describeAuthor(message);
      this.store.indexMessage({ channelId: message.channelId, channelType: message.channelType, threadKey, ts: message.ts, author: author.name });

      let listeners = [...this.seats.values()].filter((seat) => seat.spec.name !== message.agentAuthor);
      // A DM session belongs to one agent. Only it hears what is said there, whoever is named.
      const sessionOwner = isDm ? this.store.dmOwner(message.channelId, threadRoot) : null;
      if (sessionOwner && this.seats.has(sessionOwner)) listeners = listeners.filter((seat) => seat.spec.name === sessionOwner);
      if (listeners.length === 0) {
        this.store.recordHandled(INTAKE, key, "");
        return;
      }
      const names = new Map<string, string>();
      for (const match of message.text.matchAll(/<@([A-Z0-9]+)/g)) {
        if (!names.has(match[1]!)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
      }
      const conversation = await slack.getConversation(message.channelId).catch(() => null);
      const plainText = renderSlackText(message.text, identity.botUserId, names);
      await this.hydrateRecent(conversationKey, message);

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
      this.remember(message.channelId, threadKey, judgeInput.message, !isDm);

      if (isDm) {
        const owner = sessionOwner && decisions.has(sessionOwner) ? sessionOwner : [...decisions.entries()].filter(([, decision]) => decision.wake).sort((a, b) => (b[1].probability ?? 0) - (a[1].probability ?? 0))[0]?.[0];
        for (const [name, decision] of decisions) decisions.set(name, name === owner ? { ...decision, wake: true, reason: decision.wake ? decision.reason : "addressed" } : { ...decision, wake: false, reason: "none" });
        if (owner && !sessionOwner) {
          this.store.claimDmSession(message.channelId, threadRoot, owner);
          // The title is how the person tells their sessions apart; the agent gives it a real one once it knows the subject.
          void slack.renameSession(message.channelId, threadRoot, owner).catch(() => {});
        }
      }

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

      const woken: Array<{ seat: Seat; decision: WakeDecision }> = [];
      for (const seat of listeners) {
        const { spec } = seat;
        let decision = decisions.get(spec.name);
        if (!decision) continue;
        // A person telling a working agent to stop, in plain words, stops it. The message still reaches it, so it knows why.
        if (author.kind === "human" && (verdict.stop.get(spec.name) ?? 0) >= STOP_THRESHOLD) {
          logInfo("stop requested in conversation", { agent: spec.name });
          await seat.mind.interrupt();
          decision = { ...decision, wake: true, reason: decision.wake ? decision.reason : "addressed" };
        }
        if (!decision.wake) continue;
        if (author.kind === "agent") {
          const budgetKey = `${spec.name}|${conversationKey}`;
          const count = (this.agentWakeCounts.get(budgetKey)?.count ?? 0) + 1;
          this.agentWakeCounts.set(budgetKey, { count, lastAt: now });
          if (count > this.config.agentWakeBudget) {
            // The message stays in Slack; the agent sees it as missed context the next time a person brings it in.
            logWarn("agent-to-agent wake budget spent; not waking", { agent: spec.name, channelId: message.channelId, threadRoot });
            continue;
          }
        }
        // Already handed over before a crash or restart.
        if (!this.store.hasSource(spec.name, key)) woken.push({ seat, decision });
      }

      // Shown the moment the message is routed, before any downloading or catching up, because that is when the system
      // has in fact taken it. Slack shows it under the agent's own name.
      for (const { seat } of woken) {
        seat.statusThreads.set(`${message.channelId}:${threadRoot}`, { channelId: message.channelId, threadTs: threadRoot });
        void slack.setThreadStatus(message.channelId, threadRoot, "processing", personaOf(seat.spec));
      }

      let imagePaths: string[] = [];
      let fileNotes: string[] = [];
      if (message.files.length > 0 && woken.length > 0) {
        const prepared = await prepareSlackAttachments(key, message.files, [], slack.botTokenForDownloads(), this.config);
        imagePaths = prepared.imagePaths;
        fileNotes = prepared.fileNotes;
      }
      fileNotes.push(...message.unavailableFiles.map((name) => `${name} (Slack gave no download link)`));

      for (const { seat, decision } of woken) {
        const { spec } = seat;
        const missed = await this.fetchMissed(spec.name, message).catch((error) => {
          logWarn("catch-up context fetch failed", { agent: spec.name, error: errorMessage(error) });
          return null;
        });
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
          imageCount: imagePaths.length,
          timezone: this.config.timezone,
          threadContext: missed,
          alsoWoken: woken.filter((other) => other.seat !== seat).map((other) => other.seat.spec.name),
          viewing: await this.describeViewing(message),
        });
        await seat.mind
          .receive({ sourceKey: key, wake: true, priority: verdict.urgency, text, imagePaths })
          .catch((error) => logWarn("input queued; the agent could not take it yet", { agent: spec.name, error: errorMessage(error) }));
        this.store.markSeen(spec.name, message.channelId, threadKey, message.ts);
      }
      this.store.recordHandled(INTAKE, key, "");
    } catch (error) {
      logError("inbound handling failed", { channelId: message.channelId, ts: message.ts, error: errorMessage(error) });
    }
  }

  // A reaction on an agent's own message always reaches that agent. Whether a thumbs-up needs anything is for the agent,
  // which knows what it said and why, to decide.
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
      const excerpt = renderSlackText(target.text, slack.identity().botUserId, new Map()).replace(/[\r\n]+/g, " ").slice(0, 200);
      this.remember(reaction.channelId, channelType === "im" ? threadRoot : (target.threadTs ?? "top"), { from: `${author.name} (${author.kind})`, text: `(reacted :${reaction.emoji}: to ${seat.spec.name}'s message "${excerpt}")` });

      const text = renderReactionEnvelope({
        reaction,
        channelType,
        channelName: conversation?.name ?? null,
        author,
        wake: true,
        target: { threadTs: target.threadTs, text: target.text },
        appUserId: slack.identity().botUserId,
        timezone: this.config.timezone,
      });
      seat.statusThreads.set(`${reaction.channelId}:${threadRoot}`, { channelId: reaction.channelId, threadTs: threadRoot });
      void slack.setThreadStatus(reaction.channelId, threadRoot, "processing", personaOf(seat.spec));
      await seat.mind
        .receive({ sourceKey: key, wake: true, priority: "next", text, imagePaths: [] })
        .catch((error) => logWarn("input queued; the agent could not take it yet", { agent: seat.spec.name, error: errorMessage(error) }));
    } catch (error) {
      logError("reaction handling failed", { channelId: reaction.channelId, ts: reaction.itemTs, error: errorMessage(error) });
    }
  }

  // What the judgment model sees as "what was just said": the conversation itself, and for a channel's main line also
  // what happened in its threads, since that is what a person scrolling the channel has in view.
  private remember(channelId: string, threadKey: string, message: JudgeMessage, showOnMainLine = true): void {
    const push = (conversationKey: string, entry: JudgeMessage): void => {
      const list = this.recent.get(conversationKey) ?? [];
      list.push({ from: entry.from, text: entry.text.slice(0, 600) });
      this.recent.set(conversationKey, list.slice(-RECENT_MESSAGES));
      if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
    };
    push(`${channelId}:${threadKey}`, message);
    if (threadKey !== "top" && showOnMainLine) push(`${channelId}:top`, { from: message.from, text: `(in a thread) ${message.text}` });
  }

  // After a restart the bridge remembers nothing of a conversation, but Slack does. Read it once, so an un-named reply is
  // judged with the same view a person has.
  private async hydrateRecent(conversationKey: string, message: SlackInbound): Promise<void> {
    if (this.hydrated.has(conversationKey)) return;
    this.hydrated.add(conversationKey);
    if (this.hydrated.size > 2000) this.hydrated.delete(this.hydrated.values().next().value!);
    if ((this.recent.get(conversationKey) ?? []).length > 0) return;
    try {
      const slack = this.requireSlack();
      const own = slack.identity();
      const describe = async (item: SlackHistoryMessage): Promise<string> => {
        if (item.botId === own.botId) return `${item.username ?? "an agent"} (agent)`;
        if (!item.userId) return "an app (app)";
        const person = await slack.getPerson(item.userId);
        return `${person.name} (${person.isBot ? "app" : "human"})`;
      };
      const entries: JudgeMessage[] = [];
      // A new DM session starts clean; the person's other sessions are other agents' business.
      if (message.channelType === "im" && !message.threadTs) return;
      if (message.threadTs) {
        const history = await slack.readHistory({ channelId: message.channelId, threadTs: message.threadTs, limit: 50 });
        for (const item of history.filter((earlier) => earlier.ts < message.ts).slice(-RECENT_MESSAGES)) {
          entries.push({ from: await describe(item), text: renderSlackText(item.text, own.botUserId, new Map()).slice(0, 600) });
        }
      } else {
        const history = await slack.readHistory({ channelId: message.channelId, limit: RECENT_MESSAGES, before: message.ts });
        // Agents answer in threads, which the main line's history leaves out; the latest thread is the live exchange.
        const lastThreaded = [...history].reverse().find((item) => item.replyCount > 0);
        const replies = lastThreaded ? (await slack.readHistory({ channelId: message.channelId, threadTs: lastThreaded.ts, limit: 20 })).filter((item) => item.ts !== lastThreaded.ts && item.ts < message.ts).slice(-3) : [];
        for (const item of history) {
          entries.push({ from: await describe(item), text: renderSlackText(item.text, own.botUserId, new Map()).slice(0, 600) });
          if (item === lastThreaded) for (const reply of replies) entries.push({ from: await describe(reply), text: `(in a thread) ${renderSlackText(reply.text, own.botUserId, new Map()).slice(0, 600)}` });
        }
      }
      if (entries.length > 0) this.recent.set(conversationKey, entries.slice(-RECENT_MESSAGES));
    } catch (error) {
      logWarn("could not read recent messages for the judgment", { conversationKey, error: errorMessage(error) });
    }
  }

  // "#general (C1), thread 123.4" from what Slack says the person had open. Null when Slack said nothing.
  private async describeViewing(message: SlackInbound): Promise<string | null> {
    if (!message.viewing || message.viewing.length === 0) return null;
    const slack = this.requireSlack();
    const parts: string[] = [];
    for (const entity of message.viewing) {
      if (entity.kind === "channel_id") {
        const conversation = await slack.getConversation(entity.value).catch(() => null);
        parts.push(conversation?.name ? `#${conversation.name} (${entity.value})` : entity.value);
      } else if (entity.kind === "thread_ts") parts.push(`thread ${entity.value}`);
      else parts.push(`${entity.kind.replace(/_id$/, "")} ${entity.value}`);
    }
    return parts.join(", ");
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

  // What the agent has not been given from this conversation: everything in the thread, or the channel's recent main line,
  // since its last-read marker. On its first time here it gets the latest messages, its own included.
  private async fetchMissed(agent: string, message: SlackInbound): Promise<ThreadContext> {
    const slack = this.requireSlack();
    // A message that opens a DM session has nothing before it that belongs to this agent.
    if (message.channelType === "im" && !message.threadTs) return { kind: "thread", messages: [], total: 0 };
    const after = this.store.lastSeen(agent, message.channelId, message.threadTs ?? "top");
    const oldest = (Number(message.ts.split(".")[0]) - CHANNEL_CATCH_UP_SECONDS).toFixed(6);
    const fetched = message.threadTs
      ? await slack.readHistory({ channelId: message.channelId, threadTs: message.threadTs, limit: 200 })
      : (await slack.readHistory({ channelId: message.channelId, limit: CHANNEL_CATCH_UP_MESSAGES, before: message.ts })).filter((item) => item.ts >= oldest);
    const own = slack.identity();
    // Past its marker, the agent already knows what it said itself.
    const history = after ? fetched.filter((item) => !(item.botId === own.botId && item.username === agent)) : fetched;
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
    return buildThreadContext(message.threadTs ? "thread" : "channel", history, after, message.ts, this.config.threadContextLimit, describe, (text) => renderSlackText(text, own.botUserId, names));
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
    if (targets.length === 0 && command !== ".revive" && command !== ".delete") {
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
    } else if (command === ".revive" || command === ".delete") {
      const registry = this.requireRegistry();
      const name = target?.toLowerCase() ?? "";
      const known = registry.spec(name);
      if (!known) reply = `no agent named ${name}`;
      else if (command === ".revive") {
        if (!known.retired) reply = `${name} is not retired`;
        else {
          const spec = registry.update(name, { retired: false });
          await this.startSeat(spec).mind.start();
          reply = `revived ${name}`;
        }
      } else {
        await this.stopSeat(name);
        const spec = registry.remove(name);
        this.store.forgetAgent(name);
        if (spec.host.kind === "local" && spec.cwd.startsWith(`${this.config.agentsRoot}${path.sep}`)) fs.rmSync(spec.cwd, { recursive: true, force: true });
        reply = `deleted ${name}`;
      }
    } else {
      for (const seat of targets) {
        if (command === ".stop") await seat.mind.interrupt();
        else if (command === ".compact") await seat.mind.compact();
        else if (command === ".retire") {
          this.requireRegistry().update(seat.spec.name, { retired: true, retiredReason: "retired by an operator" });
          await this.stopSeat(seat.spec.name);
        } else {
          await seat.mind.resetSession();
          // A new session knows nothing, so its next wake anywhere brings full context again.
          this.store.clearSeen(seat.spec.name);
        }
      }
      const done = command === ".stop" ? "interrupt sent to" : command === ".compact" ? "compaction requested for" : command === ".retire" ? "retired" : "session forgotten for";
      reply = `${done} ${targets.map((seat) => seat.spec.name).join(", ")}`;
    }
    await slack.postMessage({ channelId: message.channelId, threadTs: message.threadTs, text: `_bridge_\n${reply}` });
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
