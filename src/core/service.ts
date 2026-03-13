import { EventEmitter } from "node:events";
import { DEFAULT_EFFORTS, type AppConfig } from "../config.js";
import { parseSlashCommand, helpText, normalizeEffort } from "./commands.js";
import {
  CodexClient,
  type DynamicToolHandlerContext,
  type InteractiveRequest,
  isMissingThreadError,
  shouldStartFreshTurnAfterSteerError,
} from "../codex/client.js";
import { Store } from "../db/store.js";
import { logInfo, logWarn } from "../logger.js";
import { prepareSlackAttachments } from "../slack/attachments.js";
import { appendFileNotes, renderFinalMessage, renderSystemMessage, renderWorklog } from "../slack/renderer.js";
import { SlackGateway } from "../slack/slackGateway.js";
import type {
  DmSessionRecord,
  InboundMessageKind,
  InboundMessageRecord,
  JsonRpcId,
  PendingRequestState,
  SessionStatus,
  SlackMessageContext,
  TurnInput,
  WorkerRecord,
  WorklogItem,
} from "../types.js";

interface RenderSessionState {
  worklogItems: Map<string, WorklogItem>;
  pendingEdits: Map<string, NodeJS.Timeout>;
  latestTexts: Map<string, string>;
}

type RestartTarget = "bridge" | "both";

export class SlackCodexWorkersService extends EventEmitter {
  private readonly store: Store;
  private readonly codex: CodexClient;
  private readonly slack: SlackGateway;
  private readonly renderState = new Map<string, RenderSessionState>();
  private readonly slackWriteQueues = new Map<string, Promise<unknown>>();
  private readonly pendingInteractiveRequests = new Map<string, InteractiveRequest>();

  constructor(private readonly config: AppConfig) {
    super();
    this.store = new Store(config.databasePath);
    this.codex = new CodexClient(config.codexBin, config.codexCwd);
    this.slack = new SlackGateway(config);
    this.codex.registerDynamicToolHandlers({
      listChannels: async (args, ctx) => this.handleListChannelsTool(args.query ?? "", ctx),
      spawnWorker: async (args, ctx) => this.handleSpawnWorkerTool(args, ctx),
    });
    this.codex.registerInteractiveRequestHandler(async (request) => this.handleInteractiveRequest(request));
  }

  async start(): Promise<void> {
    await this.codex.start();
    this.registerSlackHandlers();
    await this.slack.start();
    this.store.resetInterruptedInboundMessages();
    await this.reconcilePersistedRuntimeState();
    await this.replayPendingInboundMessages();
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
    const context = await this.normalizeMessageEvent(event);
    if (!context) return;

    const kind: InboundMessageKind = context.isDm ? "dm-message" : context.threadTs ? "thread-reply" : "channel-root";
    const messageKey = buildInboundMessageKey(context, kind);
    this.store.createOrGetInboundMessage({
      key: messageKey,
      teamId: context.teamId,
      channelId: context.channelId,
      messageTs: context.ts,
      rootTs: context.threadTs ?? context.ts,
      kind,
      payloadJson: JSON.stringify(context),
    });
    await this.processInboundMessage(messageKey);
  }

  private async normalizeMessageEvent(event: unknown): Promise<SlackMessageContext | null> {
    if (!event || typeof event !== "object") return null;
    const eventRecord = event as Record<string, unknown>;
    if (typeof eventRecord.user !== "string") return null;
    if (eventRecord.bot_id || eventRecord.subtype === "bot_message" || eventRecord.subtype === "message_changed") return null;
    if (typeof eventRecord.channel !== "string" || typeof eventRecord.ts !== "string") return null;

    const text = typeof eventRecord.text === "string" ? eventRecord.text : "";
    const files = this.slack.extractFiles(eventRecord);
    if (!text.trim() && files.length === 0) return null;

    const channelType = typeof eventRecord.channel_type === "string" ? eventRecord.channel_type : null;
    if (channelType && !["channel", "group", "im"].includes(channelType)) {
      return null;
    }

    const teamId = this.slack.getTeamId() ?? this.config.allowedTeamId ?? "single-workspace";
    const userId = eventRecord.user;
    const username = await this.slack.getUserDisplayName(userId);

    return {
      teamId,
      channelId: eventRecord.channel,
      channelType,
      userId,
      username,
      text,
      ts: eventRecord.ts,
      threadTs: typeof eventRecord.thread_ts === "string" ? eventRecord.thread_ts : null,
      isDm: channelType === "im",
      files,
    };
  }

