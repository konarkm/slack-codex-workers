import process from "node:process";
import { DEFAULT_EFFORTS, type AppConfig } from "../config.js";
import { parseSlashCommand, helpText, normalizeEffort } from "./commands.js";
import { CodexClient, type DynamicToolHandlerContext } from "../codex/client.js";
import { Store } from "../db/store.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { prepareSlackAttachments } from "../slack/attachments.js";
import { appendFileNotes, renderFinalMessage, renderWorklog } from "../slack/renderer.js";
import { SlackGateway } from "../slack/slackGateway.js";
import type {
  DmSessionRecord,
  ReasoningEffort,
  RuntimeSettings,
  SlackAttachmentInput,
  SlackMessageContext,
  WorkerRecord,
  WorklogItem,
} from "../types.js";

interface RenderSessionState {
  worklogItems: Map<string, WorklogItem>;
  pendingEdits: Map<string, NodeJS.Timeout>;
  latestTexts: Map<string, string>;
}

export class SlackCodexWorkersService {
  private readonly store: Store;
  private readonly codex: CodexClient;
  private readonly slack: SlackGateway;
  private readonly renderState = new Map<string, RenderSessionState>();

  constructor(private readonly config: AppConfig) {
    this.store = new Store(config.databasePath);
    this.codex = new CodexClient(config.codexBin, config.codexCwd);
    this.slack = new SlackGateway(config);
    this.codex.registerDynamicToolHandlers({
      listChannels: async (args, ctx) => this.handleListChannelsTool(args.query ?? "", ctx),
      spawnWorker: async (args, ctx) => this.handleSpawnWorkerTool(args, ctx),
    });
  }

  async start(): Promise<void> {
    await this.codex.start();
    this.registerSlackHandlers();
    await this.slack.start();
    logInfo("Slack Codex Workers ready");
  }

  async stop(): Promise<void> {
    await this.slack.stop();
    await this.codex.stop();
    this.store.close();
  }

  private registerSlackHandlers(): void {
    this.slack.app.event("message", async ({ event }) => {
      await this.handleMessageEvent(event);
    });
  }

  private async handleMessageEvent(event: unknown): Promise<void> {
    if (!event || typeof event !== "object") return;
    const eventRecord = event as Record<string, unknown>;
    if (typeof eventRecord.user !== "string") return;
    if (typeof eventRecord.text !== "string") return;
    if (eventRecord.bot_id || eventRecord.subtype === "bot_message" || eventRecord.subtype === "message_changed") return;
    if (typeof eventRecord.channel !== "string" || typeof eventRecord.ts !== "string") return;

    const teamId = this.slack.getTeamId() ?? this.config.allowedTeamId ?? "single-workspace";

    const userId = eventRecord.user;
    const username = await this.slack.getUserDisplayName(userId);
    const channelId = eventRecord.channel;
    const threadTs = typeof eventRecord.thread_ts === "string" ? eventRecord.thread_ts : null;
    const context: SlackMessageContext = {
      teamId,
      channelId,
      userId,
      username,
      text: eventRecord.text,
      ts: eventRecord.ts,
      threadTs,
      isDm: typeof eventRecord.channel_type === "string" && eventRecord.channel_type === "im",
      files: this.slack.extractFiles(eventRecord),
    };

    const dedupeKind = context.isDm ? "dm-message" : threadTs ? "thread-reply" : "channel-root";
    if (this.store.hasProcessedMessage(teamId, channelId, context.ts, dedupeKind)) {
      return;
    }
    this.store.markProcessedMessage(teamId, channelId, context.ts, dedupeKind);

    if (context.isDm) {
      await this.handleDmMessage(context);
      return;
    }

    if (!threadTs) {
      await this.handleTopLevelChannelMessage(context);
      return;
    }

    await this.handleChannelThreadReply(context);
  }

  private async handleTopLevelChannelMessage(context: SlackMessageContext): Promise<void> {
    const existing = this.store.getWorker(context.teamId, context.channelId, context.ts);
    if (existing) return;

    const defaults = this.store.getTeamDefaults(context.teamId);
    const started = await this.codex.createWorkerThread(defaults);
    const worker = this.store.upsertWorker({
      key: `${context.teamId}:${context.channelId}:${context.ts}`,
      teamId: context.teamId,
      channelId: context.channelId,
      rootTs: context.ts,
      appThreadId: started.threadId,
      activeTurnId: null,
      ownerUserId: context.userId,
      rootOwnerUserId: context.userId,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      settings: defaults,
      parentWorkerKey: null,
    });
    await this.startWorkerTurn(worker, await this.toTurnInput(context, true));
  }

