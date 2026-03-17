import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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
import { findLatestMatchingCronMinute } from "../registrations/cron.js";
import { RegistrationManager, type RegistrationContext } from "../registrations/manager.js";
import { prepareSlackAttachments } from "../slack/attachments.js";
import { appendFileNotes, renderEventMessage, renderFinalMessage, renderSystemMessage } from "../slack/renderer.js";
import { SlackGateway, type SlackUploadedFile } from "../slack/slackGateway.js";
import { validateSlackUploadFiles } from "../slack/uploads.js";
import { assignWorkerIdentity } from "../slack/workerIdentity.js";
import { WorkstreamManager, buildRequestTitle, formatWorkstreamAddress } from "../workstreams/manager.js";
import type {
  DmSessionRecord,
  InboundMessageKind,
  InboundMessageRecord,
  JsonRpcId,
  PendingWorkerShellRecord,
  PendingRestartRecord,
  PendingRequestState,
  RegistrationRecord,
  RestartTarget,
  RuntimeSettings,
  SessionStatus,
  SlackMessageContext,
  TurnInput,
  WorkstreamRecord,
  WorkerRecord,
  WorklogItem,
} from "../types.js";

interface RenderSessionState {
  pendingAssistant: { itemId: string; text: string } | null;
}

type InboundHandlingResult =
  | { status: "processed" }
  | { status: "manual_retry"; reason: string };

type WorkstreamSourceInput = {
  sourceKind: string;
  sourceSummary: string;
  sourceSlackChannelId?: string | null;
  sourceSlackMessageTs?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
};

interface DmCommandResult {
  response: string;
  afterSend?: () => Promise<void>;
}

const BLOCKED_RUNNING_TURN_POLL_INTERVAL_MS = 2_000;
const BLOCKED_RUNNING_TURN_POLL_WINDOW_MS = 30_000;
const REGISTRATION_POLL_INTERVAL_MS = 5_000;
const WAKE_RETRY_MAX_ATTEMPTS = 3;
const STATUS_REACTIONS = {
  seen: "eyes",
  running: "hourglass_flowing_sand",
  completed: "white_check_mark",
  failed: "x",
  interrupted: "no_entry_sign",
} as const;

export class SlackCodexWorkersService extends EventEmitter {
  private readonly store: Store;
  private readonly codex: CodexClient;
  private readonly slack: SlackGateway;
  private readonly workstreams: WorkstreamManager;
  private readonly registrations: RegistrationManager;
  private readonly renderState = new Map<string, RenderSessionState>();
  private readonly slackWriteQueues = new Map<string, Promise<unknown>>();
  private readonly pendingInteractiveRequests = new Map<string, InteractiveRequest>();
  private readonly blockedTurnPolls = new Map<string, NodeJS.Timeout>();
  private readonly blockedTurnDeadlines = new Map<string, number>();
  private readonly startingWorkerTurns = new Map<string, Promise<string>>();
  private readonly startingDmTurns = new Map<string, Promise<string>>();
  private registrationPollTimer: NodeJS.Timeout | null = null;
  private processingRegistrationLoop = false;
  private currentRegistrationLoopPromise: Promise<void> | null = null;
  private stopping = false;
  private executingQueuedRestart = false;

  constructor(private readonly config: AppConfig) {
    super();
    this.store = new Store(config.databasePath);
    this.codex = new CodexClient(config.codexBin, config.workspaceRoot);
    this.slack = new SlackGateway(config);
    this.workstreams = new WorkstreamManager(config, this.store);
    this.registrations = new RegistrationManager(config, this.store, this.workstreams);
    this.codex.registerDynamicToolHandlers({
      listChannels: async (args, ctx) => this.handleListChannelsTool(args.query ?? "", ctx),
      spawnWorker: async (args, ctx) => this.handleSpawnWorkerTool(args, ctx),
      createWorkstream: async (args, ctx) => this.handleCreateWorkstreamTool(args, ctx),
      uploadFiles: async (args, ctx) => this.handleUploadFilesTool(args, ctx),
      setHeartbeat: async (args, ctx) => this.handleSetHeartbeatTool(args, ctx),
      setCron: async (args, ctx) => this.handleSetCronTool(args, ctx),
      setWebhook: async (args, ctx) => this.handleSetWebhookTool(args, ctx),
      disableRegistration: async (args, ctx) => this.handleDisableRegistrationTool(args, ctx),
      listRegistrations: async (ctx) => this.handleListRegistrationsTool(ctx),
      getRegistration: async (args, ctx) => this.handleGetRegistrationTool(args, ctx),
      listPendingWakes: async (ctx) => this.handleListPendingWakesTool(ctx),
    });
    this.codex.registerInteractiveRequestHandler(async (request) => this.handleInteractiveRequest(request));
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.codex.start();
    this.registerSlackHandlers();
    await this.slack.start();
    await this.bootstrapWorkstreams();
    await this.postPendingRestartNotice();
    this.store.resetInterruptedInboundMessages();
    await this.reconcilePersistedRuntimeState();
    await this.replayPendingInboundMessages();
    this.scheduleRegistrationLoop(0);
    logInfo("Slack Codex Workers ready");
  }

  private async bootstrapWorkstreams(): Promise<void> {
    const teamId = this.slack.getTeamId() ?? this.config.allowedTeamId ?? "single-workspace";
    const rootChannel = await this.slack.ensurePublicChannel(teamId, "general");
    await this.workstreams.bootstrapRootWorkstream(teamId, rootChannel);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.blockedTurnPolls.values()) {
      clearTimeout(timer);
    }
    this.blockedTurnPolls.clear();
    this.blockedTurnDeadlines.clear();
    if (this.registrationPollTimer) {
      clearTimeout(this.registrationPollTimer);
      this.registrationPollTimer = null;
    }
    await this.currentRegistrationLoopPromise;
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
      let outcome: InboundHandlingResult;
      if (record.kind === "channel-root") {
        outcome = await this.handleTopLevelChannelMessage(context, record);
      } else if (record.kind === "thread-reply") {
        outcome = await this.handleChannelThreadReply(context, record);
      } else {
        outcome = await this.handleDmMessage(context, record);
      }
      if (outcome.status === "processed") {
        this.store.markInboundMessageProcessed(messageKey);
      } else {
        this.store.markInboundMessageRejected(messageKey, outcome.reason);
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.store.markInboundMessageFailed(messageKey, errorText);
      logWarn("failed to process inbound Slack message", { messageKey, error: errorText });
      try {
        if (!context.isDm && !parseSlashCommand(context.text)) {
          await this.setThreadStatusReaction(
            context.channelId,
            context.threadTs ?? context.ts,
            STATUS_REACTIONS.failed,
          );
        }
        await this.postInboundFailureNotice(context, record, errorText);
      } catch (sideEffectError) {
        const sideEffectText = sideEffectError instanceof Error ? sideEffectError.message : String(sideEffectError);
        if (isSlackMessageNotFoundError(sideEffectError)) {
          const quarantineReason = `Slack message no longer exists for retry: ${sideEffectText}`;
          this.store.markInboundMessageRejected(messageKey, quarantineReason);
          logWarn("quarantined stale inbound replay after Slack message disappeared", {
            messageKey,
            error: sideEffectText,
          });
          return;
        }
        logWarn("failed to report inbound Slack message failure", {
          messageKey,
          error: sideEffectText,
        });
      }
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

    if (!worker.activeTurnId) {
      const state = await this.codex.reconcileThreadForSend(worker.appThreadId);
      if (state === "running") {
        await this.markWorkerBlockedRunningTurn(worker, "A previous Codex turn is still running after restart. Wait for it to finish or use /recover to abandon it.");
      }
      if (state === "idle" && worker.status === "blocked_running_turn") {
        await this.clearWorkerBlockedRunningTurn(worker, "The previous Codex turn finished. This thread is ready for new messages.");
      }
      if (state === "missing" && worker.status === "blocked_running_turn") {
        await this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
      }
      return;
    }
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

    if (!session.appThreadId) return;
    if (!session.activeTurnId) {
      const state = await this.codex.reconcileThreadForSend(session.appThreadId);
      if (state === "running") {
        await this.markDmBlockedRunningTurn(session, "A previous Codex turn is still running after restart. Wait for it to finish or use /recover to abandon it.");
      }
      if (state === "idle" && session.status === "blocked_running_turn") {
        await this.clearDmBlockedRunningTurn(session, "The previous Codex turn finished. This DM is ready for new messages.");
      }
      if (state === "missing" && session.status === "blocked_running_turn") {
        await this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
      }
      return;
    }
    const state = await this.codex.reconcileThreadForSend(session.appThreadId!);
    if (state === "running") return;
    if (state === "idle") {
      await this.clearDmStaleActiveTurn(session, "Recovered stale active turn after runtime startup.");
      return;
    }
    if (state === "missing") {
      await this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
    }
  }

  private async handleTopLevelChannelMessage(context: SlackMessageContext, record: InboundMessageRecord): Promise<InboundHandlingResult> {
    const workstream = this.workstreams.resolveWorkstreamForChannel(context.teamId, context.channelId);
    if (!workstream) {
      const reason = "No workstream is registered for this channel. Use the admin DM /workstream-create command or move the request to #general.";
      await this.enqueueSlackWrite(`unmapped:${context.channelId}:${context.ts}`, async () => {
        await this.slack.postThreadReply(context.channelId, context.ts, renderSystemMessage(reason));
      });
      return { status: "manual_retry", reason };
    }

    const existing = this.store.getWorker(context.teamId, context.channelId, context.ts);
    if (existing) {
      const worker = this.ensureWorkerWorkstream(this.ensureWorkerIdentity(existing));
      this.store.updateInboundMessageProgress(record.key, {
        workerKey: worker.key,
        appThreadId: worker.appThreadId,
        turnId: worker.activeTurnId,
      });
      if (!worker.activeTurnId && worker.status === "idle" && worker.lastInboundMessageTs === context.ts) {
        const turnInput = await this.toTurnInput(context, record.key, true);
        const turnId = await this.startWorkerTurn(worker, turnInput);
        this.store.updateInboundMessageProgress(record.key, {
          workerKey: worker.key,
          appThreadId: worker.appThreadId,
          turnId,
        });
      }
      return { status: "processed" };
    }

    const turnInput = await this.toTurnInput(context, record.key, true);
    const turnId = await this.spawnWorkerIntoWorkstream({
      workstream,
      channelId: context.channelId,
      existingRootTs: context.ts,
      title: buildRequestTitle(context.text),
      itemBody: turnInput.text,
      turnInput,
      rootOwnerUserId: context.userId,
      ownerUserId: context.userId,
      runtimeSettings: { model: null, effort: null },
      source: {
        sourceKind: "slack-channel-root",
        sourceSummary: `${context.username} started a new request in #${context.channelName ?? context.channelId}`,
        sourceSlackChannelId: context.channelId,
        sourceSlackMessageTs: context.ts,
        toAddress: formatWorkstreamAddress(workstream),
      },
      identity: null,
      parentWorkerKey: null,
      shellId: record.key,
    });
    const created = this.store.getWorker(context.teamId, context.channelId, context.ts);
    if (created) {
      this.store.updateInboundMessageProgress(record.key, {
        workerKey: created.key,
        appThreadId: created.appThreadId,
        turnId,
      });
    }
    return { status: "processed" };
  }