  private async processInboundMessage(messageKey: string): Promise<void> {
    const record = this.store.claimInboundMessage(messageKey);
    if (!record) return;

    let context: SlackMessageContext;
    try {
      context = JSON.parse(record.payloadJson) as SlackMessageContext;
    } catch (error) {
      this.store.markInboundMessageFailed(messageKey, error instanceof Error ? error.message : "Invalid inbound message payload");
      return;
    }

    try {
      if (record.kind === "channel-root") {
        await this.handleTopLevelChannelMessage(context, record);
      } else if (record.kind === "thread-reply") {
        await this.handleChannelThreadReply(context, record);
      } else {
        await this.handleDmMessage(context, record);
      }
      this.store.markInboundMessageProcessed(messageKey);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.store.markInboundMessageFailed(messageKey, errorText);
      logWarn("failed to process inbound Slack message", { messageKey, error: errorText });
      await this.postInboundFailureNotice(context, record, errorText);
    }
  }

  private async replayPendingInboundMessages(): Promise<void> {
    const records = this.store.listReplayableInboundMessages();
    for (const record of records) {
      await this.processInboundMessage(record.key);
    }
  }

  private async reconcilePersistedRuntimeState(): Promise<void> {
    for (const worker of this.store.listWorkers()) {
      await this.reconcileWorkerOnStartup(worker);
    }
    for (const session of this.store.listDmSessions()) {
      await this.reconcileDmOnStartup(session);
    }
  }

  private async reconcileWorkerOnStartup(worker: WorkerRecord): Promise<void> {
    if (worker.pendingRequest) {
      this.pendingInteractiveRequests.delete(worker.appThreadId);
      this.store.updateWorkerState(worker.key, {
        pendingRequest: null,
        status: worker.activeTurnId ? "running" : "idle",
        lastError: "An outstanding interactive prompt was interrupted by restart. Retry the action if input is still needed.",
      });
      await this.postWorkerSystemMessage(this.requireWorker(worker.key), "A pending interactive prompt was interrupted by restart. Retry the action if input is still needed.");
      worker = this.requireWorker(worker.key);
    }

    if (!worker.activeTurnId) return;
    const state = await this.codex.reconcileThreadForSend(worker.appThreadId);
    if (state === "running") return;
    if (state === "idle") {
      await this.clearWorkerStaleActiveTurn(worker, "Recovered stale active turn after runtime startup.");
      return;
    }
    if (state === "missing") {
      await this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
      return;
    }
  }

  private async reconcileDmOnStartup(session: DmSessionRecord): Promise<void> {
    if (session.pendingRequest) {
      this.pendingInteractiveRequests.delete(session.appThreadId ?? "");
      this.store.upsertDmSession({
        ...session,
        pendingRequest: null,
        status: session.activeTurnId ? "running" : "idle",
        lastError: "A pending interactive prompt was interrupted by restart. Retry the action if input is still needed.",
      });
      await this.postDmSystemMessage(this.requireDmSession(session.teamId, session.userId), "A pending interactive prompt was interrupted by restart. Retry the action if input is still needed.");
      session = this.requireDmSession(session.teamId, session.userId);
    }

    if (!session.appThreadId || !session.activeTurnId) return;
    const state = await this.codex.reconcileThreadForSend(session.appThreadId);
    if (state === "running") return;
    if (state === "idle") {
      await this.clearDmStaleActiveTurn(session, "Recovered stale active turn after runtime startup.");
      return;
    }
    if (state === "missing") {
      await this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
    }
  }

  private async handleTopLevelChannelMessage(context: SlackMessageContext, record: InboundMessageRecord): Promise<void> {
    let worker = this.store.getWorker(context.teamId, context.channelId, context.ts);
    if (!worker) {
      const defaults = this.store.getTeamDefaults(context.teamId);
      const started = await this.codex.createWorkerThread(defaults);
      worker = this.store.upsertWorker({
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
        lastError: null,
        lastInboundMessageTs: context.ts,
        pendingRequest: null,
      });
    } else {
      this.store.updateWorkerState(worker.key, {
        lastInboundMessageTs: context.ts,
      });
      worker = this.requireWorker(worker.key);
      if (worker.activeTurnId || worker.status === "completed" || worker.status === "failed") {
        this.store.updateInboundMessageProgress(record.key, {
          workerKey: worker.key,
          appThreadId: worker.appThreadId,
          turnId: worker.activeTurnId,
        });
        return;
      }
    }

    this.store.updateInboundMessageProgress(record.key, {
      workerKey: worker.key,
      appThreadId: worker.appThreadId,
    });
    const input = await this.toTurnInput(context, record.key, true);
    const turnId = await this.startWorkerTurn(worker, input);
    this.store.updateInboundMessageProgress(record.key, {
      workerKey: worker.key,
      appThreadId: worker.appThreadId,
      turnId,
    });
  }