  private async handleChannelThreadReply(context: SlackMessageContext): Promise<void> {
    const worker = this.store.getWorker(context.teamId, context.channelId, context.threadTs!);
    if (!worker) return;

    const command = parseSlashCommand(context.text);
    if (command) {
      await this.handleThreadCommand(worker, command.name, command.args);
      return;
    }

    const input = await this.toTurnInput(context, true);
    if (worker.activeTurnId) {
      await this.codex.steerTurn(worker.appThreadId, worker.activeTurnId, input);
      return;
    }
    await this.startWorkerTurn(worker, input);
  }

  private async handleDmMessage(context: SlackMessageContext): Promise<void> {
    if (!this.config.adminUserIds.includes(context.userId)) {
      await this.slack.postThreadReply(context.channelId, context.threadTs ?? context.ts, "Not authorized.");
      return;
    }

    const command = parseSlashCommand(context.text);
    if (command) {
      const response = await this.handleDmCommand(context.teamId, context.channelId, context.userId, command.name, command.args);
      await this.slack.postThreadReply(context.channelId, context.threadTs ?? context.ts, response);
      return;
    }

    const current = this.store.getDmSession(context.teamId, context.userId);
    const session = current ?? this.store.upsertDmSession({
      teamId: context.teamId,
      userId: context.userId,
      channelId: context.channelId,
      appThreadId: null,
      activeTurnId: null,
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      settings: this.store.getTeamDefaults(context.teamId),
    });

    if (!session.appThreadId) {
      const created = await this.codex.createAdminThread(session.settings);
      const updated = this.store.upsertDmSession({
        ...session,
        channelId: context.channelId,
        appThreadId: created.threadId,
      });
      await this.startDmTurn(updated, await this.toTurnInput(context, true));
      return;
    }

    if (session.activeTurnId) {
      await this.codex.steerTurn(session.appThreadId, session.activeTurnId, await this.toTurnInput(context, true));
      return;
    }
    await this.startDmTurn(
      this.store.upsertDmSession({
        ...session,
        channelId: context.channelId,
      }),
      await this.toTurnInput(context, true),
    );
  }

  private async startWorkerTurn(worker: WorkerRecord, input: { text: string; imagePaths: string[] }): Promise<void> {
    const turnId = await this.codex.startTurnWithResumeFallback(
      worker.appThreadId,
      input,
      worker.settings,
      {
        onAgentDelta: async ({ itemId, delta }) => {
          await this.onWorkerAgentDelta(worker.key, itemId, delta);
        },
        onAgentMessage: async ({ itemId, text }) => {
          await this.onWorkerAgentMessage(worker.key, itemId, text);
        },
        onWorklogItem: async (event) => {
          await this.onWorkerWorklogItem(worker.key, event);
        },
        onCompleted: async ({ assistantText, status, error }) => {
          await this.onWorkerCompleted(worker.key, assistantText, status, error);
        },
      },
    );
    this.store.updateWorkerState(worker.key, { activeTurnId: turnId, status: "running" });
  }

  private async startDmTurn(session: DmSessionRecord, input: { text: string; imagePaths: string[] }): Promise<void> {
    const appThreadId = session.appThreadId ?? (await this.codex.createAdminThread(session.settings)).threadId;
    const turnId = await this.codex.startTurnWithResumeFallback(
      appThreadId,
      input,
      session.settings,
      {
        onAgentDelta: async ({ itemId, delta }) => {
          await this.onDmAgentDelta(session.teamId, session.userId, itemId, delta);
        },
        onAgentMessage: async ({ itemId, text }) => {
          await this.onDmAgentMessage(session.teamId, session.userId, itemId, text);
        },
        onWorklogItem: async (event) => {
          await this.onDmWorklogItem(session.teamId, session.userId, event);
        },
        onCompleted: async ({ assistantText, status, error }) => {
          await this.onDmCompleted(session.teamId, session.userId, assistantText, status, error);
        },
      },
    );
    this.store.upsertDmSession({
      ...session,
      appThreadId,
      activeTurnId: turnId,
    });
  }