  private async handleChannelThreadReply(context: SlackMessageContext, record: InboundMessageRecord): Promise<InboundHandlingResult> {
    let worker = this.store.getWorker(context.teamId, context.channelId, context.threadTs!);
    if (!worker) return { status: "processed" };
    worker = this.ensureWorkerWorkstream(worker);

    const command = parseSlashCommand(context.text);
    if (command) {
      await this.handleThreadCommand(worker, command.name, command.args);
      return { status: "processed" };
    }

    if (worker.pendingRequest) {
      await this.resolveWorkerPendingRequest(worker, context);
      return { status: "processed" };
    }

    worker = this.ensureWorkerIdentity(worker);
    await this.setWorkerIdentityReaction(worker);
    await this.setThreadStatusReaction(worker.channelId, worker.rootTs, STATUS_REACTIONS.seen);

    worker = await this.prepareWorkerForSend(worker);
    if (isManuallyBlockedStatus(worker.status)) {
      const reason = worker.lastError ?? "Backing Codex thread is missing. Run /recover.";
      await this.postWorkerSystemMessage(worker, reason);
      return { status: "manual_retry", reason };
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
        return { status: "processed" };
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
      const reason = worker.lastError ?? "Backing Codex thread is missing. Run /recover.";
      await this.postWorkerSystemMessage(worker, reason);
      return { status: "manual_retry", reason };
    }

    const turnId = await this.startWorkerTurn(worker, input);
    this.store.updateInboundMessageProgress(record.key, {
      workerKey: worker.key,
      appThreadId: worker.appThreadId,
      turnId,
    });
    return { status: "processed" };
  }