  private async handleChannelThreadReply(context: SlackMessageContext, record: InboundMessageRecord): Promise<void> {
    let worker = this.store.getWorker(context.teamId, context.channelId, context.threadTs!);
    if (!worker) return;

    const command = parseSlashCommand(context.text);
    if (command) {
      await this.handleThreadCommand(worker, command.name, command.args);
      return;
    }

    if (worker.pendingRequest) {
      await this.resolveWorkerPendingRequest(worker, context);
      return;
    }

    worker = await this.prepareWorkerForSend(worker);
    if (worker.status === "recovery_required") {
      await this.postWorkerSystemMessage(worker, worker.lastError ?? "Backing Codex thread is missing. Run /recover.");
      return;
    }

    const input = await this.toTurnInput(context, record.key, true);
    this.store.updateWorkerState(worker.key, { lastInboundMessageTs: context.ts, lastError: null });
    this.store.updateInboundMessageProgress(record.key, {
      workerKey: worker.key,
      appThreadId: worker.appThreadId,
    });

    if (worker.activeTurnId) {
      try {
        await this.codex.steerTurn(worker.appThreadId, worker.activeTurnId, input);
        this.store.updateInboundMessageProgress(record.key, { turnId: worker.activeTurnId });
        return;
      } catch (error) {
        if (isMissingThreadError(error)) {
          worker = await this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
        } else if (shouldStartFreshTurnAfterSteerError(error)) {
          worker = await this.clearWorkerStaleActiveTurn(worker, "Recovered stale active turn while sending the latest Slack reply.");
        } else {
          throw error;
        }
      }
    }

    if (worker.status === "recovery_required") {
      await this.postWorkerSystemMessage(worker, worker.lastError ?? "Backing Codex thread is missing. Run /recover.");
      return;
    }

    const turnId = await this.startWorkerTurn(worker, input);
    this.store.updateInboundMessageProgress(record.key, {
      workerKey: worker.key,
      appThreadId: worker.appThreadId,
      turnId,
    });
  }

  private async handleDmMessage(context: SlackMessageContext, record: InboundMessageRecord): Promise<void> {
    if (!this.config.adminUserIds.includes(context.userId)) {
      await this.enqueueSlackWrite(this.getDmQueueKey(context.teamId, context.userId), async () => {
        await this.slack.postTopLevelMessage(context.channelId, "Not authorized.");
      });
      return;
    }

    let session = this.store.getDmSession(context.teamId, context.userId);
    if (!session) {
      session = this.store.upsertDmSession({
        teamId: context.teamId,
        userId: context.userId,
        channelId: context.channelId,
        appThreadId: null,
        activeTurnId: null,
        status: "idle",
        currentAgentSlackTs: null,
        currentAgentItemId: null,
        currentWorklogSlackTs: null,
        settings: this.store.getTeamDefaults(context.teamId),
        lastError: null,
        lastInboundMessageTs: null,
        pendingRequest: null,
      });
    } else if (session.channelId !== context.channelId) {
      session = this.store.upsertDmSession({ ...session, channelId: context.channelId });
    }

    const command = parseSlashCommand(context.text);
    if (command) {
      const response = await this.handleDmCommand(session, command.name, command.args);
      await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () => {
        await this.slack.postTopLevelMessage(session!.channelId, response);
      });
      return;
    }

    if (session.pendingRequest) {
      await this.resolveDmPendingRequest(session, context);
      return;
    }

    session = await this.prepareDmForSend(session);
    if (session.status === "recovery_required") {
      await this.postDmSystemMessage(session, session.lastError ?? "Backing Codex thread is missing. Run /recover.");
      return;
    }

    this.store.upsertDmSession({
      ...session,
      lastInboundMessageTs: context.ts,
      lastError: null,
    });
    this.store.updateInboundMessageProgress(record.key, {
      appThreadId: session.appThreadId,
    });
    const input = await this.toTurnInput(context, record.key, true);

    if (session.activeTurnId && session.appThreadId) {
      try {
        await this.codex.steerTurn(session.appThreadId, session.activeTurnId, input);
        this.store.updateInboundMessageProgress(record.key, { turnId: session.activeTurnId });
        return;
      } catch (error) {
        if (isMissingThreadError(error)) {
          session = await this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
        } else if (shouldStartFreshTurnAfterSteerError(error)) {
          session = await this.clearDmStaleActiveTurn(session, "Recovered stale active turn while sending the latest DM reply.");
        } else {
          throw error;
        }
      }
    }

    if (session.status === "recovery_required") {
      await this.postDmSystemMessage(session, session.lastError ?? "Backing Codex thread is missing. Run /recover.");
      return;
    }