  private async onWorkerAgentDelta(workerKey: string, itemId: string, delta: string): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    const slackTs = await this.ensureWorkerAgentMessage(worker, itemId, delta);
    await this.scheduleSlackEdit(`${worker.channelId}:${slackTs}`, worker.channelId, slackTs, (current) => `${current}${delta}`);
  }

  private async onWorkerAgentMessage(workerKey: string, itemId: string, text: string): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    const slackTs = await this.ensureWorkerAgentMessage(worker, itemId, text);
    await this.flushSlackEdit(`${worker.channelId}:${slackTs}`, worker.channelId, slackTs, text);
  }

  private async onWorkerWorklogItem(workerKey: string, event: WorklogItem): Promise<void> {
    const worker = this.requireWorker(workerKey);
    const state = this.getRenderState(`worker:${workerKey}`);
    state.worklogItems.set(event.itemId, event);

    let slackTs = worker.currentWorklogSlackTs;
    if (!slackTs) {
      slackTs = await this.slack.postThreadReply(worker.channelId, worker.rootTs, renderWorklog(state.worklogItems.values()));
      this.store.updateWorkerState(worker.key, { currentWorklogSlackTs: slackTs });
    } else {
      await this.scheduleSlackEdit(`${worker.channelId}:${slackTs}`, worker.channelId, slackTs, () => renderWorklog(state.worklogItems.values()));
    }
  }

  private async onWorkerCompleted(workerKey: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    this.store.updateWorkerState(workerKey, {
      activeTurnId: null,
      status,
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
    });
    const finalText = status === "completed"
      ? renderFinalMessage(worker.rootOwnerUserId, assistantText)
      : renderFinalMessage(worker.rootOwnerUserId, `Turn ${status}.${error ? ` ${error}` : ""}`);
    await this.slack.postThreadReply(worker.channelId, worker.rootTs, finalText);
  }

  private async onDmAgentDelta(teamId: string, userId: string, itemId: string, delta: string): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    const slackTs = await this.ensureDmAgentMessage(session, itemId, delta);
    await this.scheduleSlackEdit(`${session.channelId}:${slackTs}`, session.channelId, slackTs, (current) => `${current}${delta}`);
  }

  private async onDmAgentMessage(teamId: string, userId: string, itemId: string, text: string): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    const slackTs = await this.ensureDmAgentMessage(session, itemId, text);
    await this.flushSlackEdit(`${session.channelId}:${slackTs}`, session.channelId, slackTs, text);
  }

  private async onDmWorklogItem(teamId: string, userId: string, event: WorklogItem): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    const state = this.getRenderState(`dm:${teamId}:${userId}`);
    state.worklogItems.set(event.itemId, event);

    let slackTs = session.currentWorklogSlackTs;
    if (!slackTs) {
      slackTs = await this.slack.postTopLevelMessage(session.channelId, renderWorklog(state.worklogItems.values()));
      this.store.upsertDmSession({ ...session, currentWorklogSlackTs: slackTs });
    } else {
      await this.scheduleSlackEdit(`${session.channelId}:${slackTs}`, session.channelId, slackTs, () => renderWorklog(state.worklogItems.values()));
    }
  }

  private async onDmCompleted(teamId: string, userId: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    this.store.upsertDmSession({
      ...session,
      activeTurnId: null,
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
    });
    const text = status === "completed" ? assistantText : `Turn ${status}.${error ? ` ${error}` : ""}`;
    await this.slack.postTopLevelMessage(session.channelId, text || "Done.");
  }

  private async ensureWorkerAgentMessage(worker: WorkerRecord, itemId: string, initialText: string): Promise<string> {
    if (worker.currentAgentItemId === itemId && worker.currentAgentSlackTs) {
      return worker.currentAgentSlackTs;
    }
    const slackTs = await this.slack.postThreadReply(worker.channelId, worker.rootTs, initialText);
    this.store.updateWorkerState(worker.key, {
      currentAgentSlackTs: slackTs,
      currentAgentItemId: itemId,
      currentWorklogSlackTs: null,
    });
    return slackTs;
  }

  private async ensureDmAgentMessage(session: DmSessionRecord, itemId: string, initialText: string): Promise<string> {
    if (session.currentAgentItemId === itemId && session.currentAgentSlackTs) {
      return session.currentAgentSlackTs;
    }
    const slackTs = await this.slack.postTopLevelMessage(session.channelId, initialText);
    this.store.upsertDmSession({
      ...session,
      currentAgentSlackTs: slackTs,
      currentAgentItemId: itemId,
      currentWorklogSlackTs: null,
    });
    return slackTs;
  }

  private freezeWorklog(key: string, scope: "worker" | "dm"): void {
    const state = this.getRenderState(`${scope}:${key}`);
    state.worklogItems.clear();
  }

  private getRenderState(key: string): RenderSessionState {
    let state = this.renderState.get(key);
    if (!state) {
      state = {
        worklogItems: new Map(),
        pendingEdits: new Map(),
        latestTexts: new Map(),
      };
      this.renderState.set(key, state);
    }
    return state;
  }

  private async scheduleSlackEdit(editKey: string, channelId: string, slackTs: string, next: ((current: string) => string) | string): Promise<void> {
    const state = this.getRenderState("__edits__");
    const current = state.latestTexts.get(editKey) ?? "";
    const nextText = typeof next === "string" ? next : next(current);
    state.latestTexts.set(editKey, nextText);
    const existing = state.pendingEdits.get(editKey);
    if (existing) return;
    const timer = setTimeout(() => {
      void this.flushSlackEdit(editKey, channelId, slackTs, state.latestTexts.get(editKey) ?? "");
    }, this.config.messageEditThrottleMs);
    state.pendingEdits.set(editKey, timer);
  }

  private async flushSlackEdit(editKey: string, channelId: string, slackTs: string, text: string): Promise<void> {
    const state = this.getRenderState("__edits__");
    const pending = state.pendingEdits.get(editKey);
    if (pending) {
      clearTimeout(pending);
      state.pendingEdits.delete(editKey);
    }
    state.latestTexts.set(editKey, text);
    await this.slack.updateMessage(channelId, slackTs, text);
  }

  private async handleThreadCommand(worker: WorkerRecord, name: string, args: string[]): Promise<void> {
    let response = "";
    if (name === "help") {
      response = helpText("thread");
    } else if (name === "model") {
      if (args.length === 0) {
        response = `Model: ${worker.settings.model ?? "(default)"}\nEffort: ${worker.settings.effort ?? "(default)"}`;
      } else {
        worker.settings.model = args.join(" ");
        this.store.updateWorkerState(worker.key, { settings: worker.settings });
        response = `Thread model set: ${worker.settings.model}`;
      }
    } else if (name === "effort") {
      if (args.length === 0) {
        response = `Effort: ${worker.settings.effort ?? "(default)"}\nAllowed: ${DEFAULT_EFFORTS.join(", ")}`;
      } else {
        const effort = normalizeEffort(args[0]);
        if (!effort) {
          response = `Usage: /effort <${DEFAULT_EFFORTS.join("|")}>`;
        } else {
          worker.settings.effort = effort;
          this.store.updateWorkerState(worker.key, { settings: worker.settings });
          response = `Thread effort set: ${effort}`;
        }
      }
    } else if (name === "compact") {
      if (worker.activeTurnId) {
        response = "Cannot compact while the worker is active.";
      } else {
        await this.codex.compactThread(worker.appThreadId);
        response = `Compaction requested for thread ${worker.appThreadId}`;
      }
    } else {
      response = "This command is only available in DMs.";
    }
    await this.slack.postThreadReply(worker.channelId, worker.rootTs, response);
  }

  private async handleDmCommand(teamId: string, channelId: string, userId: string, name: string, args: string[]): Promise<string> {
    const defaults = this.store.getTeamDefaults(teamId);
    const session = this.store.getDmSession(teamId, userId);

    if (name === "help") return helpText("dm");
    if (name === "status") {
      const activeWorkerCount = this.store.listActiveWorkers().length;
      return [
        "Bridge Status",
        `team: ${teamId}`,
        `codex_cwd: ${this.config.codexCwd}`,
        `workers_active: ${activeWorkerCount}`,
        `default_model: ${defaults.model ?? "(unset)"}`,
        `default_effort: ${defaults.effort ?? "(unset)"}`,
        `dm_thread: ${session?.appThreadId ?? "(none)"}`,
      ].join("\n");
    }
    if (name === "model") {
      if (args.length === 0) return `Default model: ${defaults.model ?? "(unset)"}`;
      defaults.model = args.join(" ");
      this.store.setTeamDefaults(teamId, defaults);
      return `Default model set: ${defaults.model}`;
    }
    if (name === "effort") {
      if (args.length === 0) return `Default effort: ${defaults.effort ?? "(unset)"}\nAllowed: ${DEFAULT_EFFORTS.join(", ")}`;
      const effort = normalizeEffort(args[0]);
      if (!effort) return `Usage: /effort <${DEFAULT_EFFORTS.join("|")}>`;
      defaults.effort = effort;
      this.store.setTeamDefaults(teamId, defaults);
      return `Default effort set: ${effort}`;
    }
    if (name === "compact") {
      if (!session?.appThreadId) return "No DM admin thread to compact.";
      if (session.activeTurnId) return "Cannot compact while the DM admin thread is active.";
      await this.codex.compactThread(session.appThreadId);
      return `Compaction requested for thread ${session.appThreadId}`;
    }
    if (name === "restart") {
      const target = (args[0] ?? "").toLowerCase();
      if (!target || !["codex", "bridge", "both"].includes(target)) {
        return "Usage: /restart <codex|bridge|both>";
      }
      if (target === "codex") {
        await this.codex.restart();
        return "Codex restarted.";
      }
      if (target === "both") {
        await this.codex.stop();
      }
      setTimeout(() => process.exit(42), 300);
      return `Restarting ${target} now...`;
    }
    return "Unknown command. Use /help";
  }

  private async handleListChannelsTool(query: string, ctx: DynamicToolHandlerContext): Promise<string> {
    const worker = this.store.getWorkerByAppThreadId(ctx.threadId);
    if (!worker) return "No Slack worker context found.";
    const channels = await this.slack.listChannels(worker.teamId, query);
    this.store.upsertChannels(channels);
    if (channels.length === 0) return "No matching channels.";
    return channels.slice(0, 50).map((channel) => `${channel.name} (${channel.channelId})`).join("\n");
  }

  private async handleSpawnWorkerTool(
    args: { channel?: string | undefined; title: string; initialUserMessage: string; mode: "fresh" | "fork" },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const parent = this.store.getWorkerByAppThreadId(ctx.threadId);
    if (!parent) return "No Slack worker context found.";

    const targetChannel = args.channel
      ? await this.slack.resolveChannel(parent.teamId, args.channel, parent.channelId)
      : { teamId: parent.teamId, channelId: parent.channelId, name: "", isPrivate: false, isMember: true, updatedAt: new Date().toISOString() };

    const rootTs = await this.slack.postTopLevelMessage(targetChannel.channelId, args.title);
    const childThread = args.mode === "fork"
      ? await this.codex.forkWorkerThread(parent.appThreadId, parent.settings)
      : await this.codex.createWorkerThread(parent.settings);

    const child = this.store.upsertWorker({
      key: `${parent.teamId}:${targetChannel.channelId}:${rootTs}`,
      teamId: parent.teamId,
      channelId: targetChannel.channelId,
      rootTs,
      appThreadId: childThread.threadId,
      activeTurnId: null,
      ownerUserId: parent.rootOwnerUserId,
      rootOwnerUserId: parent.rootOwnerUserId,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      settings: parent.settings,
      parentWorkerKey: parent.key,
    });

    await this.startWorkerTurn(child, { text: args.initialUserMessage, imagePaths: [] });
    return `Spawned child worker in ${targetChannel.channelId} with title "${args.title}".`;
  }

  private async toTurnInput(context: SlackMessageContext, prefixHuman: boolean): Promise<{ text: string; imagePaths: string[] }> {
    const attachments = await prepareSlackAttachments(context.files, this.config.slackBotToken);
    const baseText = prefixHuman ? `${context.username}: ${context.text}` : context.text;
    return {
      text: appendFileNotes(baseText, attachments.fileNotes),
      imagePaths: attachments.imagePaths,
    };
  }

  private requireWorker(workerKey: string): WorkerRecord {
    const [teamId, channelId, rootTs] = workerKey.split(":");
    const worker = this.store.getWorker(teamId, channelId, rootTs);
    if (!worker) throw new Error(`Missing worker ${workerKey}`);
    return worker;
  }

  private requireDmSession(teamId: string, userId: string): DmSessionRecord {
    const session = this.store.getDmSession(teamId, userId);
    if (!session) throw new Error(`Missing DM session ${teamId}:${userId}`);
    return session;
  }
}