  private async handleDmMessage(context: SlackMessageContext, record: InboundMessageRecord): Promise<InboundHandlingResult> {
    if (!this.config.adminUserIds.includes(context.userId)) {
      await this.enqueueSlackWrite(this.getDmQueueKey(context.teamId, context.userId), async () => {
        await this.slack.postTopLevelMessage(context.channelId, "Not authorized.");
      });
      return { status: "processed" };
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
        settings: { model: null, effort: null },
        lastError: null,
        lastInboundMessageTs: null,
        pendingRequest: null,
      });
    } else if (session.channelId !== context.channelId) {
      session = this.store.upsertDmSession({ ...session, channelId: context.channelId });
    }

    const command = parseSlashCommand(context.text);
    if (command) {
      const result = await this.handleDmCommand(session, command.name, command.args);
      await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () => {
        await this.slack.postTopLevelMessage(session!.channelId, result.response);
      });
      if (result.afterSend) {
        await result.afterSend();
      }
      return { status: "processed" };
    }

    if (session.pendingRequest) {
      await this.resolveDmPendingRequest(session, context);
      return { status: "processed" };
    }

    session = await this.prepareDmForSend(session);
    if (isManuallyBlockedStatus(session.status)) {
      const reason = session.lastError ?? "Backing Codex thread is missing. Run /recover.";
      await this.postDmSystemMessage(session, reason);
      return { status: "manual_retry", reason };
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
        return { status: "processed" };
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
      const reason = session.lastError ?? "Backing Codex thread is missing. Run /recover.";
      await this.postDmSystemMessage(session, reason);
      return { status: "manual_retry", reason };
    }

    const turnId = await this.startDmTurn(session, input);
    this.store.updateInboundMessageProgress(record.key, {
      appThreadId: session.appThreadId,
      turnId,
    });
    return { status: "processed" };
  }

  private async prepareWorkerForSend(worker: WorkerRecord): Promise<WorkerRecord> {
    const startingTurn = this.startingWorkerTurns.get(worker.key);
    if (startingTurn) {
      try {
        await startingTurn;
      } catch {
        // Turn-start failure is handled by the originating request path.
      }
      worker = this.requireWorker(worker.key);
      if (worker.activeTurnId || worker.status === "running") {
        return worker;
      }
    }

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

    if (state === "idle" && worker.status === "blocked_running_turn") {
      return this.clearWorkerBlockedRunningTurn(worker, "The previous Codex turn finished. This thread is ready for new messages.");
    }
    if (state === "running") {
      return this.markWorkerBlockedRunningTurn(worker, "The previous Codex turn is still finishing. Wait for it to settle or use /recover to abandon it.");
    }
    if (state === "missing") {
      return this.markWorkerRecoveryRequired(worker, "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation.");
    }
    if (state === "unknown") {
      throw new Error("Could not reconcile worker thread state with Codex app-server.");
    }

    return this.requireWorker(worker.key);
  }

  private async prepareDmForSend(session: DmSessionRecord): Promise<DmSessionRecord> {
    if (!session.appThreadId) {
      return this.requireDmSession(session.teamId, session.userId);
    }
    const sessionKey = this.getDmSessionKey(session.teamId, session.userId);
    const startingTurn = this.startingDmTurns.get(sessionKey);
    if (startingTurn) {
      try {
        await startingTurn;
      } catch {
        // Turn-start failure is handled by the originating request path.
      }
      session = this.requireDmSession(session.teamId, session.userId);
      if (session.activeTurnId || session.status === "running") {
        return session;
      }
    }
    const state = await this.codex.reconcileThreadForSend(session.appThreadId!);
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
    if (state === "idle" && session.status === "blocked_running_turn") {
      return this.clearDmBlockedRunningTurn(session, "The previous Codex turn finished. This DM is ready for new messages.");
    }
    if (state === "running") {
      return this.markDmBlockedRunningTurn(session, "The previous Codex turn is still finishing. Wait for it to settle or use /recover to abandon it.");
    }
    if (state === "missing") {
      return this.markDmRecoveryRequired(session, "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread.");
    }
    if (state === "unknown") {
      throw new Error("Could not reconcile DM thread state with Codex app-server.");
    }
    return this.requireDmSession(session.teamId, session.userId);
  }

  private async spawnWorkerIntoWorkstream(input: {
    workstream: WorkstreamRecord;
    channelId: string;
    title: string;
    itemBody: string;
    turnInput: TurnInput;
    rootOwnerUserId: string;
    ownerUserId: string;
    runtimeSettings: RuntimeSettings;
    source: WorkstreamSourceInput;
    identity: WorkerRecord["identity"] | null;
    parentWorkerKey: string | null;
    existingRootTs?: string;
    mode?: "fresh" | "fork";
    surfaceFailuresInThread?: boolean;
    shellId?: string;
  }): Promise<string> {
    this.assertNotStopping();
    const shellId = input.shellId ?? `${input.workstream.teamId}:${input.channelId}:${input.existingRootTs ?? Date.now().toString()}:${input.title}`;
    let shell = this.store.getPendingWorkerShell(shellId);
    if (!shell) {
      shell = this.store.upsertPendingWorkerShell({
        id: shellId,
        teamId: input.workstream.teamId,
        workstreamId: input.workstream.id,
        channelId: input.channelId,
        rootTs: input.existingRootTs ?? null,
        title: input.title,
        requestItemId: null,
        requestItemPath: null,
        ownerUserId: input.ownerUserId,
        rootOwnerUserId: input.rootOwnerUserId,
        settings: input.runtimeSettings,
        identity: input.identity ?? assignWorkerIdentity(this.store.listWorkers()),
        parentWorkerKey: input.parentWorkerKey,
        source: input.source,
        status: "pending",
        appThreadId: null,
        lastError: null,
      });
    }
    this.assertNotStopping();
    if (!shell.requestItemId || !shell.requestItemPath) {
      const requestItem = await this.workstreams.createRequestItem(input.workstream, {
        title: input.title,
        body: input.itemBody,
        source: input.source,
      });
      shell = this.store.upsertPendingWorkerShell({
        ...shell,
        requestItemId: requestItem.id,
        requestItemPath: requestItem.filePath,
        lastError: null,
      });
    }
    this.assertNotStopping();

    const rootTs = shell.rootTs
      ?? await this.enqueueSlackWrite(`spawn:${input.workstream.id}:${input.channelId}`, async () =>
        this.slack.postTopLevelMessage(input.channelId, input.title, shell!.identity),
      );
    shell = this.store.upsertPendingWorkerShell({
      ...shell,
      rootTs,
      status: "slack_created",
      lastError: null,
    });
    this.assertNotStopping();

    let threadId: string;
    try {
      if (shell.appThreadId) {
        threadId = shell.appThreadId;
      } else if (input.mode === "fork" && input.parentWorkerKey) {
        const parent = this.requireWorker(input.parentWorkerKey);
        threadId = (await this.codex.forkWorkerThread(parent.appThreadId, input.runtimeSettings)).threadId;
      } else {
        threadId = (await this.codex.createWorkerThread(input.runtimeSettings)).threadId;
      }
    } catch (error) {
      if (input.surfaceFailuresInThread) {
        const message = error instanceof Error ? error.message : String(error);
        await this.enqueueSlackWrite(`spawn-failed:${input.channelId}:${rootTs}`, async () => {
          await this.slack.postThreadReply(input.channelId, rootTs, renderSystemMessage(`Worker creation failed: ${message}`));
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      this.store.upsertPendingWorkerShell({
        ...shell,
        status: "failed",
        lastError: message,
      });
      throw new Error(input.surfaceFailuresInThread ? `failed to create the backing worker: ${message}` : message);
    }
    shell = this.store.upsertPendingWorkerShell({
      ...shell,
      status: "thread_created",
      appThreadId: threadId,
      lastError: null,
    });
    this.assertNotStopping();

    const worker = this.store.upsertWorker({
      key: `${input.workstream.teamId}:${input.channelId}:${rootTs}`,
      teamId: input.workstream.teamId,
      channelId: input.channelId,
      rootTs,
      workstreamId: input.workstream.id,
      appThreadId: threadId,
      activeTurnId: null,
      ownerUserId: input.ownerUserId,
      rootOwnerUserId: input.rootOwnerUserId,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      settings: input.runtimeSettings,
      identity: shell.identity,
      parentWorkerKey: input.parentWorkerKey,
      requestItemId: shell.requestItemId,
      requestItemPath: shell.requestItemPath,
      lastError: null,
      lastInboundMessageTs: rootTs,
      pendingRequest: null,
    });
    this.assertNotStopping();
    await this.workstreams.bindRequestItemToWorker(
      input.workstream,
      {
        id: shell.requestItemId!,
        filePath: shell.requestItemPath!,
        title: shell.title,
        body: input.itemBody,
        source: shell.source,
        createdAt: shell.createdAt,
      },
      worker,
    );
    this.store.upsertPendingWorkerShell({
      ...shell,
      status: "ready_to_start",
      lastError: null,
    });
    this.assertNotStopping();
    await this.setWorkerIdentityReaction(worker);
    await this.setThreadStatusReaction(input.channelId, rootTs, STATUS_REACTIONS.seen);

    try {
      const turnId = await this.startWorkerTurn(worker, input.turnInput);
      this.store.deletePendingWorkerShell(shell.id);
      return turnId;
    } catch (error) {
      if (input.surfaceFailuresInThread) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateWorkerState(worker.key, {
          status: "failed",
          lastError: message,
        });
        await this.postWorkerSystemMessage(worker, `Worker startup failed: ${message}`);
        this.store.upsertPendingWorkerShell({
          ...shell,
          status: "failed",
          lastError: message,
        });
      }
      throw error;
    }
  }

  private assertNotStopping(): void {
    if (this.stopping) {
      throw new Error("Shutdown in progress.");
    }
  }

  private async startWorkerTurn(worker: WorkerRecord, input: TurnInput): Promise<string> {
    const existing = this.startingWorkerTurns.get(worker.key);
    if (existing) return existing;

    const turnPromise = (async () => {
      let turnId: string;
      try {
        turnId = await this.codex.startTurnWithResumeFallback(
          worker.appThreadId,
          input,
          resolveRuntimeSettings(worker.settings, this.store.getTeamDefaults(worker.teamId)),
          {
            onTurnStarted: async () => {
              await this.onWorkerTurnStarted(worker.key);
            },
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
      } catch (error) {
        this.store.updateWorkerState(worker.key, {
          status: "idle",
          lastError: null,
        });
        throw error;
      } finally {
        this.startingWorkerTurns.delete(worker.key);
      }
      this.store.updateWorkerState(worker.key, {
        activeTurnId: turnId,
        status: "running",
        lastError: null,
        pendingRequest: null,
      });
      return turnId;
    })();
    this.startingWorkerTurns.set(worker.key, turnPromise);
    return turnPromise;
  }

  private async startDmTurn(session: DmSessionRecord, input: TurnInput): Promise<string> {
    const sessionKey = this.getDmSessionKey(session.teamId, session.userId);
    const existing = this.startingDmTurns.get(sessionKey);
    if (existing) return existing;

    let latestSession = session;
    if (!latestSession.appThreadId) {
      const created = await this.codex.createAdminThread(
        resolveRuntimeSettings(latestSession.settings, this.store.getTeamDefaults(latestSession.teamId)),
      );
      latestSession = this.store.upsertDmSession({
        ...latestSession,
        appThreadId: created.threadId,
        status: "idle",
      });
    }

    const turnPromise = (async () => {
      let turnId: string;
      try {
        turnId = await this.codex.startTurnWithResumeFallback(
          latestSession.appThreadId!,
          input,
          latestSession.settings,
          {
            onTurnStarted: async () => {
              await this.onDmTurnStarted(latestSession.teamId, latestSession.userId);
            },
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
      } catch (error) {
        this.store.upsertDmSession({
          ...this.requireDmSession(latestSession.teamId, latestSession.userId),
          status: "idle",
          lastError: null,
        });
        throw error;
      } finally {
        this.startingDmTurns.delete(sessionKey);
      }

      this.store.upsertDmSession({
        ...this.requireDmSession(latestSession.teamId, latestSession.userId),
        activeTurnId: turnId,
        status: "running",
        lastError: null,
        pendingRequest: null,
      });
      return turnId;
    })();
    this.startingDmTurns.set(sessionKey, turnPromise);
    return turnPromise;
  }

  private async onWorkerAgentDelta(workerKey: string, itemId: string, delta: string): Promise<void> {
    void workerKey;
    void itemId;
    void delta;
  }

  private async onWorkerTurnStarted(workerKey: string): Promise<void> {
    const worker = this.requireWorker(workerKey);
    await this.setThreadStatusReaction(
      worker.channelId,
      worker.rootTs,
      STATUS_REACTIONS.running,
    );
  }

  private async onWorkerAgentMessage(workerKey: string, itemId: string, text: string): Promise<void> {
    const state = this.getRenderState(`worker:${workerKey}`);
    await this.flushPendingWorkerAssistant(workerKey, false);
    state.pendingAssistant = { itemId, text };
  }

  private async onWorkerWorklogItem(workerKey: string, event: WorklogItem): Promise<void> {
    if (event.status === "started") return;
    const worker = this.ensureWorkerIdentity(this.requireWorker(workerKey));
    await this.flushPendingWorkerAssistant(workerKey, false);
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, renderEventMessage(event), worker.identity);
    });
  }

  private async onWorkerCompleted(workerKey: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const worker = this.ensureWorkerWorkstream(this.ensureWorkerIdentity(this.requireWorker(workerKey)));
    const state = this.getRenderState(`worker:${workerKey}`);
    const finalAssistantText = state.pendingAssistant?.text ?? assistantText;
    if (status === "interrupted" && state.pendingAssistant) {
      await this.flushPendingWorkerAssistant(workerKey, false);
    }
    state.pendingAssistant = null;

    if (status === "completed") {
      const finalText = renderFinalMessage(worker.rootOwnerUserId, finalAssistantText);
      await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
        await this.slack.postThreadReply(worker.channelId, worker.rootTs, finalText, worker.identity);
      });
    } else if (status === "interrupted") {
      await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
        await this.slack.postThreadReply(worker.channelId, worker.rootTs, renderSystemMessage("Turn interrupted."));
      });
    } else {
      const finalText = renderFinalMessage(worker.rootOwnerUserId, `Turn ${status}.${error ? ` ${error}` : ""}`);
      await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
        await this.slack.postThreadReply(worker.channelId, worker.rootTs, finalText, worker.identity);
      });
    }

    if (worker.workstreamId) {
      const workstream = this.store.getWorkstreamById(worker.workstreamId);
      if (workstream) {
        const responseBody = status === "completed"
          ? finalAssistantText
          : `Turn ${status}.${error ? ` ${error}` : ""}`;
        const responsePath = await this.workstreams.appendResponseItem(workstream, worker, {
          status,
          body: responseBody,
          requestItemId: worker.requestItemId,
        });
        if (status === "completed" || status === "failed") {
          await this.workstreams.archiveWorkerItems(workstream, worker, responsePath, status);
        }
      }
    }

    this.store.updateWorkerState(workerKey, {
      activeTurnId: null,
      status: normalizeTurnStatus(status),
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: status === "interrupted" ? null : error ?? (status === "completed" ? null : `Turn ${status}`),
    });
    await this.setThreadStatusReaction(
      worker.channelId,
      worker.rootTs,
      status === "completed"
        ? STATUS_REACTIONS.completed
        : status === "interrupted"
          ? STATUS_REACTIONS.interrupted
          : STATUS_REACTIONS.failed,
    );
    await this.maybeExecuteQueuedRestart();
    await this.processRegistrationLoop();
  }

  private async onDmAgentDelta(teamId: string, userId: string, itemId: string, delta: string): Promise<void> {
    void teamId;
    void userId;
    void itemId;
    void delta;
  }

  private async onDmTurnStarted(teamId: string, userId: string): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    if (!session.lastInboundMessageTs) return;
    await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
      await this.slack.setStatusReaction(session.channelId, session.lastInboundMessageTs!, STATUS_REACTIONS.running);
    });
  }

  private async onDmAgentMessage(teamId: string, userId: string, itemId: string, text: string): Promise<void> {
    const state = this.getRenderState(`dm:${teamId}:${userId}`);
    await this.flushPendingDmAssistant(teamId, userId, false);
    state.pendingAssistant = { itemId, text };
  }

  private async onDmWorklogItem(teamId: string, userId: string, event: WorklogItem): Promise<void> {
    if (event.status === "started") return;
    const session = this.requireDmSession(teamId, userId);
    await this.flushPendingDmAssistant(teamId, userId, false);
    await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
      await this.slack.postTopLevelMessage(session.channelId, renderEventMessage(event));
    });
  }

  private async onDmCompleted(teamId: string, userId: string, assistantText: string, status: string, error?: string | null): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    const state = this.getRenderState(`dm:${teamId}:${userId}`);
    const finalAssistantText = state.pendingAssistant?.text ?? assistantText;
    if (status === "interrupted" && state.pendingAssistant) {
      await this.flushPendingDmAssistant(teamId, userId, false);
    }
    state.pendingAssistant = null;
    if (status === "completed") {
      const text = finalAssistantText || "Done.";
      await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
        await this.slack.postTopLevelMessage(session.channelId, text);
      });
    } else if (status === "interrupted") {
      await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
        await this.slack.postTopLevelMessage(session.channelId, renderSystemMessage("Turn interrupted."));
      });
    } else {
      const text = `Turn ${status}.${error ? ` ${error}` : ""}`;
      await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
        await this.slack.postTopLevelMessage(session.channelId, text);
      });
    }

    this.store.upsertDmSession({
      ...session,
      activeTurnId: null,
      status: normalizeTurnStatus(status),
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      pendingRequest: null,
      lastError: status === "interrupted" ? null : error ?? (status === "completed" ? null : `Turn ${status}`),
    });
    if (session.lastInboundMessageTs) {
      await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
        await this.slack.setStatusReaction(
          session.channelId,
          session.lastInboundMessageTs!,
          status === "completed"
            ? STATUS_REACTIONS.completed
            : status === "interrupted"
              ? STATUS_REACTIONS.interrupted
              : STATUS_REACTIONS.failed,
        );
      });
    }
    await this.maybeExecuteQueuedRestart();
    await this.processRegistrationLoop();
  }

  private getRenderState(key: string): RenderSessionState {
    let state = this.renderState.get(key);
    if (!state) {
      state = {
        pendingAssistant: null,
      };
      this.renderState.set(key, state);
    }
    return state;
  }

  private async flushPendingWorkerAssistant(workerKey: string, final: boolean): Promise<void> {
    const worker = this.ensureWorkerIdentity(this.requireWorker(workerKey));
    const state = this.getRenderState(`worker:${workerKey}`);
    const pending = state.pendingAssistant;
    if (!pending) return;
    state.pendingAssistant = null;
    const text = final ? renderFinalMessage(worker.rootOwnerUserId, pending.text) : pending.text;
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, text, worker.identity);
    });
  }

  private async flushPendingDmAssistant(teamId: string, userId: string, final: boolean): Promise<void> {
    const session = this.requireDmSession(teamId, userId);
    const state = this.getRenderState(`dm:${teamId}:${userId}`);
    const pending = state.pendingAssistant;
    if (!pending) return;
    state.pendingAssistant = null;
    const text = final ? (pending.text || "Done.") : pending.text;
    await this.enqueueSlackWrite(this.getDmQueueKey(teamId, userId), async () => {
      await this.slack.postTopLevelMessage(session.channelId, text);
    });
  }

  private async setThreadStatusReaction(channelId: string, rootTs: string, emoji: string): Promise<void> {
    await this.enqueueSlackWrite(`reactions:${channelId}:${rootTs}`, async () => {
      await this.slack.setStatusReaction(channelId, rootTs, emoji);
    });
  }

  private async setWorkerIdentityReaction(worker: WorkerRecord): Promise<void> {
    if (!worker.identity) return;
    await this.enqueueSlackWrite(`reactions:${worker.channelId}:${worker.rootTs}`, async () => {
      await this.slack.addRootReaction(worker.channelId, worker.rootTs, worker.identity!.iconEmoji);
    });
  }

  private async handleThreadCommand(worker: WorkerRecord, name: string, args: string[]): Promise<void> {
    let response = "";
    if (name === "help") {
      response = helpText("thread");
    } else if (name === "status") {
      response = await this.buildThreadStatusMessage(worker, false);
    } else if (name === "health") {
      response = await this.buildThreadStatusMessage(worker, true);
    } else if (name === "model") {
      const defaults = this.store.getTeamDefaults(worker.teamId);
      if (args.length === 0) {
        response = [
          `Effective model: ${describeEffectiveSetting(worker.settings.model, defaults.model)}`,
          `Thread model override: ${worker.settings.model ?? "(none)"}`,
          `Global default model: ${defaults.model ?? "(unset)"}`,
        ].join("\n");
      } else {
        worker.settings.model = args.join(" ");
        this.store.updateWorkerState(worker.key, { settings: worker.settings });
        response = `Thread model set: ${worker.settings.model}`;
      }
    } else if (name === "effort") {
      const defaults = this.store.getTeamDefaults(worker.teamId);
      if (args.length === 0) {
        response = [
          `Effective effort: ${describeEffectiveSetting(worker.settings.effort, defaults.effort)}`,
          `Thread effort override: ${worker.settings.effort ?? "(none)"}`,
          `Global default effort: ${defaults.effort ?? "(unset)"}`,
          `Allowed: ${DEFAULT_EFFORTS.join(", ")}`,
        ].join("\n");
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
      } else if (isUnavailableForCompact(worker.status)) {
        response = "Cannot compact while this thread is blocked or waiting for recovery.";
      } else {
        await this.codex.compactThread(worker.appThreadId);
        response = `Compaction requested for thread ${worker.appThreadId}`;
      }
    } else if (name === "stop") {
      if (!worker.activeTurnId) {
        response = "No active turn to stop.";
      } else {
        try {
          await this.codex.interruptTurn(worker.appThreadId, worker.activeTurnId);
        } catch {
          // Best effort: completion may have raced already.
        }
        response = renderSystemMessage("Interrupt requested.");
      }
    } else if (name === "recover") {
      if (!(await this.canRecoverWorkerNow(worker))) {
        response = "Recover is only available when this thread is blocked or its backing Codex thread is missing.";
      } else {
        const recovered = await this.recoverWorker(worker);
        response = `Created a fresh backing Codex thread for this Slack conversation.\nThread: ${recovered.appThreadId}`;
      }
    } else if (name === "workstream-create") {
      response = await this.createWorkstreamFromThreadArgs(worker, args);
    } else {
      response = "This command is only available in DMs.";
    }
    await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () => {
      await this.slack.postThreadReply(worker.channelId, worker.rootTs, response);
    });
  }

  private async handleDmCommand(session: DmSessionRecord, name: string, args: string[]): Promise<DmCommandResult> {
    const defaults = this.store.getTeamDefaults(session.teamId);
    const currentSession = this.store.getDmSession(session.teamId, session.userId);

    if (name === "help") return { response: helpText("dm") };
    if (name === "status") {
      return { response: await this.buildDmStatusMessage(currentSession ?? session, false) };
    }
    if (name === "health") {
      return { response: await this.buildDmStatusMessage(currentSession ?? session, true) };
    }
    if (name === "model") {
      if (args.length === 0) return { response: `Global default model: ${defaults.model ?? "(unset)"}` };
      defaults.model = args.join(" ");
      this.store.setTeamDefaults(session.teamId, defaults);
      return { response: `Default model set: ${defaults.model}` };
    }
    if (name === "effort") {
      if (args.length === 0) {
        return { response: `Global default effort: ${defaults.effort ?? "(unset)"}\nAllowed: ${DEFAULT_EFFORTS.join(", ")}` };
      }
      const effort = normalizeEffort(args[0]);
      if (!effort) return { response: `Usage: /effort <${DEFAULT_EFFORTS.join("|")}>` };
      defaults.effort = effort;
      this.store.setTeamDefaults(session.teamId, defaults);
      return { response: `Default effort set: ${effort}` };
    }
    if (name === "compact") {
      if (!currentSession?.appThreadId) return { response: "No DM admin thread to compact." };
      if (currentSession.activeTurnId || currentSession.pendingRequest) return { response: "Cannot compact while the DM admin thread is active." };
      if (isUnavailableForCompact(currentSession.status)) return { response: "Cannot compact while this DM is blocked or waiting for recovery." };
      await this.codex.compactThread(currentSession.appThreadId);
      return { response: `Compaction requested for thread ${currentSession.appThreadId}` };
    }
    if (name === "stop") {
      if (!currentSession?.appThreadId || !currentSession.activeTurnId) {
        return { response: "No active turn to stop." };
      }
      try {
        await this.codex.interruptTurn(currentSession.appThreadId, currentSession.activeTurnId);
      } catch {
        // Best effort: completion may have raced already.
      }
      return { response: renderSystemMessage("Interrupt requested.") };
    }
    if (name === "recover") {
      if (!(await this.canRecoverDmNow(currentSession ?? session))) {
        return { response: "Recover is only available when this DM is blocked or its backing Codex thread is missing." };
      }
      const recovered = await this.recoverDmSession(currentSession ?? session);
      return { response: `Created a fresh backing Codex admin thread.\nThread: ${recovered.appThreadId ?? "(none)"}` };
    }
    if (name === "restart") {
      const target = (args[0] ?? "").toLowerCase();
      if (!target || !["codex", "bridge", "both"].includes(target)) {
        return { response: "Usage: /restart <codex|bridge|both>" };
      }
      const queued = this.store.getPendingRestart();
      if (queued) {
        return {
          response: [
            `Restart already queued: ${queued.target}`,
            `requested_at: ${queued.requestedAt}`,
            "Use /restart-now to force it immediately or /restart-cancel to clear it.",
          ].join("\n"),
        };
      }
      if ((target === "bridge" || target === "both") && !this.config.supervisorRestartEnabled) {
        return {
          response: "Bridge restarts require the launcher/supervisor path. Launch via ./scripts/launch.sh or set SUPERVISOR_RESTART_ENABLED=1 under a restart-capable supervisor.",
        };
      }
      const pending = await this.queueRestart(currentSession ?? session, target as RestartTarget);
      return {
        response: [
          `Queued restart: ${pending.target}`,
          `requested_at: ${pending.requestedAt}`,
          "The runtime will restart once all active work finishes. New work is still allowed until then.",
        ].join("\n"),
        afterSend: async () => {
          await this.maybeExecuteQueuedRestart();
        },
      };
    }
    if (name === "restart-now") {
      const queued = this.store.getPendingRestart();
      if (!queued) {
        return { response: "No queued restart is waiting. Use /restart <codex|bridge|both> first." };
      }
      if ((queued.target === "bridge" || queued.target === "both") && !this.config.supervisorRestartEnabled) {
        return { response: "The queued bridge restart requires ./scripts/launch.sh supervisor mode before it can be forced." };
      }
      return {
        response: `Forcing queued restart now: ${queued.target}`,
        afterSend: async () => {
          await this.maybeExecuteQueuedRestart(true);
        },
      };
    }
    if (name === "restart-cancel") {
      const queued = this.store.getPendingRestart();
      if (!queued) {
        return { response: "No queued restart is waiting." };
      }
      this.store.clearPendingRestart();
      return { response: `Canceled queued restart: ${queued.target}` };
    }
    if (name === "workstream-create") {
      return { response: await this.createWorkstreamFromDmArgs(session, args) };
    }
    return { response: "Unknown command. Use /help" };
  }

  private async buildThreadStatusMessage(worker: WorkerRecord, includeHealth: boolean): Promise<string> {
    const current = this.ensureWorkerWorkstream(this.requireWorker(worker.key));
    const defaults = this.store.getTeamDefaults(current.teamId);
    const pendingRestart = this.store.getPendingRestart();
    const codexThreadState = await this.describeThreadState(current.appThreadId);
    const workstream = current.workstreamId ? this.store.getWorkstreamById(current.workstreamId) : null;
    const lines = [
      includeHealth ? "Worker Health" : "Worker Status",
      `worker: ${current.identity?.username ?? "Codex Worker"}`,
      `workstream: ${workstream ? formatWorkstreamAddress(workstream) : "(unassigned)"}`,
      `status: ${current.status}`,
      `app_thread: ${current.appThreadId}`,
      `active_turn: ${current.activeTurnId ?? "(none)"}`,
      `effective_model: ${describeEffectiveSetting(current.settings.model, defaults.model)}`,
      `effective_effort: ${describeEffectiveSetting(current.settings.effort, defaults.effort)}`,
      `thread_model_override: ${current.settings.model ?? "(none)"}`,
      `thread_effort_override: ${current.settings.effort ?? "(none)"}`,
      `global_default_model: ${defaults.model ?? "(unset)"}`,
      `global_default_effort: ${defaults.effort ?? "(unset)"}`,
      `workspace_timezone: ${this.config.workspaceTimezone}`,
      `pending_request: ${current.pendingRequest ? current.pendingRequest.kind : "(none)"}`,
      `last_inbound_ts: ${current.lastInboundMessageTs ?? "(none)"}`,
      `last_error: ${current.lastError ?? "(none)"}`,
      `queued_restart: ${pendingRestart ? `${pendingRestart.target} @ ${pendingRestart.requestedAt}` : "(none)"}`,
    ];
    if (includeHealth) {
      lines.push(`workspace_root: ${this.config.workspaceRoot}`);
      lines.push(`database_path: ${this.config.databasePath}`);
      lines.push(`attachment_storage: ${this.config.attachmentStorageDir}`);
      lines.push(`codex_process: ${this.codex.isRunning() ? "running" : "down"}`);
      lines.push(`codex_thread_state: ${codexThreadState}`);
      lines.push(`start_in_flight: ${this.startingWorkerTurns.has(current.key) ? "yes" : "no"}`);
    }
    return lines.join("\n");
  }

  private async buildDmStatusMessage(session: DmSessionRecord, includeHealth: boolean): Promise<string> {
    const current = this.requireDmSession(session.teamId, session.userId);
    const defaults = this.store.getTeamDefaults(current.teamId);
    const workers = this.store.listWorkers();
    const blockedWorkers = workers.filter((worker) => isManuallyBlockedStatus(worker.status)).length;
    const pendingRestart = this.store.getPendingRestart();
    const codexThreadState = current.appThreadId ? await this.describeThreadState(current.appThreadId) : "(no thread)";
    const lines = [
      includeHealth ? "Bridge Health" : "Bridge Status",
      `team: ${current.teamId}`,
      `dm_thread: ${current.appThreadId ?? "(none)"}`,
      `dm_status: ${current.status}`,
      `dm_active_turn: ${current.activeTurnId ?? "(none)"}`,
      `global_default_model: ${defaults.model ?? "(unset)"}`,
      `global_default_effort: ${defaults.effort ?? "(unset)"}`,
      `workspace_timezone: ${this.config.workspaceTimezone}`,
      `workers_active: ${this.store.listWorkersWithActiveTurns().length}`,
      `workers_blocked_or_recovery_required: ${blockedWorkers}`,
      `queued_restart: ${pendingRestart ? `${pendingRestart.target} @ ${pendingRestart.requestedAt}` : "(none)"}`,
    ];
    if (includeHealth) {
      lines.push(`workspace_root: ${this.config.workspaceRoot}`);
      lines.push(`database_path: ${this.config.databasePath}`);
      lines.push(`attachment_storage: ${this.config.attachmentStorageDir}`);
      lines.push(`supervisor_restart: ${this.config.supervisorRestartEnabled ? "enabled" : "disabled"}`);
      lines.push(`launch_mode: ${this.config.launchMode}`);
      lines.push(`codex_process: ${this.codex.isRunning() ? "running" : "down"}`);
      lines.push(`codex_thread_state: ${codexThreadState}`);
      lines.push(`workers_total: ${workers.length}`);
      lines.push(`dm_sessions_total: ${this.store.listDmSessions().length}`);
      lines.push(`dm_pending_request: ${current.pendingRequest ? current.pendingRequest.kind : "(none)"}`);
      lines.push(`dm_last_error: ${current.lastError ?? "(none)"}`);
    }
    return lines.join("\n");
  }

  private async describeThreadState(threadId: string): Promise<string> {
    if (!this.codex.isRunning()) return "codex-down";
    try {
      return await this.codex.readThreadStatus(threadId);
    } catch (error) {
      if (isMissingThreadError(error)) return "missing";
      return "unknown";
    }
  }

  private async queueRestart(session: DmSessionRecord, target: RestartTarget): Promise<PendingRestartRecord> {
    const pending: PendingRestartRecord = {
      target,
      teamId: session.teamId,
      userId: session.userId,
      channelId: session.channelId,
      requestedAt: new Date().toISOString(),
    };
    this.store.setPendingRestart(pending);
    return pending;
  }

  private isRuntimeIdle(): boolean {
    return this.store.listWorkersWithActiveTurns().length === 0
      && this.store.listDmSessionsWithActiveTurns().length === 0
      && this.startingWorkerTurns.size === 0
      && this.startingDmTurns.size === 0;
  }

  private async maybeExecuteQueuedRestart(force = false): Promise<void> {
    if (this.executingQueuedRestart) return;
    const pending = this.store.getPendingRestart();
    if (!pending) return;
    if (!force && !this.isRuntimeIdle()) return;
    this.executingQueuedRestart = true;
    try {
      await this.executeQueuedRestart(pending);
    } finally {
      this.executingQueuedRestart = false;
    }
  }

  private async executeQueuedRestart(pending: PendingRestartRecord): Promise<void> {
    if (pending.target === "codex") {
      this.store.clearPendingRestart();
      try {
        await this.enqueueSlackWrite(this.getDmQueueKey(pending.teamId, pending.userId), async () => {
          await this.slack.postTopLevelMessage(pending.channelId, renderSystemMessage("Restarting Codex now."));
        });
        await this.codex.restart();
        await this.reconcilePersistedRuntimeState();
        await this.enqueueSlackWrite(this.getDmQueueKey(pending.teamId, pending.userId), async () => {
          await this.slack.postTopLevelMessage(pending.channelId, renderSystemMessage("Codex restarted. Back online."));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.enqueueSlackWrite(this.getDmQueueKey(pending.teamId, pending.userId), async () => {
          await this.slack.postTopLevelMessage(pending.channelId, renderSystemMessage(`Queued Codex restart failed: ${message}`));
        });
      }
      return;
    }

    if (!this.config.supervisorRestartEnabled) {
      await this.enqueueSlackWrite(this.getDmQueueKey(pending.teamId, pending.userId), async () => {
        await this.slack.postTopLevelMessage(pending.channelId, renderSystemMessage("Queued bridge restart cannot run without ./scripts/launch.sh supervisor mode."));
      });
      return;
    }

    this.store.clearPendingRestart();
    await this.enqueueSlackWrite(this.getDmQueueKey(pending.teamId, pending.userId), async () => {
      await this.slack.postTopLevelMessage(
        pending.channelId,
        renderSystemMessage(pending.target === "both" ? "Restarting bridge and Codex now." : "Restarting bridge now."),
      );
    });
    this.store.setPendingRestartNotice(pending);
    this.emit("restartRequested", pending.target);
  }

  private async postPendingRestartNotice(): Promise<void> {
    const notice = this.store.consumePendingRestartNotice();
    if (!notice) return;
    const message = notice.target === "both"
      ? "Bridge and Codex restarted. Back online."
      : "Bridge restarted. Back online.";
    await this.enqueueSlackWrite(this.getDmQueueKey(notice.teamId, notice.userId), async () => {
      await this.slack.postTopLevelMessage(notice.channelId, renderSystemMessage(message));
    });
  }

  private async handleListChannelsTool(query: string, ctx: DynamicToolHandlerContext): Promise<string> {
    const worker = this.store.getWorkerByAppThreadId(ctx.threadId);
    if (!worker) return "No Slack worker context found.";
    const channels = await this.slack.listChannels(worker.teamId, query);
    this.store.upsertChannels(channels);
    const workstreams = this.store.listWorkstreams(worker.teamId);
    const allowed = channels.filter((channel) => workstreams.some((workstream) => workstream.channelId === channel.channelId));
    if (allowed.length === 0) return "No matching registered workstream channels.";
    return allowed.slice(0, 50).map((channel) => `${channel.name} (${channel.channelId})`).join("\n");
  }

  private async handleSpawnWorkerTool(
    args: { channel?: string | undefined; title: string; initialUserMessage: string; mode: "fresh" | "fork" },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const parentRecord = this.store.getWorkerByAppThreadId(ctx.threadId);
    const parent = parentRecord ? this.ensureWorkerWorkstream(parentRecord) : null;
    if (!parent) return "No Slack worker context found.";

    const parentWorkstream = parent.workstreamId ? this.store.getWorkstreamById(parent.workstreamId) : null;
    if (!parentWorkstream) return "No workstream is attached to this Slack worker.";

    const targetChannel = args.channel
      ? await this.slack.resolveChannel(parent.teamId, args.channel, parent.channelId)
      : {
          teamId: parent.teamId,
          channelId: parent.channelId,
          name: parentWorkstream.channelName,
          isPrivate: false,
          isMember: true,
          updatedAt: new Date().toISOString(),
        };

    const targetWorkstream = this.workstreams.resolveWorkstreamForChannel(parent.teamId, targetChannel.channelId);
    if (!targetWorkstream) {
      return "That Slack channel is not registered as a workstream home.";
    }

    const childIdentity = assignWorkerIdentity(this.store.listWorkers());
    try {
      await this.spawnWorkerIntoWorkstream({
        workstream: targetWorkstream,
        channelId: targetChannel.channelId,
        title: args.title,
        itemBody: args.initialUserMessage,
        turnInput: { text: args.initialUserMessage, imagePaths: [] },
        rootOwnerUserId: parent.rootOwnerUserId,
        ownerUserId: parent.ownerUserId,
        runtimeSettings: parent.settings,
        source: {
          sourceKind: args.mode === "fork" ? "slack-spawn-worker-fork" : "slack-spawn-worker-fresh",
          sourceSummary: `spawned from ${parent.key}`,
          sourceSlackChannelId: parent.channelId,
          sourceSlackMessageTs: parent.rootTs,
          fromAddress: formatWorkstreamAddress(parentWorkstream) + `/${parent.key}`,
          toAddress: formatWorkstreamAddress(targetWorkstream),
        },
        identity: childIdentity,
        parentWorkerKey: parent.key,
        mode: args.mode,
        surfaceFailuresInThread: true,
        shellId: ctx.callId,
      });
      return `Spawned child worker in ${targetChannel.channelId} with title "${args.title}".`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("failed to create the backing worker")) {
        return `Created child Slack thread in ${targetChannel.channelId}, but ${message}`;
      }
      return `Child worker startup failed: ${message}`;
    }
  }

  private async handleCreateWorkstreamTool(
    args: { slug: string; parent?: string | undefined; description?: string | undefined },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const worker = this.store.getWorkerByAppThreadId(ctx.threadId);
    if (worker) {
      return this.createWorkstreamForContext({
        teamId: worker.teamId,
        defaultParentRelativePath: worker.workstreamId
          ? (this.store.getWorkstreamById(worker.workstreamId)?.relativePath ?? null)
          : null,
        slug: args.slug,
        parentRelativePath: args.parent,
        description: args.description,
        initiatedFrom: `worker:${worker.key}`,
      });
    }

    const session = this.store.listDmSessions().find((candidate) => candidate.appThreadId === ctx.threadId) ?? null;
    if (session) {
      return this.createWorkstreamForContext({
        teamId: session.teamId,
        defaultParentRelativePath: null,
        slug: args.slug,
        parentRelativePath: args.parent,
        description: args.description,
        initiatedFrom: `dm:${session.userId}`,
      });
    }

    return "No Slack context found for workstream creation.";
  }

  private async handleUploadFilesTool(
    args: { files: Array<{ path: string; title?: string | undefined }>; comment?: string | undefined },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const files = await validateSlackUploadFiles(args.files, this.config);
    const worker = this.store.getWorkerByAppThreadId(ctx.threadId);
    if (worker) {
      const uploaded = await this.enqueueSlackWrite(this.getWorkerQueueKey(worker), async () =>
        this.slack.uploadFilesToConversation(worker.channelId, worker.rootTs, files, args.comment),
      );
      return formatUploadResult(uploaded);
    }

    const session = this.store.listDmSessions().find((candidate) => candidate.appThreadId === ctx.threadId) ?? null;
    if (session) {
      const uploaded = await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () =>
        this.slack.uploadFilesToConversation(session.channelId, null, files, args.comment),
      );
      return formatUploadResult(uploaded);
    }

    return "No Slack upload context found.";
  }

  private async handleSetHeartbeatTool(
    args: { registrationId?: string | undefined; intervalMinutes: number; description?: string | undefined },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registration = await this.registrations.setHeartbeat(context, {
      registrationId: args.registrationId,
      intervalMinutes: args.intervalMinutes,
      description: args.description,
    });
    return formatRegistrationSummary(registration);
  }

  private async handleSetCronTool(
    args: { registrationId?: string | undefined; schedule: string; target: "self" | "workstream"; description?: string | undefined },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registration = await this.registrations.setCron(context, {
      registrationId: args.registrationId,
      schedule: args.schedule,
      target: args.target,
      description: args.description,
    });
    return formatRegistrationSummary(registration);
  }

  private async handleSetWebhookTool(
    args: {
      registrationId?: string | undefined;
      source: string;
      events: string[];
      target: "self" | "workstream";
      description?: string | undefined;
      match?: Record<string, string> | undefined;
    },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registration = await this.registrations.setWebhook(context, {
      registrationId: args.registrationId,
      source: args.source,
      events: args.events,
      target: args.target,
      description: args.description,
      match: args.match,
    });
    return formatRegistrationSummary(registration);
  }

  private async handleDisableRegistrationTool(
    args: { registrationId: string },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registration = await this.registrations.disableRegistration(context, args.registrationId);
    return `Disabled registration ${registration.id}.`;
  }

  private async handleListRegistrationsTool(ctx: DynamicToolHandlerContext): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registrations = this.registrations.listRegistrations(context);
    if (registrations.length === 0) {
      return "No registrations in the current worker/workstream scope.";
    }
    return registrations.map((registration) => formatRegistrationLine(registration)).join("\n");
  }

  private async handleGetRegistrationTool(
    args: { registrationId: string },
    ctx: DynamicToolHandlerContext,
  ): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const registration = this.registrations.getRegistration(context, args.registrationId);
    return JSON.stringify(registration, null, 2);
  }

  private async handleListPendingWakesTool(ctx: DynamicToolHandlerContext): Promise<string> {
    const context = this.requireRegistrationContext(ctx);
    const wakes = this.registrations.listPendingWakes(context);
    if (wakes.length === 0) {
      return "No pending wakes in the current worker/workstream scope.";
    }
    return wakes.map((wake) => `${wake.id} ${wake.status} ${wake.summary}`).join("\n");
  }

  private requireRegistrationContext(ctx: DynamicToolHandlerContext): RegistrationContext {
    const workerRecord = this.store.getWorkerByAppThreadId(ctx.threadId);
    const worker = workerRecord ? this.ensureWorkerWorkstream(workerRecord) : null;
    if (!worker?.workstreamId) {
      throw new Error("Registration tools require a worker thread with an attached workstream.");
    }
    const workstream = this.store.getWorkstreamById(worker.workstreamId);
    if (!workstream) {
      throw new Error("No workstream is attached to this Slack worker.");
    }
    return {
      teamId: worker.teamId,
      workstream,
      worker,
    };
  }

  private scheduleRegistrationLoop(delayMs = REGISTRATION_POLL_INTERVAL_MS): void {
    if (this.stopping) return;
    if (this.registrationPollTimer) {
      clearTimeout(this.registrationPollTimer);
    }
    this.registrationPollTimer = setTimeout(() => {
      void this.processRegistrationLoop();
    }, Math.max(0, delayMs));
  }

  private async processRegistrationLoop(): Promise<void> {
    if (this.processingRegistrationLoop) return this.currentRegistrationLoopPromise ?? Promise.resolve();
    this.processingRegistrationLoop = true;
    this.currentRegistrationLoopPromise = (async () => {
      try {
        if (this.stopping) return;
        if (this.store.getPendingRestart() && this.isRuntimeIdle()) {
          await this.maybeExecuteQueuedRestart();
          return;
        }
        await this.enqueueDueRegistrationWakes();
        if (this.store.getPendingRestart() && this.isRuntimeIdle()) {
          await this.maybeExecuteQueuedRestart();
          return;
        }
        await this.deliverQueuedWakes();
      } finally {
        this.processingRegistrationLoop = false;
        this.currentRegistrationLoopPromise = null;
        if (!this.stopping) {
          this.scheduleRegistrationLoop();
        }
      }
    })();
    return this.currentRegistrationLoopPromise;
  }

  private async enqueueDueRegistrationWakes(): Promise<void> {
    const registrations = this.store.listRegistrationsForTeam(this.slack.getTeamId() ?? this.config.allowedTeamId ?? "single-workspace");
    const now = Date.now();
    for (const registration of registrations) {
      if (!registration.enabled) continue;
      const latestWake = this.store.getLatestPendingWakeForRegistration(registration.id);
      if (latestWake?.status === "queued") continue;
      if (isPermanentInvalidConfigWake(latestWake, registration.updatedAt)) continue;
      let dueAt: string | null;
      try {
        dueAt = this.resolveRegistrationDueAt(registration, latestWake ?? null, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.createPendingWake({
          id: `wake-${randomUUID().slice(0, 8)}`,
          teamId: registration.teamId,
          registrationId: registration.id,
          workstreamId: registration.workstreamId,
          workerKey: registration.workerKey,
          status: "quarantined",
          summary: `[config error] ${message}`,
          payloadPath: null,
          dueAt: null,
          attempts: 0,
          nextAttemptAt: null,
          lastError: message,
        });
        await this.registrations.disableRegistrationById(registration.id);
        continue;
      }
      if (!dueAt) continue;
      this.store.createPendingWake({
        id: `wake-${randomUUID().slice(0, 8)}`,
        teamId: registration.teamId,
        registrationId: registration.id,
        workstreamId: registration.workstreamId,
        workerKey: registration.workerKey,
        status: "queued",
        summary: `${registration.trigger.kind} fired for ${registration.id}`,
        payloadPath: null,
        dueAt: dueAt,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      });
    }
  }

  private async deliverQueuedWakes(): Promise<void> {
    const wakes = this.store.listQueuedPendingWakes();
    for (const wake of wakes) {
      if (this.stopping) return;
      if (this.store.getPendingRestart()) {
        await this.maybeExecuteQueuedRestart();
        return;
      }
      const registration = this.store.getRegistration(wake.registrationId);
      if (!registration || !registration.enabled) {
        this.store.updatePendingWake(wake.id, {
          status: "quarantined",
          summary: `${wake.summary} (registration unavailable)`,
          lastError: "registration unavailable",
        });
        continue;
      }
      if (registration.action.kind === "wake_self" && registration.workerKey) {
        let worker = this.store.getWorkerByKey(registration.workerKey);
        if (!worker) {
          await this.quarantineWakeAndDisableRegistration(wake.id, registration.id, `${wake.summary} (worker missing)`, "worker missing");
          continue;
        }
        if (this.startingWorkerTurns.has(worker.key) || worker.pendingRequest || worker.activeTurnId || worker.status === "running") {
          continue;
        }
        worker = await this.prepareWorkerForSend(worker);
        if (this.stopping || worker.pendingRequest || worker.activeTurnId || worker.status === "running" || isManuallyBlockedStatus(worker.status)) {
          continue;
        }
        try {
          await this.startWorkerTurn(worker, buildWakeTurnInput(registration, wake));
          this.store.updatePendingWake(wake.id, {
            status: "delivered",
            summary: `${wake.summary} (delivered)`,
            nextAttemptAt: null,
            lastError: null,
          });
        } catch (error) {
          await this.recordTransientWakeFailure(registration.id, wake, `wake_self failure: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (registration.action.kind === "spawn") {
        const workstream = this.store.getWorkstreamById(registration.target.workstreamId);
        if (!workstream) {
          await this.quarantineWakeAndDisableRegistration(wake.id, registration.id, `${wake.summary} (workstream missing)`, "workstream missing");
          continue;
        }
        try {
          if (this.stopping) return;
          await this.spawnWorkerIntoWorkstream({
            workstream,
            channelId: workstream.channelId,
            title: buildScheduledSpawnTitle(registration),
            itemBody: buildWakeTurnInput(registration, wake).text,
            turnInput: buildWakeTurnInput(registration, wake),
            rootOwnerUserId: registration.rootOwnerUserId,
            ownerUserId: registration.ownerUserId,
            runtimeSettings: { model: null, effort: null },
            source: {
              sourceKind: `${registration.trigger.kind}-registration`,
              sourceSummary: wake.summary,
              toAddress: formatWorkstreamAddress(workstream),
            },
            identity: null,
            parentWorkerKey: null,
            shellId: wake.id,
            surfaceFailuresInThread: true,
          });
          this.store.updatePendingWake(wake.id, {
            status: "delivered",
            summary: `${wake.summary} (spawned)`,
            nextAttemptAt: null,
            lastError: null,
          });
        } catch (error) {
          await this.recordTransientWakeFailure(registration.id, wake, `spawn failure: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      await this.quarantineWakeAndDisableRegistration(wake.id, registration.id, `${wake.summary} (invalid action)`, "invalid action");
    }
  }

  private resolveRegistrationDueAt(registration: RegistrationRecord, latestWake: { status: string; updatedAt: string } | null, nowMs: number): string | null {
    const baselineIso = latestWake?.status === "queued" ? null : latestWake?.updatedAt ?? null;
    const baseline = baselineIso ? new Date(baselineIso) : new Date(registration.createdAt);
    if (Number.isNaN(baseline.getTime())) return null;

    if (registration.trigger.kind === "heartbeat") {
      const dueAtMs = baseline.getTime() + registration.trigger.intervalMinutes * 60_000;
      if (dueAtMs > nowMs) return null;
      return new Date(dueAtMs).toISOString();
    }

    if (registration.trigger.kind === "cron") {
      const latest = findLatestMatchingCronMinute(
        registration.trigger.schedule,
        registration.trigger.timezone || this.config.workspaceTimezone,
        baseline,
        new Date(nowMs),
      );
      return latest ? latest.toISOString() : null;
    }

    return null;
  }

  private async recordTransientWakeFailure(registrationId: string, wake: { id: string; attempts: number; summary: string }, detail: string): Promise<void> {
    const nextAttempts = wake.attempts + 1;
    if (nextAttempts >= WAKE_RETRY_MAX_ATTEMPTS) {
      this.store.updatePendingWake(wake.id, {
        status: "quarantined",
        attempts: nextAttempts,
        nextAttemptAt: null,
        lastError: detail,
        summary: `${stripWakeStatusSuffix(wake.summary)} (quarantined after ${nextAttempts} attempts: ${detail})`,
      });
      await this.registrations.disableRegistrationById(registrationId);
      return;
    }

    const backoffMs = nextAttempts * REGISTRATION_POLL_INTERVAL_MS;
    this.store.updatePendingWake(wake.id, {
      status: "queued",
      attempts: nextAttempts,
      nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
      lastError: detail,
      summary: `${stripWakeStatusSuffix(wake.summary)} (retry ${nextAttempts}/${WAKE_RETRY_MAX_ATTEMPTS}: ${detail})`,
    });
  }

  private async quarantineWakeAndDisableRegistration(
    wakeId: string,
    registrationId: string,
    summary: string,
    lastError: string,
  ): Promise<void> {
    this.store.updatePendingWake(wakeId, {
      status: "quarantined",
      summary,
      lastError,
      nextAttemptAt: null,
    });
    await this.registrations.disableRegistrationById(registrationId);
  }

  private async createWorkstreamFromThreadArgs(worker: WorkerRecord, args: string[]): Promise<string> {
    const parsed = parseWorkstreamCreateArgs(args);
    if (!parsed) {
      return "Usage: /workstream-create <slug> [parent=<path>] [description...]";
    }
    const currentWorkstream = worker.workstreamId ? this.store.getWorkstreamById(worker.workstreamId) : null;
    return this.createWorkstreamForContext({
      teamId: worker.teamId,
      defaultParentRelativePath: currentWorkstream?.relativePath ?? null,
      slug: parsed.slug,
      parentRelativePath: parsed.parentRelativePath,
      description: parsed.description,
      initiatedFrom: `worker:${worker.key}`,
    });
  }

  private async createWorkstreamFromDmArgs(session: DmSessionRecord, args: string[]): Promise<string> {
    const parsed = parseWorkstreamCreateArgs(args);
    if (!parsed) {
      return "Usage: /workstream-create <slug> [parent=<path>] [description...]";
    }
    return this.createWorkstreamForContext({
      teamId: session.teamId,
      defaultParentRelativePath: null,
      slug: parsed.slug,
      parentRelativePath: parsed.parentRelativePath,
      description: parsed.description,
      initiatedFrom: `dm:${session.userId}`,
      excludeAdminChannelId: session.channelId,
    });
  }

  private async createWorkstreamForContext(input: {
    teamId: string;
    defaultParentRelativePath: string | null;
    slug: string;
    parentRelativePath?: string | null;
    description?: string | null;
    initiatedFrom: string;
    excludeAdminChannelId?: string | null;
  }): Promise<string> {
    const existingChannel = await this.slack.findPublicChannelByName(input.teamId, input.slug);
    if (existingChannel) {
      return `Slack channel #${existingChannel.name} already exists. Workstream creation refuses to auto-link existing channels in this version.`;
    }
    try {
      const workstream = await this.workstreams.createWorkstream(
        input.teamId,
        {
          slug: input.slug,
          parentRelativePath: input.parentRelativePath ?? input.defaultParentRelativePath,
          description: input.description ?? null,
        },
        async () => this.slack.createPublicChannel(input.teamId, input.slug),
      );
      const message = [
        `Created workstream ${formatWorkstreamAddress(workstream)}.`,
        `channel: #${workstream.channelName}`,
        `path: ${workstream.relativePath || "."}`,
      ].join("\n");
      await this.notifyAdminControlSurface(
        input.teamId,
        `${message}\ninitiated_from: ${input.initiatedFrom}`,
        input.excludeAdminChannelId ?? null,
      );
      return message;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = rawMessage.includes("was created and preserved")
        ? rawMessage
        : `Workstream creation failed: ${rawMessage}`;
      await this.notifyAdminControlSurface(
        input.teamId,
        `${message}\ninitiated_from: ${input.initiatedFrom}`,
        input.excludeAdminChannelId ?? null,
      );
      return message;
    }
  }

  private async notifyAdminControlSurface(teamId: string, message: string, excludeChannelId: string | null = null): Promise<void> {
    const sessions = this.store.listDmSessions().filter((session) => (
      session.teamId === teamId
      && this.config.adminUserIds.includes(session.userId)
      && session.channelId !== excludeChannelId
    ));
    for (const session of sessions) {
      await this.enqueueSlackWrite(this.getDmQueueKey(session.teamId, session.userId), async () => {
        await this.slack.postTopLevelMessage(session.channelId, renderSystemMessage(message));
      });
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
    this.clearBlockedTurnPoll(this.getWorkerPollKey(worker.key));
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
    this.clearBlockedTurnPoll(this.getDmPollKey(session.teamId, session.userId));
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

  private async canRecoverWorkerNow(worker: WorkerRecord): Promise<boolean> {
    const state = await this.codex.reconcileThreadForSend(worker.appThreadId);
    return state === "missing" || (state === "running" && !worker.activeTurnId);
  }

  private async canRecoverDmNow(session: DmSessionRecord): Promise<boolean> {
    if (!session.appThreadId) return false;
    const state = await this.codex.reconcileThreadForSend(session.appThreadId);
    return state === "missing" || (state === "running" && !session.activeTurnId);
  }

  private async clearWorkerStaleActiveTurn(worker: WorkerRecord, reason: string): Promise<WorkerRecord> {
    this.clearBlockedTurnPoll(this.getWorkerPollKey(worker.key));
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
    this.clearBlockedTurnPoll(this.getWorkerPollKey(worker.key));
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

  private async markWorkerBlockedRunningTurn(worker: WorkerRecord, reason: string): Promise<WorkerRecord> {
    if (worker.status === "blocked_running_turn" && worker.lastError === reason) {
      this.scheduleWorkerBlockedTurnPoll(worker.key);
      return worker;
    }
    this.store.updateWorkerState(worker.key, {
      status: "blocked_running_turn",
      lastError: reason,
      pendingRequest: null,
    });
    const updated = this.requireWorker(worker.key);
    await this.postWorkerSystemMessage(updated, reason);
    this.scheduleWorkerBlockedTurnPoll(updated.key);
    return updated;
  }

  private async clearWorkerBlockedRunningTurn(worker: WorkerRecord, reason: string): Promise<WorkerRecord> {
    this.clearBlockedTurnPoll(this.getWorkerPollKey(worker.key));
    this.store.updateWorkerState(worker.key, {
      status: "idle",
      lastError: null,
    });
    const updated = this.requireWorker(worker.key);
    await this.postWorkerSystemMessage(updated, reason);
    return updated;
  }

  private async clearDmStaleActiveTurn(session: DmSessionRecord, reason: string): Promise<DmSessionRecord> {
    this.clearBlockedTurnPoll(this.getDmPollKey(session.teamId, session.userId));
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
    this.clearBlockedTurnPoll(this.getDmPollKey(session.teamId, session.userId));
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

  private async markDmBlockedRunningTurn(session: DmSessionRecord, reason: string): Promise<DmSessionRecord> {
    if (session.status === "blocked_running_turn" && session.lastError === reason) {
      this.scheduleDmBlockedTurnPoll(session.teamId, session.userId);
      return session;
    }
    this.store.upsertDmSession({
      ...session,
      status: "blocked_running_turn",
      lastError: reason,
      pendingRequest: null,
    });
    const updated = this.requireDmSession(session.teamId, session.userId);
    await this.postDmSystemMessage(updated, reason);
    this.scheduleDmBlockedTurnPoll(updated.teamId, updated.userId);
    return updated;
  }

  private async clearDmBlockedRunningTurn(session: DmSessionRecord, reason: string): Promise<DmSessionRecord> {
    this.clearBlockedTurnPoll(this.getDmPollKey(session.teamId, session.userId));
    this.store.upsertDmSession({
      ...session,
      status: "idle",
      lastError: null,
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

  private getDmSessionKey(teamId: string, userId: string): string {
    return this.getDmQueueKey(teamId, userId);
  }

  private getDmEditKey(teamId: string, userId: string, slackTs: string): string {
    return `${this.getDmQueueKey(teamId, userId)}:${slackTs}`;
  }

  private getWorkerPollKey(workerKey: string): string {
    return `worker:${workerKey}`;
  }

  private getDmPollKey(teamId: string, userId: string): string {
    return `dm:${teamId}:${userId}`;
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

  private scheduleWorkerBlockedTurnPoll(workerKey: string): void {
    const pollKey = this.getWorkerPollKey(workerKey);
    if (this.blockedTurnPolls.has(pollKey)) return;
    this.blockedTurnDeadlines.set(pollKey, Date.now() + BLOCKED_RUNNING_TURN_POLL_WINDOW_MS);
    this.queueWorkerBlockedTurnPoll(workerKey);
  }

  private queueWorkerBlockedTurnPoll(workerKey: string): void {
    const pollKey = this.getWorkerPollKey(workerKey);
    const timer = setTimeout(() => {
      void this.runWorkerBlockedTurnPoll(workerKey);
    }, BLOCKED_RUNNING_TURN_POLL_INTERVAL_MS);
    this.blockedTurnPolls.set(pollKey, timer);
  }

  private async runWorkerBlockedTurnPoll(workerKey: string): Promise<void> {
    const pollKey = this.getWorkerPollKey(workerKey);
    this.blockedTurnPolls.delete(pollKey);
    const worker = this.store.getWorkerByKey(workerKey);
    if (!worker || worker.status !== "blocked_running_turn") {
      this.clearBlockedTurnPoll(pollKey);
      return;
    }
    const deadline = this.blockedTurnDeadlines.get(pollKey) ?? 0;
    const state = await this.codex.reconcileThreadForSend(worker.appThreadId);
    if (state === "idle") {
      this.clearBlockedTurnPoll(pollKey);
      this.store.updateWorkerState(worker.key, {
        status: "idle",
        lastError: null,
      });
      await this.postWorkerSystemMessage(this.requireWorker(worker.key), "The previous Codex turn finished. This thread is ready for new messages.");
      return;
    }
    if (state === "missing" || Date.now() >= deadline) {
      await this.markWorkerRecoveryRequired(
        worker,
        state === "missing"
          ? "Backing Codex thread is missing. Run /recover to attach a fresh Codex thread to this Slack conversation."
          : "The previous Codex turn did not settle in time. Run /recover to attach a fresh Codex thread to this Slack conversation.",
      );
      return;
    }
    this.queueWorkerBlockedTurnPoll(workerKey);
  }

  private scheduleDmBlockedTurnPoll(teamId: string, userId: string): void {
    const pollKey = this.getDmPollKey(teamId, userId);
    if (this.blockedTurnPolls.has(pollKey)) return;
    this.blockedTurnDeadlines.set(pollKey, Date.now() + BLOCKED_RUNNING_TURN_POLL_WINDOW_MS);
    this.queueDmBlockedTurnPoll(teamId, userId);
  }

  private queueDmBlockedTurnPoll(teamId: string, userId: string): void {
    const pollKey = this.getDmPollKey(teamId, userId);
    const timer = setTimeout(() => {
      void this.runDmBlockedTurnPoll(teamId, userId);
    }, BLOCKED_RUNNING_TURN_POLL_INTERVAL_MS);
    this.blockedTurnPolls.set(pollKey, timer);
  }

  private async runDmBlockedTurnPoll(teamId: string, userId: string): Promise<void> {
    const pollKey = this.getDmPollKey(teamId, userId);
    this.blockedTurnPolls.delete(pollKey);
    const session = this.store.getDmSession(teamId, userId);
    if (!session || session.status !== "blocked_running_turn" || !session.appThreadId) {
      this.clearBlockedTurnPoll(pollKey);
      return;
    }
    const deadline = this.blockedTurnDeadlines.get(pollKey) ?? 0;
    const state = await this.codex.reconcileThreadForSend(session.appThreadId);
    if (state === "idle") {
      this.clearBlockedTurnPoll(pollKey);
      this.store.upsertDmSession({
        ...session,
        status: "idle",
        lastError: null,
      });
      await this.postDmSystemMessage(this.requireDmSession(teamId, userId), "The previous Codex turn finished. This DM is ready for new messages.");
      return;
    }
    if (state === "missing" || Date.now() >= deadline) {
      await this.markDmRecoveryRequired(
        session,
        state === "missing"
          ? "Backing Codex thread is missing. Run /recover to create a fresh admin Codex thread."
          : "The previous Codex turn did not settle in time. Run /recover to create a fresh admin Codex thread.",
      );
      return;
    }
    this.queueDmBlockedTurnPoll(teamId, userId);
  }

  private clearBlockedTurnPoll(pollKey: string): void {
    const timer = this.blockedTurnPolls.get(pollKey);
    if (timer) {
      clearTimeout(timer);
    }
    this.blockedTurnPolls.delete(pollKey);
    this.blockedTurnDeadlines.delete(pollKey);
  }

  private requireWorker(workerKey: string): WorkerRecord {
    const worker = this.store.getWorkerByKey(workerKey);
    if (!worker) throw new Error(`Missing worker ${workerKey}`);
    return worker;
  }

  private ensureWorkerWorkstream(worker: WorkerRecord): WorkerRecord {
    if (worker.workstreamId) return worker;
    const workstream = this.store.getWorkstreamByChannel(worker.teamId, worker.channelId);
    if (!workstream) return worker;
    this.store.updateWorkerState(worker.key, { workstreamId: workstream.id });
    return this.requireWorker(worker.key);
  }

  private ensureWorkerIdentity(worker: WorkerRecord): WorkerRecord {
    if (worker.identity) return worker;
    return this.store.upsertWorker({
      ...worker,
      identity: assignWorkerIdentity(this.store.listWorkers()),
    });
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

function formatUploadResult(files: SlackUploadedFile[]): string {
  if (files.length === 0) {
    return "Upload completed, but Slack returned no file metadata.";
  }
  const summary = files
    .map((file) => file.title ?? file.name)
    .join(", ");
  return `Uploaded ${files.length} file${files.length === 1 ? "" : "s"} to Slack: ${summary}`;
}

function isSlackMessageNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { message?: unknown; data?: { error?: unknown } };
  return maybeError.data?.error === "message_not_found"
    || (typeof maybeError.message === "string" && maybeError.message.includes("message_not_found"));
}

function isManuallyBlockedStatus(status: SessionStatus): boolean {
  return status === "recovery_required" || status === "blocked_running_turn";
}

function isUnavailableForCompact(status: SessionStatus): boolean {
  return status === "recovery_required" || status === "blocked_running_turn";
}

function normalizeTurnStatus(status: string): SessionStatus {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
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

function isPermanentInvalidConfigWake(
  wake: { status: string; summary: string; updatedAt: string } | null,
  registrationUpdatedAt: string,
): boolean {
  if (!wake || wake.status !== "quarantined") return false;
  if (!wake.summary.startsWith("[config error]")) return false;
  return wake.updatedAt >= registrationUpdatedAt;
}

function stripWakeStatusSuffix(summary: string): string {
  const marker = " (";
  const index = summary.indexOf(marker);
  if (index < 0) return summary;
  return summary.slice(0, index);
}

function formatRegistrationSummary(registration: RegistrationRecord): string {
  return [
    `Saved registration ${registration.id}.`,
    formatRegistrationLine(registration),
  ].join("\n");
}

function formatRegistrationLine(registration: RegistrationRecord): string {
  const target = registration.target.kind === "worker" ? "worker:self" : "workstream:self";
  return `${registration.id} [${registration.enabled ? "enabled" : "disabled"}] ${registration.trigger.kind} -> ${registration.action.kind} (${target})`;
}

function buildWakeTurnInput(registration: RegistrationRecord, wake: { id: string; createdAt: string; dueAt: string | null; summary: string }): TurnInput {
  const details: string[] = [
    "[system wake event]",
    `registration_id: ${registration.id}`,
    `wake_id: ${wake.id}`,
    `trigger: ${registration.trigger.kind}`,
    `action: ${registration.action.kind}`,
    `target: ${registration.target.kind}${registration.target.workerKey ? `:${registration.target.workerKey}` : `:${registration.target.workstreamId}`}`,
    `fired_at: ${wake.createdAt}`,
  ];
  if (registration.trigger.kind === "heartbeat") {
    details.push(`interval_minutes: ${registration.trigger.intervalMinutes}`);
  }
  if (registration.trigger.kind === "cron") {
    details.push(`schedule: ${registration.trigger.schedule}`);
    details.push(`timezone: ${registration.trigger.timezone}`);
  }
  if (registration.trigger.kind === "webhook") {
    details.push(`source: ${registration.trigger.source}`);
    details.push(`events: ${registration.trigger.events.join(",")}`);
    if (registration.trigger.match) {
      details.push(`match: ${JSON.stringify(registration.trigger.match)}`);
    }
  }
  if (wake.dueAt) {
    details.push(`due_at: ${wake.dueAt}`);
  }
  if (registration.description) {
    details.push(`description: ${registration.description}`);
  }
  details.push(`summary: ${wake.summary}`);
  return {
    text: details.join("\n"),
    imagePaths: [],
  };
}

function buildScheduledSpawnTitle(registration: RegistrationRecord): string {
  if (registration.description?.trim()) {
    return `Scheduled work: ${registration.description.trim()}`;
  }
  return `Scheduled work (${registration.trigger.kind})`;
}

function describeEffectiveSetting(threadValue: string | null, defaultValue: string | null): string {
  if (threadValue) return `${threadValue} (thread override)`;
  if (defaultValue) return `${defaultValue} (global default)`;
  return "(using default: unset)";
}

function parseWorkstreamCreateArgs(args: string[]): { slug: string; parentRelativePath: string | null; description: string | null } | null {
  const [slug, ...rest] = args;
  if (!slug) return null;
  let parentRelativePath: string | null = null;
  const descriptionParts: string[] = [];
  for (const token of rest) {
    if (token.startsWith("parent=")) {
      parentRelativePath = token.slice("parent=".length).trim() || null;
      continue;
    }
    descriptionParts.push(token);
  }
  return {
    slug,
    parentRelativePath,
    description: descriptionParts.length > 0 ? descriptionParts.join(" ") : null,
  };
}

function resolveRuntimeSettings(
  threadSettings: RuntimeSettings,
  defaults: RuntimeSettings,
): RuntimeSettings {
  return {
    model: threadSettings.model ?? defaults.model,
    effort: threadSettings.effort ?? defaults.effort,
  };
}