    const turnId = await this.startDmTurn(session, input);
    this.store.updateInboundMessageProgress(record.key, {
      appThreadId: session.appThreadId,
      turnId,
    });
  }

  private async prepareWorkerForSend(worker: WorkerRecord): Promise<WorkerRecord> {
    const state = await this.codex.reconcileThreadForSend(worker.appThreadId);
    if (worker.activeTurnId) {
      if (state === "idle") {
        return this.clearWorkerStaleActiveTurn(worker, "Recovered stale active turn before sending.");
      }
      if (state === "missing") {
        return this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
      }
      if (state === "unknown") {
        throw new Error("Could not reconcile worker thread state with Codex app-server.");
      }
      return this.requireWorker(worker.key);
    }

    if (state === "missing") {
      return this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
    }

    return this.requireWorker(worker.key);
  }

  private async prepareDmForSend(session: DmSessionRecord): Promise<DmSessionRecord> {
    if (!session.appThreadId) {
      return this.requireDmSession(session.teamId, session.userId);
    }
    const state = await this.codex.reconcileThreadForSend(session.appThreadId);
    if (session.activeTurnId) {
      if (state === "idle") {
        return this.clearDmStaleActiveTurn(session, "Recovered stale active turn before sending.");
      }
      if (state === "missing") {
        return this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
      }
      if (state === "unknown") {
        throw new Error("Could not reconcile DM thread state with Codex app-server.");
      }
      return this.requireDmSession(session.teamId, session.userId);
    }
    if (state === "missing") {
      return this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
    }
    return this.requireDmSession(session.teamId, session.userId);
  }

  private async startWorkerTurn(worker: WorkerRecord, input: TurnInput): Promise<string> {
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
    this.store.updateWorkerState(worker.key, {
      activeTurnId: turnId,
      status: "running",
      lastError: null,
      pendingRequest: null,
    });
    return turnId;
  }

  private async startDmTurn(session: DmSessionRecord, input: TurnInput): Promise<string> {
    let latestSession = session;
    let appThreadId = latestSession.appThreadId;
    if (!appThreadId) {
      const created = await this.codex.createAdminThread(latestSession.settings);
      latestSession = this.store.upsertDmSession({
        ...latestSession,
        appThreadId: created.threadId,
        status: "idle",
      });
      appThreadId = created.threadId;
    }

    const turnId = await this.codex.startTurnWithResumeFallback(
      appThreadId,
      input,
      latestSession.settings,
      {
        onAgentDelta: async ({ itemId, delta }) => {
          await this.onDmAgentDelta(latestSession.teamId, latestSession.userId, itemId, delta);
        },
        onAgentMessage: async ({ itemId, text }) => {
          await this.onDmAgentMessage(latestSession.teamId, latestSession.userId, itemId, text);
        },
        onWorklogItem: async (event) => {
          await this.onDmWorklogItem(latestSession.teamId, latestSession.userId, event);
        },
        onCompleted: async ({ assistantText, status, error }) => {
          await this.onDmCompleted(latestSession.teamId, latestSession.userId, assistantText, status, error);
        },
      },
    );

    this.store.upsertDmSession({
      ...latestSession,
      appThreadId,
      activeTurnId: turnId,
      status: "running",
      lastError: null,
      pendingRequest: null,
    });
    return turnId;
  }

  private async onWorkerAgentDelta(workerKey: string, itemId: string, delta: string): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    const slackTs = await this.ensureWorkerAgentMessage(worker, itemId, delta);
    await this.scheduleSlackEdit(this.getWorkerQueueKey(worker), this.getWorkerEditKey(worker, slackTs), worker.channelId, slackTs, (current) => `${current}${delta}`);
  }

  private async onWorkerAgentMessage(workerKey: string, itemId: string, text: string): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    const slackTs = await this.ensureWorkerAgentMessage(worker, itemId, text);
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.flushSlackEdit(this.getWorkerEditKey(worker, slackTs), worker.channelId, slackTs, text);
    });
  }

  private async onWorkerWorklogItem(workerKey: string, event: WorklogItem): Promise<void> {
    const worker = this.requireWorker(workerKey);
    const state = this.getRenderState(`worker:${workerKey}`);
    state.worklogItems.set(event.itemId, event);

    if (!worker.currentWorklogSlackTs) {
      const slackTs = await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () =>
        this.slack.postThreadReply(worker.channelId, worker.rootTs, renderWorklog(state.worklogItems.values())),
      );
      this.store.updateWorkerState(worker.key, { currentWorklogSlackTs: slackTs });
      return;
    }

    await this.scheduleSlackEdit(
      this.getWorkerQueueKey(worker),
      this.getWorkerEditKey(worker, worker.currentWorklogSlackTs),
      worker.channelId,
      worker.currentWorklogSlackTs,
      () => renderWorklog(state.worklogItems.values()),
    );
  }

  private async onWorkerCompleted(workerKey: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const worker = this.requireWorker(workerKey);
    this.freezeWorklog(workerKey, "worker");
    this.store.updateWorkerState(workerKey, {
      activeTurnId: null,
      status: normalizeTurnStatus(status),
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: error ?? (status === "completed" ? null : `Turn ${status}`),
    });
    const finalText = status === "completed"
      ? renderFinalMessage(worker.rootOwnerUserId, assistantText)
      : renderFinalMessage(worker.rootOwnerUserId, `Turn ${status}.${error ? ` ${error}` : ""}`);
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, finalText);
    });
  }

  private async onDmAgentDelta(teamId: string, userId: string, itemId: string, delta: string): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    const slackTs = await this.ensureDmAgentMessage(session, itemId, delta);
    await this.scheduleSlackEdit(this.getDmQueueKey(teamId, userId), this.getDmEditKey(teamId, userId, slackTs), session.channelId, slackTs, (current) => `${current}${delta}`);
  }

  private async onDmAgentMessage(teamId: string, userId: string, itemId: string, text: string): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    const slackTs = await this.ensureDmAgentMessage(session, itemId, text);
    await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
      await this.flushSlackEdit(this.getDmEditKey(teamId, userId, slackTs), session.channelId, slackTs, text);
    });
  }

  private async onDmWorklogItem(teamId: string, userId: string, event: WorklogItem): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    const state = this.getRenderState(`dm:${teamId}:${userId}`);
    state.worklogItems.set(event.itemId, event);

    if (!session.currentWorklogSlackTs) {
      const slackTs = await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () =>
        this.slack.postTopLevelMessage(session.channelId, renderWorklog(state.worklogItems.values())),
      );
      this.store.upsertDmSession({ ...session, currentWorklogSlackTs: slackTs });
      return;
    }

    await this.scheduleSlackEdit(
      this.getDmQueueKey(teamId, userId),
      this.getDmEditKey(teamId, userId, session.currentWorklogSlackTs),
      session.channelId,
      session.currentWorklogSlackTs,
      () => renderWorklog(state.worklogItems.values()),
    );
  }

  private async onDmCompleted(teamId: string, userId: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    this.freezeWorklog(`${teamId}:${userId}`, "dm");
    this.store.upsertDmSession({
      ...session,
      activeTurnId: null,
      status: normalizeTurnStatus(status),
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: error ?? (status === "completed" ? null : `Turn ${status}`),
    });
    const text = status === "completed" ? assistantText : `Turn ${status}.${error ? ` ${error}` : ""}`;
    await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
      await this.slack.postTopLevelMessage(session.channelId, text || "Done.");
    });
  }

  private async ensureWorkerAgentMessage(worker: WorkerRecord, itemId: string, initialText: string): Promise<string> {
    const latest = this.requireWorker(worker.key);
    if (latest.currentAgentItemId === itemId && latest.currentAgentSlackTs) {
      return latest.currentAgentSlackTs;
    }
    const slackTs = await this.enqueueSlackWrite(this.getWorkerQueueKey(latest), async () =>
      this.slack.postThreadReply(latest.channelId, latest.rootTs, initialText),
    );
    this.store.updateWorkerState(latest.key, {
      currentAgentSlackTs: slackTs,
      currentAgentItemId: itemId,
      currentWorklogSlackTs: null,
    });
    return slackTs;
  }

  private async ensureDmAgentMessage(session: DmSessionRecord, itemId: string, initialText: string): Promise<string> {
    const latest = this.requireDmSession(session.teamId, session.userId);
    if (latest.currentAgentItemId === itemId && latest.currentAgentSlackTs) {
      return latest.currentAgentSlackTs;
    }
    const slackTs = await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () =>
      this.slack.postTopLevelMessage(latest.channelId, initialText),
    );
    this.store.upsertDmSession({
      ...latest,
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

  private async scheduleSlackEdit(
    queueKey: string,
    editKey: string,
    channelId: string,
    slackTs: string,
    next: ((current: string) => string) | string,
  ): Promise<void> {
    const state = this.getRenderState("__edits__");
    const current = state.latestTexts.get(editKey) ?? "";
    const nextText = typeof next === "string" ? next : next(current);
    state.latestTexts.set(editKey, nextText);
    const existing = state.pendingEdits.get(editKey);
    if (existing) return;
    const timer = setTimeout(() => {
      void this.enqueueSlackWrite(queueKey, async () => {
        try {
          await this.flushSlackEdit(editKey, channelId, slackTs, state.latestTexts.get(editKey) ?? "");
        } catch (error) {
          logWarn("slack edit flush failed", error instanceof Error ? error.message : String(error));
        }
      });
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
      if (worker.activeTurnId || worker.pendingRequest) {
        response = "Cannot compact while the worker is active.";
      } else {
        await this.codex.compactThread(worker.appThreadId);
        response = `Compaction requested for thread ${worker.appThreadId}`;
      }
    } else if (name === "recover") {
      const recovered = await this.recoverWorker(worker);
      response = `Created a fresh backing Codex thread for this Slack conversation.\nThread: ${recovered.appThreadId}`;
    } else {
      response = "This command is only available in DMs.";
    }
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, response);
    });
  }

  private async handleDmCommand(session: DmSessionRecord, name: string, args: string[]): Promise<string> {
    const defaults = this.store.getTeamDefaults(session.teamId);
    const currentSession = this.store.getDmSession(session.teamId, session.userId);

    if (name === "help") return helpText("dm");
    if (name === "status") {
      const activeWorkerCount = this.store.listWorkersWithActiveTurns().length;
      return [
        "Bridge Status",
        `team: ${session.teamId}`,
        `codex_cwd: ${this.config.codexCwd}`,
        `workers_active: ${activeWorkerCount}`,
        `default_model: ${defaults.model ?? "(unset)"}`,
        `default_effort: ${defaults.effort ?? "(unset)"}`,
        `dm_thread: ${currentSession?.appThreadId ?? "(none)"}`,
        `supervisor_restart: ${this.config.supervisorRestartEnabled ? "enabled" : "disabled"}`,
      ].join("\n");
    }
    if (name === "model") {
      if (args.length === 0) return `Default model: ${defaults.model ?? "(unset)"}`;
      defaults.model = args.join(" ");
      this.store.setTeamDefaults(session.teamId, defaults);
      return `Default model set: ${defaults.model}`;
    }
    if (name === "effort") {
      if (args.length === 0) return `Default effort: ${defaults.effort ?? "(unset)"}\nAllowed: ${DEFAULT_EFFORTS.join(", ")}`;
      const effort = normalizeEffort(args[0]);
      if (!effort) return `Usage: /effort <${DEFAULT_EFFORTS.join("|")}>`;
      defaults.effort = effort;
      this.store.setTeamDefaults(session.teamId, defaults);
      return `Default effort set: ${effort}`;
    }
    if (name === "compact") {
      if (!currentSession?.appThreadId) return "No DM admin thread to compact.";
      if (currentSession.activeTurnId || currentSession.pendingRequest) return "Cannot compact while the DM admin thread is active.";
      await this.codex.compactThread(currentSession.appThreadId);
      return `Compaction requested for thread ${currentSession.appThreadId}`;
    }
    if (name === "recover") {
      const recovered = await this.recoverDmSession(currentSession ?? session);
      return `Created a fresh backing Codex admin thread.\nThread: ${recovered.appThreadId ?? "(none)"}`;
    }
    if (name === "restart") {
      const target = (args[0] ?? "").toLowerCase();
      if (!target || !["codex", "bridge", "both"].includes(target)) {
        return "Usage: /restart <codex|bridge|both>";
      }
      if (target === "codex") {
        await this.codex.restart();
        await this.reconcilePersistedRuntimeState();
        return "Codex restarted and reconciled.";
      }
      if (!this.config.supervisorRestartEnabled) {
        return "Bridge restarts require supervisor mode. Launch via scripts/run.sh or set SUPERVISOR_RESTART_ENABLED=1 under a restart-capable supervisor.";
      }
      this.emit("restartRequested", target as RestartTarget);
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

    const childThread = args.mode === "fork"
      ? await this.codex.forkWorkerThread(parent.appThreadId, parent.settings)
      : await this.codex.createWorkerThread(parent.settings);

    const rootTs = await this.enqueueSlackWrite(`spawn:${parent.key}:${targetChannel.channelId}`, async () =>
      this.slack.postTopLevelMessage(targetChannel.channelId, args.title),
    );

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
      lastError: null,
      lastInboundMessageTs: null,
      pendingRequest: null,
    });

    try {
      await this.startWorkerTurn(child, { text: args.initialUserMessage, imagePaths: [] });
      return `Spawned child worker in ${targetChannel.channelId} with title "${args.title}".`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateWorkerState(child.key, {
        status: "failed",
        lastError: message,
      });
      await this.postWorkerSystemMessage(child, `Child worker startup failed: ${message}`);
      return `Child worker thread was created in ${targetChannel.channelId}, but startup failed: ${message}`;
    }
  }

  private async handleInteractiveRequest(request: InteractiveRequest): Promise<void> {
    this.pendingInteractiveRequests.set(request.threadId, request);

    const worker = this.store.getWorkerByAppThreadId(request.threadId);
    if (worker) {
      const pending = this.toPendingRequestState(request);
      this.store.updateWorkerState(worker.key, {
        status: "blocked_input",
        pendingRequest: pending,
        lastError: null,
      });
      await this.postWorkerSystemMessage(worker, `${request.promptText}\nReply in this thread to continue.`);
      return;
    }

    const session = this.store.listDmSessions().find((candidate) => candidate.appThreadId === request.threadId) ?? null;
    if (session) {
      this.store.upsertDmSession({
        ...session,
        status: "blocked_input",
        pendingRequest: this.toPendingRequestState(request),
        lastError: null,
      });
      await this.postDmSystemMessage(session, `${request.promptText}\nReply here to continue.`);
      return;
    }

    await this.codex.respondToServerRequest(request.requestId, request.kind === "mcp_elicitation"
      ? { action: "decline", content: null, _meta: null }
      : { answers: {} });
  }

  private async resolveWorkerPendingRequest(worker: WorkerRecord, context: SlackMessageContext): Promise<void> {
    const pending = worker.pendingRequest;
    if (!pending) return;
    const runtimeRequest = this.pendingInteractiveRequests.get(worker.appThreadId);
    if (!runtimeRequest) {
      this.store.updateWorkerState(worker.key, {
        pendingRequest: null,
        status: worker.activeTurnId ? "running" : "idle",
        lastError: "Pending interactive request was lost during restart. Retry the action if input is still needed.",
      });
      await this.postWorkerSystemMessage(worker, "Pending interactive request was lost during restart. Retry the action if input is still needed.");
      return;
    }

    const response = parseInteractiveReply(runtimeRequest, context.text);
    if (!response.ok) {
      await this.postWorkerSystemMessage(worker, response.message);
      return;
    }

    await this.codex.respondToServerRequest(runtimeRequest.requestId, response.payload);
    this.pendingInteractiveRequests.delete(worker.appThreadId);
    this.store.updateWorkerState(worker.key, {
      pendingRequest: null,
      status: worker.activeTurnId ? "running" : "idle",
      lastError: null,
      lastInboundMessageTs: context.ts,
    });
    await this.postWorkerSystemMessage(worker, "Input received. Continuing.");
  }

  private async resolveDmPendingRequest(session: DmSessionRecord, context: SlackMessageContext): Promise<void> {
    const pending = session.pendingRequest;
    if (!pending || !session.appThreadId) return;
    const runtimeRequest = this.pendingInteractiveRequests.get(session.appThreadId);
    if (!runtimeRequest) {
      this.store.upsertDmSession({
        ...session,
        pendingRequest: null,
        status: session.activeTurnId ? "running" : "idle",
        lastError: "Pending interactive request was lost during restart. Retry the action if input is still needed.",
      });
      await this.postDmSystemMessage(session, "Pending interactive request was lost during restart. Retry the action if input is still needed.");
      return;
    }

    const response = parseInteractiveReply(runtimeRequest, context.text);
    if (!response.ok) {
      await this.postDmSystemMessage(session, response.message);
      return;
    }

    await this.codex.respondToServerRequest(runtimeRequest.requestId, response.payload);
    this.pendingInteractiveRequests.delete(session.appThreadId);
    this.store.upsertDmSession({
      ...session,
      pendingRequest: null,
      status: session.activeTurnId ? "running" : "idle",
      lastError: null,
      lastInboundMessageTs: context.ts,
    });
    await this.postDmSystemMessage(session, "Input received. Continuing.");
  }

  private async recoverWorker(worker: WorkerRecord): Promise<WorkerRecord> {
    const created = await this.codex.createWorkerThread(worker.settings);
    const recovered = this.store.upsertWorker({
      ...worker,
      appThreadId: created.threadId,
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      lastError: null,
      pendingRequest: null,
    });
    await this.postWorkerSystemMessage(recovered, "Reattached this Slack conversation to a fresh Codex thread. Prior runtime context was lost.");
    return recovered;
  }

  private async recoverDmSession(session: DmSessionRecord): Promise<DmSessionRecord> {
    const created = await this.codex.createAdminThread(session.settings);
    const recovered = this.store.upsertDmSession({
      ...session,
      appThreadId: created.threadId,
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      lastError: null,
      pendingRequest: null,
    });
    await this.postDmSystemMessage(recovered, "Reattached this admin DM to a fresh Codex thread. Prior runtime context was lost.");
    return recovered;
  }

  private async clearWorkerStaleActiveTurn(worker: WorkerRecord, reason: string): Promise<WorkerRecord> {
    this.store.updateWorkerState(worker.key, {
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: reason,
    });
    const updated = this.requireWorker(worker.key);
    await this.postWorkerSystemMessage(updated, reason);
    return updated;
  }

  private async markWorkerRecoveryRequired(worker: WorkerRecord, reason: string): Promise<WorkerRecord> {
    this.store.updateWorkerState(worker.key, {
      activeTurnId: null,
      status: "recovery_required",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: reason,
    });
    const updated = this.requireWorker(worker.key);
    await this.postWorkerSystemMessage(updated, reason);
    return updated;
  }

  private async clearDmStaleActiveTurn(session: DmSessionRecord, reason: string): Promise<DmSessionRecord> {
    this.store.upsertDmSession({
      ...session,
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: reason,
    });
    const updated = this.requireDmSession(session.teamId, session.userId);
    await this.postDmSystemMessage(updated, reason);
    return updated;
  }

  private async markDmRecoveryRequired(session: DmSessionRecord, reason: string): Promise<DmSessionRecord> {
    this.store.upsertDmSession({
      ...session,
      activeTurnId: null,
      status: "recovery_required",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: reason,
    });
    const updated = this.requireDmSession(session.teamId, session.userId);
    await this.postDmSystemMessage(updated, reason);
    return updated;
  }

  private async postWorkerSystemMessage(worker: WorkerRecord, message: string): Promise<void> {
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, renderSystemMessage(message));
    });
  }

  private async postDmSystemMessage(session: DmSessionRecord, message: string): Promise<void> {
    await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () => {
      await this.slack.postTopLevelMessage(session.channelId, renderSystemMessage(message));
    });
  }

  private async postInboundFailureNotice(context: SlackMessageContext, record: InboundMessageRecord, errorText: string): Promise<void> {
    const message = renderSystemMessage(`Failed to process this message: ${errorText}`);
    if (record.kind === "dm-message") {
      await this.enqueueSlackWrite(this.getDmQueueKey(context.teamId, context.userId), async () => {
        await this.slack.postTopLevelMessage(context.channelId, message);
      });
      return;
    }
    const rootTs = record.rootTs || context.threadTs || context.ts;
    const queueKey = record.workerKey && this.store.getWorkerByKey(record.workerKey)
      ? this.getWorkerQueueKey(this.store.getWorkerByKey(record.workerKey)!)
      : `channel:${context.teamId}:${context.channelId}:${rootTs}`;
    await this.enqueueSlackWrite(queueKey, async () => {
      await this.slack.postThreadReply(context.channelId, rootTs, message);
    });
  }

  private async toTurnInput(context: SlackMessageContext, messageKey: string, prefixHuman: boolean): Promise<TurnInput> {
    const attachments = await prepareSlackAttachments(
      messageKey,
      context.files,
      this.store.listAttachmentsForMessage(messageKey),
      this.config.slackBotToken,
      this.config,
    );
    this.store.upsertAttachments(attachments.storedAttachments);

    const rawText = context.text.trim();
    const baseText = prefixHuman
      ? `${context.username}: ${rawText || (context.files.length > 0 ? "[attached files]" : "")}`
      : rawText || (context.files.length > 0 ? "[attached files]" : "");

    return {
      text: appendFileNotes(baseText, attachments.fileNotes),
      imagePaths: attachments.imagePaths,
    };
  }

  private getWorkerQueueKey(worker: WorkerRecord): string {
    return `worker:${worker.key}`;
  }

  private getWorkerEditKey(worker: WorkerRecord, slackTs: string): string {
    return `${this.getWorkerQueueKey(worker)}:${slackTs}`;
  }

  private getDmQueueKey(teamId: string, userId: string): string {
    return `dm:${teamId}:${userId}`;
  }

  private getDmEditKey(teamId: string, userId: string, slackTs: string): string {
    return `${this.getDmQueueKey(teamId, userId)}:${slackTs}`;
  }

  private async enqueueSlackWrite<T>(queueKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.slackWriteQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.slackWriteQueues.set(queueKey, current.then(() => undefined, () => undefined));
    return current;
  }

  private toPendingRequestState(request: InteractiveRequest): PendingRequestState {
    return {
      kind: request.kind,
      requestId: String(request.requestId),
      promptText: request.promptText,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      questionIds: request.questionIds,
      schemaJson: request.schemaJson,
      createdAt: new Date().toISOString(),
    };
  }

  private requireWorker(workerKey: string): WorkerRecord {
    const worker = this.store.getWorkerByKey(workerKey);
    if (!worker) throw new Error(`Missing worker ${workerKey}`);
    return worker;
  }

  private requireDmSession(teamId: string, userId: string): DmSessionRecord {
    const session = this.store.getDmSession(teamId, userId);
    if (!session) throw new Error(`Missing DM session ${teamId}:${userId}`);
    return session;
  }
}

function buildInboundMessageKey(context: SlackMessageContext, kind: InboundMessageKind): string {
  return `${context.teamId}:${context.channelId}:${context.ts}:${kind}`;
}

function normalizeTurnStatus(status: string): SessionStatus {
  return status === "completed" ? "completed" : "failed";
}

function parseInteractiveReply(
  request: InteractiveRequest,
  text: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (request.kind === "tool_user_input") {
    if (request.questionIds.length === 1) {
      const questionId = request.questionIds[0]!;
      return {
        ok: true,
        payload: {
          answers: {
            [questionId]: { answers: [trimmed] },
          },
        },
      };
    }
    const parsed = safeJson(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, message: "Reply with JSON like {\"question_id\": \"answer\"} for this interactive request." };
    }
    const answers: Record<string, { answers: string[] }> = {};
    for (const questionId of request.questionIds) {
      const value = (parsed as Record<string, unknown>)[questionId];
      if (typeof value === "string") {
        answers[questionId] = { answers: [value] };
        continue;
      }
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        answers[questionId] = { answers: value as string[] };
      }
    }
    if (Object.keys(answers).length === 0) {
      return { ok: false, message: "Reply with JSON like {\"question_id\": \"answer\"} for this interactive request." };
    }
    return { ok: true, payload: { answers } };
  }

  const schema = safeJson(request.schemaJson ?? "");
  const params = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  const mode = typeof params.mode === "string" ? params.mode : "form";
  if (mode === "url") {
    const action = trimmed.toLowerCase();
    if (!["accept", "decline", "cancel"].includes(action)) {
      return { ok: false, message: "Reply with one of: accept, decline, cancel." };
    }
    return { ok: true, payload: { action, content: null, _meta: null } };
  }

  if (["decline", "cancel"].includes(trimmed.toLowerCase())) {
    return { ok: true, payload: { action: trimmed.toLowerCase(), content: null, _meta: null } };
  }
  const parsed = safeJson(trimmed);
  if (!parsed) {
    return { ok: false, message: "Reply with JSON matching the requested schema, or reply decline/cancel." };
  }
  return { ok: true, payload: { action: "accept", content: parsed, _meta: null } };
}

function safeJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
