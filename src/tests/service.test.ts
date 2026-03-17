import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { SlackCodexWorkersService } from "../core/service.js";
import { WorkstreamManager } from "../workstreams/manager.js";
import type { DmSessionRecord, SlackMessageContext, WorkerRecord } from "../types.js";

vi.mock("@slack/bolt", () => ({
  App: class {
    public client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "B1", team_id: "T1" }) },
      users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: "mock-user" } } }) },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.000" }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ files: [] }),
      },
      conversations: {
        join: vi.fn().mockResolvedValue({ ok: true }),
        create: vi.fn().mockResolvedValue({ channel: { id: "C-created", name: "created", is_private: false, is_member: true } }),
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
      },
    };

    public start = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
  },
}));

const tempDirs: string[] = [];
const activeServices: any[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConfig(dir: string): AppConfig {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "unused",
    codexBin: "codex",
    workspaceRoot: dir,
    databasePath: path.join(dir, "test.db"),
    adminUserIds: ["U-admin"],
    allowedTeamId: null,
    messageEditThrottleMs: 1,
    appPort: 3013,
    supervisorRestartEnabled: false,
    launchMode: "dev",
    attachmentStorageDir: path.join(dir, "attachments"),
    attachmentMaxBytes: 1024 * 1024 * 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 600_000,
    attachmentRetentionMs: null,
    slackUploadTimeoutMs: 600_000,
    slackUploadMaxFiles: 10,
    workspaceTimezone: "America/Los_Angeles",
    webhookPort: 3014,
    webhookPath: "/webhooks",
    webhookBodyMaxBytes: 256 * 1024,
    webhookPayloadStorageDir: path.join(dir, "webhooks"),
    webhookSourceSecrets: { github: "secret-github", stripe: "secret-stripe" },
  };
}

async function createService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-service-"));
  tempDirs.push(dir);
  const service = new SlackCodexWorkersService(makeConfig(dir)) as any;
  activeServices.push(service);
  const slack = {
    postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
    postTopLevelMessage: vi.fn().mockResolvedValue("root-ts"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addRootReaction: vi.fn().mockResolvedValue(undefined),
    setStatusReaction: vi.fn().mockResolvedValue(undefined),
    uploadFilesToConversation: vi.fn().mockResolvedValue([{ id: "F1", name: "artifact.txt", title: "Artifact", permalink: null }]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    app: { event: vi.fn() },
    getTeamId: vi.fn().mockReturnValue("T1"),
    getUserDisplayName: vi.fn().mockResolvedValue("alice"),
    extractFiles: vi.fn().mockReturnValue([]),
    resolveChannel: vi.fn(),
    findPublicChannelByName: vi.fn().mockResolvedValue(null),
    createPublicChannel: vi.fn().mockImplementation(async (_teamId: string, name: string) => ({
      teamId: "T1",
      channelId: `C-${name}`,
      name,
      isPrivate: false,
      isMember: true,
      updatedAt: new Date().toISOString(),
    })),
    ensurePublicChannel: vi.fn().mockImplementation(async (_teamId: string, name: string) => ({
      teamId: "T1",
      channelId: name === "general" ? "C1" : `C-${name}`,
      name,
      isPrivate: false,
      isMember: true,
      updatedAt: new Date().toISOString(),
    })),
  };
  const codex = {
    isRunning: vi.fn().mockReturnValue(true),
    reconcileThreadForSend: vi.fn(),
    readThreadStatus: vi.fn(),
    startTurnWithResumeFallback: vi.fn(),
    createWorkerThread: vi.fn(),
    createAdminThread: vi.fn(),
    compactThread: vi.fn(),
    forkWorkerThread: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    steerTurn: vi.fn().mockResolvedValue(undefined),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    respondToServerRequest: vi.fn().mockResolvedValue(undefined),
  };
  service.slack = slack;
  service.codex = codex;
  const store = service.store;
  store.upsertWorkstream({
    id: "T1:root",
    teamId: "T1",
    parentId: null,
    slug: "root",
    relativePath: "",
    channelId: "C1",
    channelName: "general",
    description: "root",
  });
  return { dir, service, slack, codex, store };
}

function createWorker(service: any, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return service.store.upsertWorker({
    key: "T1:C1:1.000",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1.000",
    workstreamId: null,
    appThreadId: "thread-1",
    activeTurnId: null,
    ownerUserId: "U1",
    rootOwnerUserId: "U1",
    status: "idle",
    currentAgentSlackTs: null,
    currentAgentItemId: null,
    currentWorklogSlackTs: null,
    settings: { model: "gpt-5.4", effort: "high" },
    identity: { username: "Gear", iconEmoji: "gear" },
    parentWorkerKey: null,
    requestItemId: null,
    requestItemPath: null,
    lastError: null,
    lastInboundMessageTs: null,
    pendingRequest: null,
    ...overrides,
  });
}

function createDmSession(service: any, overrides: Partial<DmSessionRecord> = {}): DmSessionRecord {
  return service.store.upsertDmSession({
    teamId: "T1",
    userId: "U-admin",
    channelId: "D1",
    appThreadId: "dm-thread-1",
    activeTurnId: null,
    status: "idle",
    currentAgentSlackTs: null,
    currentAgentItemId: null,
    currentWorklogSlackTs: null,
    settings: { model: "gpt-5.4", effort: "high" },
    lastError: null,
    lastInboundMessageTs: null,
    pendingRequest: null,
    ...overrides,
  });
}

afterEach(async () => {
  while (activeServices.length > 0) {
    const service = activeServices.pop();
    if (!service) continue;
    service.stopping = true;
    service.runtimeStarted = false;
    if (service?.registrationPollTimer) {
      clearTimeout(service.registrationPollTimer);
      service.registrationPollTimer = null;
    }
    await service.currentRegistrationLoopPromise?.catch(() => undefined);
    try {
      service.store.close();
    } catch {
      // Some tests close the store directly as part of their assertions.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("service lifecycle decisions", () => {
  it("cleans up partially started dependencies when startup fails", async () => {
    const { service, slack, codex } = await createService();
    const webhooks = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    service.webhooks = webhooks;
    service.bootstrapWorkstreams = vi.fn().mockRejectedValue(new Error("bootstrap failed"));

    await expect(service.start()).rejects.toThrow("bootstrap failed");

    expect(codex.start).toHaveBeenCalled();
    expect(slack.start).toHaveBeenCalled();
    expect(webhooks.start).toHaveBeenCalled();
    expect(webhooks.stop).toHaveBeenCalled();
    expect(slack.stop).toHaveBeenCalled();
    expect(codex.stop).toHaveBeenCalled();
  });

  it("rejects replayed blocked inbound messages without retrying them", async () => {
    const { service, slack, codex, store } = await createService();
    createWorker(service, {
      status: "blocked_running_turn",
      lastError: "A previous Codex turn is still running after restart. Wait for it to finish or use /recover to abandon it.",
    });
    codex.reconcileThreadForSend.mockResolvedValue("running");

    const context: SlackMessageContext = {
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      userId: "U1",
      username: "alice",
      text: "follow up",
      ts: "2.000",
      threadTs: "1.000",
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-1",
      teamId: "T1",
      channelId: "C1",
      messageTs: "2.000",
      rootTs: "1.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-1");

    const record = store.getInboundMessage("msg-1");
    expect(record?.status).toBe("failed");
    expect(record?.retryable).toBe(false);
    expect(record?.lastError).toContain("Codex turn");
    expect(slack.postThreadReply).toHaveBeenCalled();
  });

  it("keeps normal worker turn startup out of blocked_running_turn", async () => {
    const { service, codex, store } = await createService();
    const worker = createWorker(service);
    const pendingTurn = deferred<string>();
    codex.startTurnWithResumeFallback.mockReturnValue(pendingTurn.promise);

    const turnPromise = service.startWorkerTurn(worker, { text: "hello", imagePaths: [] });
    const duringStart = store.getWorkerByKey(worker.key);
    expect(duringStart?.status).toBe("idle");
    expect(duringStart?.activeTurnId).toBeNull();

    pendingTurn.resolve("turn-1");
    await expect(turnPromise).resolves.toBe("turn-1");

    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.status).toBe("running");
    expect(updated?.activeTurnId).toBe("turn-1");
  });

  it("allows recover when live reconciliation shows the backing thread is missing", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service);
    codex.reconcileThreadForSend.mockResolvedValue("missing");
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });

    await service.handleThreadCommand(worker, "recover", []);

    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.appThreadId).toBe("thread-2");
    expect(updated?.status).toBe("idle");
    expect(slack.postThreadReply).toHaveBeenCalled();
  });

  it("refuses recover when blocked state is stale but the backing thread is healthy", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "blocked_running_turn",
      lastError: "Wait for it to settle or use /recover.",
    });
    codex.reconcileThreadForSend.mockResolvedValue("idle");

    await service.handleThreadCommand(worker, "recover", []);

    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.appThreadId).toBe("thread-1");
    expect(codex.createWorkerThread).not.toHaveBeenCalled();
    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C1",
      "1.000",
      expect.stringContaining("Recover is only available"),
    );
  });

  it("refuses DM recover when blocked state is stale but the backing thread is healthy", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      status: "blocked_running_turn",
      lastError: "Wait for it to settle or use /recover.",
    });
    codex.reconcileThreadForSend.mockResolvedValue("idle");

    const response = await service.handleDmCommand(session, "recover", []);

    const updated = store.getDmSession("T1", "U-admin");
    expect(updated?.appThreadId).toBe("dm-thread-1");
    expect(codex.createAdminThread).not.toHaveBeenCalled();
    expect(response.response).toContain("Recover is only available");
    expect(slack.postTopLevelMessage).not.toHaveBeenCalled();
  });

  it("creates the Slack child anchor before the backing worker thread", async () => {
    const { service, slack, codex, store } = await createService();
    createWorker(service);
    codex.createWorkerThread.mockRejectedValue(new Error("boom"));

    const result = await service.handleSpawnWorkerTool(
      { title: "Child task", initialUserMessage: "Do the thing", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(slack.postTopLevelMessage.mock.invocationCallOrder[0]).toBeLessThan(codex.createWorkerThread.mock.invocationCallOrder[0]);
    expect(result).toContain("failed to create the backing worker");
    expect(store.listWorkers().length).toBe(1);
    store.close();
  });

  it("quarantines stale replay rows when Slack says the message no longer exists", async () => {
    const { service, slack, codex, store } = await createService();
    codex.createWorkerThread.mockRejectedValue(new Error("boom"));
    slack.setStatusReaction.mockRejectedValueOnce({
      message: "An API error occurred: message_not_found",
      data: { error: "message_not_found" },
    });

    const context: SlackMessageContext = {
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      userId: "U1",
      username: "alice",
      text: "hello",
      ts: "5.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-stale",
      teamId: "T1",
      channelId: "C1",
      messageTs: "5.000",
      rootTs: "5.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await expect(service.processInboundMessage("msg-stale")).resolves.toBeUndefined();

    const record = store.getInboundMessage("msg-stale");
    expect(record?.status).toBe("failed");
    expect(record?.retryable).toBe(false);
    expect(record?.lastError).toContain("Slack message no longer exists for retry");
    expect(slack.postThreadReply).not.toHaveBeenCalled();
    store.close();
  });

  it("requests worker interruption and posts requested plus confirmed system messages", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.handleThreadCommand(worker, "stop", []);
    await service.onWorkerCompleted(worker.key, "", "interrupted");

    expect(codex.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "_System_: Interrupt requested."],
      ["C1", "1.000", "_System_: Turn interrupted."],
    ]);
    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.status).toBe("interrupted");
    expect(updated?.lastError).toBeNull();
    store.close();
  });

  it("updates only the root reaction as a thread reply progresses", async () => {
    const { service, slack } = await createService();
    const worker = createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
      lastInboundMessageTs: "2.000",
    });

    await service.onWorkerTurnStarted(worker.key);
    await service.onWorkerCompleted(worker.key, "Done.", "completed");

    expect(slack.setStatusReaction.mock.calls).toEqual([
      ["C1", "1.000", "hourglass_flowing_sand"],
      ["C1", "1.000", "white_check_mark"],
    ]);
  });

  it("adds the worker identity reaction before the seen status on a new root message", async () => {
    const { service, slack, codex, store } = await createService();
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });

    const context: SlackMessageContext = {
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      userId: "U1",
      username: "alice",
      text: "hello",
      ts: "5.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-root",
      teamId: "T1",
      channelId: "C1",
      messageTs: "5.000",
      rootTs: "5.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-2");

    await service.processInboundMessage("msg-root");

    expect(slack.addRootReaction).toHaveBeenCalledWith("C1", "5.000", expect.any(String));
    expect(slack.setStatusReaction).toHaveBeenCalledWith("C1", "5.000", "eyes");
    expect(slack.addRootReaction.mock.invocationCallOrder[0]).toBeLessThan(slack.setStatusReaction.mock.invocationCallOrder[0]);
    store.close();
  });

  it("requests DM interruption and posts requested plus confirmed system messages", async () => {
    const { service, slack, codex, store } = await createService();
    createDmSession(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    const result = await service.handleDmCommand(service.store.getDmSession("T1", "U-admin"), "stop", []);
    await service.onDmCompleted("T1", "U-admin", "", "interrupted");

    expect(result.response).toBe("_System_: Interrupt requested.");
    expect(codex.interruptTurn).toHaveBeenCalledWith("dm-thread-1", "turn-1");
    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Turn interrupted."],
    ]);
    const updated = store.getDmSession("T1", "U-admin");
    expect(updated?.status).toBe("interrupted");
    expect(updated?.lastError).toBeNull();
    store.close();
  });

  it("flushes pending assistant text before confirming interruption", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.onWorkerAgentMessage("T1:C1:1.000", "agent-1", "Checking the repo now.");
    await service.onWorkerCompleted("T1:C1:1.000", "", "interrupted");

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Checking the repo now.", { username: "Gear", iconEmoji: "gear" }],
      ["C1", "1.000", "_System_: Turn interrupted."],
    ]);
    const updated = store.getWorkerByKey("T1:C1:1.000");
    expect(updated?.status).toBe("interrupted");
    store.close();
  });

  it("posts completed work events and final assistant messages as separate worker replies in order", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.onWorkerAgentMessage("T1:C1:1.000", "agent-1", "Checking weather now.");
    await service.onWorkerWorklogItem("T1:C1:1.000", {
      itemId: "tool-1",
      type: "webSearch",
      title: "Web Search",
      status: "completed",
      detail: "weather: San Francisco, CA",
    });
    await service.onWorkerAgentMessage("T1:C1:1.000", "agent-2", "San Francisco is 58 F and clear.");
    await service.onWorkerCompleted("T1:C1:1.000", "San Francisco is 58 F and clear.", "completed");

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Checking weather now.", { username: "Gear", iconEmoji: "gear" }],
      ["C1", "1.000", ":white_check_mark: Web Search", { username: "Gear", iconEmoji: "gear" }],
      ["C1", "1.000", "<@U1> San Francisco is 58 F and clear.", { username: "Gear", iconEmoji: "gear" }],
    ]);
    expect(slack.updateMessage).not.toHaveBeenCalled();
    const updated = store.getWorkerByKey("T1:C1:1.000");
    expect(updated?.currentAgentSlackTs).toBeNull();
    store.close();
  });

  it("backfills a worker identity before posting worker-authored messages", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      identity: null,
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.onWorkerAgentMessage("T1:C1:1.000", "agent-1", "Checking weather now.");
    await service.onWorkerCompleted("T1:C1:1.000", "Checking weather now.", "completed");

    const updated = store.getWorkerByKey("T1:C1:1.000");
    expect(updated?.identity).not.toBeNull();
    expect(slack.postThreadReply).toHaveBeenLastCalledWith(
      "C1",
      "1.000",
      "<@U1> Checking weather now.",
      expect.objectContaining({ username: expect.any(String), iconEmoji: expect.any(String) }),
    );
    store.close();
  });

  it("uploads files into the current worker thread", async () => {
    const { dir, service, slack, store } = await createService();
    createWorker(service);
    const artifactPath = path.join(dir, "artifact.txt");
    await fs.writeFile(artifactPath, "hello");
    const realArtifactPath = await fs.realpath(artifactPath);

    const result = await service.handleUploadFilesTool(
      { files: [{ path: "artifact.txt", title: "Artifact" }], comment: "Here it is" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(slack.uploadFilesToConversation).toHaveBeenCalledWith(
      "C1",
      "1.000",
      [expect.objectContaining({ path: realArtifactPath, filename: "artifact.txt", title: "Artifact" })],
      "Here it is",
    );
    expect(result).toContain("Uploaded 1 file");
    store.close();
  });

  it("reports thread status and health with thread-specific details", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "blocked_running_turn",
      lastError: "waiting on prior turn",
      lastInboundMessageTs: "9.000",
    });
    store.setTeamDefaults("T1", { model: "gpt-5.5", effort: "medium" });
    store.setPendingRestart({
      target: "both",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });
    codex.readThreadStatus.mockResolvedValue("idle");

    await service.handleThreadCommand(worker, "status", []);
    await service.handleThreadCommand(worker, "health", []);

    expect(slack.postThreadReply.mock.calls[0]?.[2]).toContain("effective_model: gpt-5.4 (thread override)");
    expect(slack.postThreadReply.mock.calls[0]?.[2]).toContain("global_default_model: gpt-5.5");
    expect(slack.postThreadReply.mock.calls[1]?.[2]).toContain("database_path:");
    expect(slack.postThreadReply.mock.calls[1]?.[2]).toContain("codex_thread_state: idle");
    store.close();
  });

  it("queues restart requests instead of executing them immediately", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service);

    const result = await service.handleDmCommand(session, "restart", ["codex"]);

    expect(result.response).toContain("Queued restart: codex");
    expect(codex.restart).not.toHaveBeenCalled();
    expect(store.getPendingRestart()).toMatchObject({ target: "codex", teamId: "T1" });
    store.close();
  });

  it("forces queued codex restarts after the acknowledgement is sent", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service);
    store.setPendingRestart({
      target: "codex",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });

    const result = await service.handleDmCommand(session, "restart-now", []);
    await result.afterSend?.();

    expect(codex.restart).toHaveBeenCalled();
    expect(store.getPendingRestart()).toBeNull();
    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Restarting Codex now."],
      ["D1", "_System_: Codex restarted. Back online."],
    ]);
    store.close();
  });

  it("executes queued restart once active work reaches zero", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
    });
    store.setPendingRestart({
      target: "codex",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });

    await service.onWorkerCompleted("T1:C1:1.000", "Done.", "completed");

    expect(codex.restart).toHaveBeenCalled();
    expect(store.getPendingRestart()).toBeNull();
    store.close();
  });

  it("posts the pending relaunch notice on startup", async () => {
    const { service, slack, store } = await createService();
    store.setPendingRestartNotice({
      target: "bridge",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });

    await service.postPendingRestartNotice();

    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", "_System_: Bridge restarted. Back online.");
    expect(store.consumePendingRestartNotice()).toBeNull();
    store.close();
  });

  it("uploads files into the current admin DM conversation", async () => {
    const { dir, service, slack, store } = await createService();
    createDmSession(service);
    const artifactPath = path.join(dir, "report.json");
    await fs.writeFile(artifactPath, "{}");
    const realArtifactPath = await fs.realpath(artifactPath);

    const result = await service.handleUploadFilesTool(
      { files: [{ path: "./report.json" }] },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(slack.uploadFilesToConversation).toHaveBeenCalledWith(
      "D1",
      null,
      [expect.objectContaining({ path: realArtifactPath, filename: "report.json" })],
      undefined,
    );
    expect(result).toContain("Uploaded 1 file");
    store.close();
  });

  it("creates a workstream from the admin DM command", async () => {
    const { dir, service, slack, store } = await createService();
    const session = createDmSession(service);

    const result = await service.handleDmCommand(session, "workstream-create", ["ops", "parent=root", "Handles", "ops"]);

    expect(result.response).toContain("Created workstream ops");
    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "ops");
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toMatchObject({
      relativePath: "ops",
      channelName: "ops",
    });
    await expect(fs.readFile(path.join(dir, "ops", "WORKSTREAM.md"), "utf8")).resolves.toContain("Slack surface: #ops");
    await expect(fs.readFile(path.join(dir, "ops", "AGENTS.md"), "utf8")).resolves.toContain("WORKSTREAM.md");
    await expect(fs.readFile(path.join(dir, "ops", ".slack-workers", "registrations.json"), "utf8")).resolves.toContain("[]");
    store.close();
  });

  it("creates a workstream from a worker thread command using the current workstream as the default parent", async () => {
    const { service, slack, store } = await createService();
    const worker = createWorker(service, { workstreamId: "T1:root" });

    await service.handleThreadCommand(worker, "workstream-create", ["ops"]);

    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "ops");
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toBeTruthy();
    expect(slack.postThreadReply).toHaveBeenCalledWith("C1", "1.000", expect.stringContaining("Created workstream ops."));
    store.close();
  });

  it("creates a workstream from the worker bridge tool", async () => {
    const { service, slack, store } = await createService();
    createDmSession(service);
    createWorker(service, { workstreamId: "T1:root" });

    const result = await service.handleCreateWorkstreamTool(
      { slug: "research", description: "Deep investigations" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(result).toContain("Created workstream research.");
    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "research");
    expect(store.getWorkstreamByRelativePath("T1", "research")).toMatchObject({ relativePath: "research" });
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Created workstream research."));
    store.close();
  });

  it("creates a heartbeat registration and updates the local projection", async () => {
    const { dir, service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });

    const result = await service.handleSetHeartbeatTool(
      { intervalMinutes: 15, description: "Check for follow-ups" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(result).toContain("Saved registration");
    expect(store.listRegistrationsForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "registrations.json"), "utf8")).resolves.toContain('"kind": "heartbeat"');
    store.close();
  });

  it("lists and disables registrations in the current worker scope", async () => {
    const { service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    store.upsertRegistration({
      id: "reg-1",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Check for replies",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "heartbeat",
        intervalMinutes: 30,
      },
    });

    const listed = await service.handleListRegistrationsTool({ threadId: "thread-1", turnId: "turn-1", callId: "call-1" });
    expect(listed).toContain("reg-1");

    const detail = await service.handleGetRegistrationTool(
      { registrationId: "reg-1" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(detail).toContain('"id": "reg-1"');

    const disabled = await service.handleDisableRegistrationTool(
      { registrationId: "reg-1" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(disabled).toContain("Disabled registration reg-1");
    expect(store.getRegistration("reg-1")).toMatchObject({ enabled: false });
    store.close();
  });

  it("queues and delivers heartbeat wakes into an idle worker", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-heartbeat");

    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Check for follow-ups",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    const wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "delivered" });
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("[system wake event]"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    const worker = store.getWorkerByKey("T1:C1:1.000");
    expect(worker).toMatchObject({ activeTurnId: "turn-heartbeat", status: "running" });
    store.close();
  });

  it("leaves heartbeat wakes queued while the worker is running and delivers them once idle", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, {
      workstreamId: "T1:root",
      activeTurnId: "turn-1",
      status: "running",
    });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-heartbeat");

    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    expect(codex.startTurnWithResumeFallback).not.toHaveBeenCalled();
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({ status: "queued" });

    store.updateWorkerState("T1:C1:1.000", {
      activeTurnId: null,
      status: "idle",
    });
    codex.reconcileThreadForSend.mockResolvedValue("idle");

    await service.deliverQueuedWakes();

    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledTimes(1);
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({ status: "delivered" });
    store.close();
  });

  it("queues and delivers cron wakes into an idle worker", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-cron");

    store.upsertRegistration({
      id: "reg-cron",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Hourly check",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "cron", schedule: "* * * * *", timezone: "America/Los_Angeles" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({ status: "delivered" });
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("trigger: cron"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    store.close();
  });

  it("spawns new work for workstream-target cron registrations", async () => {
    const { service, codex, store, slack } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-spawn");

    store.upsertRegistration({
      id: "reg-cron-spawn",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Daily digest",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: { kind: "cron", schedule: "* * * * *", timezone: "America/Los_Angeles" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "C1",
      expect.stringContaining("Scheduled work: Daily digest"),
      expect.anything(),
    );
    expect(store.listWorkers()).toHaveLength(2);
    expect(store.listPendingWakesForScope("T1", "T1:root", null)[0]).toMatchObject({ status: "delivered" });
    store.close();
  });

  it("fans out matched webhook events into queued self wakes with durable payload pointers", async () => {
    const { dir, service, codex, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-webhook");

    store.upsertRegistration({
      id: "reg-webhook",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Review GitHub pushes",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "github",
        events: ["push"],
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.ingestWebhookEvent({
      source: "github",
      event: "push",
      dedupeKey: "evt-1",
      match: { repo: "acme/api" },
      payload: { ref: "refs/heads/main", commits: 3 },
      receivedAt: "2026-01-01T00:01:00.000Z",
      rawBody: "{\"event\":\"push\"}",
    });

    expect(result).toMatchObject({ duplicate: false, matchedRegistrations: 1 });
    expect(service.scheduleRegistrationLoop).toHaveBeenCalledWith(0);
    await service.deliverQueuedWakes();

    const wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "delivered", firedEvent: "push" });
    expect(wakes[0]?.payloadPath).toContain(path.join(dir, "webhooks", "github"));
    await expect(fs.readFile(wakes[0]!.payloadPath!, "utf8")).resolves.toContain("\"source\": \"github\"");
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("payload_path: "),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("fired_event: push"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    store.close();
  });

  it("dedupes webhook ingress before creating additional wakes", async () => {
    const { service, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });

    store.upsertRegistration({
      id: "reg-webhook",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "github",
        events: ["push"],
        match: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const first = await service.ingestWebhookEvent({
      source: "github",
      event: "push",
      dedupeKey: "evt-1",
      match: null,
      payload: { seq: 1 },
      receivedAt: "2026-01-01T00:01:00.000Z",
      rawBody: "{\"event\":\"push\",\"id\":\"evt-1\"}",
    });
    const second = await service.ingestWebhookEvent({
      source: "github",
      event: "push",
      dedupeKey: "evt-1",
      match: null,
      payload: { seq: 2 },
      receivedAt: "2026-01-01T00:02:00.000Z",
      rawBody: "{\"event\":\"push\",\"id\":\"evt-1\"}",
    });

    expect(first).toMatchObject({ duplicate: false, matchedRegistrations: 1 });
    expect(second).toMatchObject({ duplicate: true, matchedRegistrations: 0 });
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
    store.close();
  });

  it("does not fan out webhook wakes when source, event, or match fields do not align", async () => {
    const { service, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    store.upsertRegistration({
      id: "reg-webhook",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "github",
        events: ["push"],
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(service.ingestWebhookEvent({
      source: "stripe",
      event: "push",
      dedupeKey: "evt-a",
      match: { repo: "acme/api" },
      payload: {},
      receivedAt: "2026-01-01T00:01:00.000Z",
      rawBody: "{}",
    })).resolves.toMatchObject({ duplicate: false, matchedRegistrations: 0 });
    await expect(service.ingestWebhookEvent({
      source: "github",
      event: "pull_request",
      dedupeKey: "evt-b",
      match: { repo: "acme/api" },
      payload: {},
      receivedAt: "2026-01-01T00:02:00.000Z",
      rawBody: "{}",
    })).resolves.toMatchObject({ duplicate: false, matchedRegistrations: 0 });
    await expect(service.ingestWebhookEvent({
      source: "github",
      event: "push",
      dedupeKey: "evt-c",
      match: { repo: "other/repo" },
      payload: {},
      receivedAt: "2026-01-01T00:03:00.000Z",
      rawBody: "{}",
    })).resolves.toMatchObject({ duplicate: false, matchedRegistrations: 0 });

    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(0);
    expect(store.listWorkers()).toHaveLength(1);
    store.close();
  });

  it("spawns new work for matched webhook registrations targeting the workstream", async () => {
    const { service, codex, store, slack } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-webhook-spawn" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-webhook-spawn");

    store.upsertRegistration({
      id: "reg-webhook-spawn",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Triage incoming incidents",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["invoice.failed"],
        match: { account: "acct_123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.ingestWebhookEvent({
      source: "stripe",
      event: "invoice.failed",
      dedupeKey: "evt-stripe-1",
      match: { account: "acct_123" },
      payload: { invoiceId: "in_123" },
      receivedAt: "2026-01-01T00:03:00.000Z",
      rawBody: "{\"event\":\"invoice.failed\"}",
    });

    expect(result).toMatchObject({ duplicate: false, matchedRegistrations: 1 });
    expect(service.scheduleRegistrationLoop).toHaveBeenCalledWith(0);
    await service.deliverQueuedWakes();

    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "C1",
      expect.stringContaining("Scheduled work: Triage incoming incidents"),
      expect.anything(),
    );
    expect(store.listWorkers()).toHaveLength(2);
    expect(store.listPendingWakesForScope("T1", "T1:root", null)[0]).toMatchObject({ status: "delivered" });
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-webhook-spawn",
      expect.objectContaining({
        text: expect.stringContaining("fired_event: invoice.failed"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    store.close();
  });

  it("does not disable webhook registrations after bounded transient wake retries", async () => {
    const { service, codex, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockRejectedValue(new Error("temporary outage"));

    store.upsertRegistration({
      id: "reg-webhook",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "github",
        events: ["push"],
        match: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent({
      source: "github",
      event: "push",
      dedupeKey: "evt-1",
      match: null,
      payload: {},
      receivedAt: "2026-01-01T00:01:00.000Z",
      rawBody: "{}",
    });

    await service.deliverQueuedWakes();
    const wakeId = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]!.id;
    store.updatePendingWake(wakeId, { nextAttemptAt: null });
    await service.deliverQueuedWakes();
    store.updatePendingWake(wakeId, { nextAttemptAt: null });
    await service.deliverQueuedWakes();

    expect(store.getRegistration("reg-webhook")).toMatchObject({ enabled: true });
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({
      status: "quarantined",
      lastError: expect.stringContaining("temporary outage"),
    });
    store.close();
  });

  it("rejects webhook registrations whose source cannot be routed by ingress", async () => {
    const { service } = await createService();
    await service.bootstrapWorkstreams();
    const workstream = service.store.getWorkstreamById("T1:root");
    expect(workstream).not.toBeNull();
    const worker = createWorker(service, { workstreamId: "T1:root" });

    await expect(service.registrations.setWebhook(
      {
        teamId: "T1",
        workstream: workstream!,
        worker,
      },
      {
        source: "bad/source",
        events: ["push"],
        target: "self",
      },
    )).rejects.toThrow("Webhook source must match");
  });

  it("accepts webhook HTTP ingress through the running service and requests wake scheduling", async () => {
    const { service, store } = await createService();
    await service.start();
    const scheduleSpy = vi.spyOn(service, "scheduleRegistrationLoop");
    scheduleSpy.mockClear();
    createWorker(service, { workstreamId: "T1:root" });
    store.upsertRegistration({
      id: "reg-webhook-http",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Handle webhook over HTTP",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "github",
        events: ["push"],
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const port = service.webhooks.getListeningPort();
    expect(port).not.toBeNull();
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({
        event: "push",
        id: "evt-http-1",
        match: { repo: "acme/api" },
        payload: { commits: 1 },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      matchedRegistrations: 1,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(0);
    expect(store.getWebhookEvent("T1", "github", "push", "evt-http-1")).not.toBeNull();
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
  });

  it("coalesces missed heartbeat runs instead of draining backlog", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-heartbeat");

    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Catch up once",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();
    store.updateWorkerState("T1:C1:1.000", { activeTurnId: null, status: "idle" });
    await service.enqueueDueRegistrationWakes();

    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
    store.close();
  });

  it("isolates invalid cron registrations without poisoning the queue", async () => {
    const { service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });

    store.upsertRegistration({
      id: "reg-bad-cron",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "cron", schedule: "bad cron", timezone: "America/Los_Angeles" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.enqueueDueRegistrationWakes();

    const wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes.filter((wake: any) => wake.summary.startsWith("[config error]"))).toHaveLength(1);
    expect(wakes.some((wake: any) => wake.status === "queued")).toBe(true);
    store.close();
  });

  it("prioritizes queued restarts over scheduled wake delivery at idle", async () => {
    const { service, codex, store } = await createService();
    createDmSession(service);
    createWorker(service, { workstreamId: "T1:root" });
    store.setPendingRestart({
      target: "codex",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });
    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.processRegistrationLoop();

    expect(codex.restart).toHaveBeenCalledTimes(1);
    expect(codex.startTurnWithResumeFallback).not.toHaveBeenCalled();
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(0);
    store.close();
  });

  it("retries transient wake_self delivery failures without dropping the wake", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback
      .mockRejectedValueOnce(new Error("temporary start failure"))
      .mockResolvedValueOnce("turn-heartbeat");

    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    let wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    expect(wakes[0]?.summary).toContain("retry 1/3");

    store.updatePendingWake(wakes[0]!.id, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
    await service.deliverQueuedWakes();

    wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes[0]).toMatchObject({ status: "delivered" });
    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("quarantines a wake after repeated transient failures", async () => {
    const { service, codex, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockRejectedValue(new Error("still broken"));

    store.upsertRegistration({
      id: "reg-heartbeat",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wake = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]!;
      if (wake.nextAttemptAt) {
        store.updatePendingWake(wake.id, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
      }
      await service.deliverQueuedWakes();
    }

    const wake = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]!;
    expect(wake).toMatchObject({ status: "quarantined", attempts: 3 });
    expect(wake.summary).toContain("quarantined");
    expect(store.getRegistration("reg-heartbeat")).toMatchObject({ enabled: false });
    store.close();
  });

  it("retries scheduled spawn on the same public shell after a transient failure", async () => {
    const { service, codex, store, slack } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });
    codex.startTurnWithResumeFallback
      .mockRejectedValueOnce(new Error("turn start failed"))
      .mockResolvedValueOnce("turn-spawn");

    store.upsertRegistration({
      id: "reg-cron-spawn",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Daily digest",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: { kind: "cron", schedule: "* * * * *", timezone: "America/Los_Angeles" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    let wakes = store.listPendingWakesForScope("T1", "T1:root", null);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    expect(slack.postTopLevelMessage).toHaveBeenCalledTimes(1);

    store.updatePendingWake(wakes[0]!.id, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
    await service.deliverQueuedWakes();

    wakes = store.listPendingWakesForScope("T1", "T1:root", null);
    expect(wakes[0]).toMatchObject({ status: "delivered" });
    expect(slack.postTopLevelMessage).toHaveBeenCalledTimes(1);
    expect(codex.createWorkerThread).toHaveBeenCalledTimes(1);
    expect(store.listWorkers()).toHaveLength(2);
    store.close();
  });

  it("quarantines invalid persisted registration actions instead of spawning", async () => {
    const { service, store, slack } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    store.upsertRegistration({
      id: "reg-invalid",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Bad config",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: { kind: "cron", schedule: "* * * * *", timezone: "America/Los_Angeles" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    (store as any).db.prepare("UPDATE registrations SET action_json = ? WHERE id = ?").run("{bad json", "reg-invalid");

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();

    const wake = store.listPendingWakesForScope("T1", "T1:root", null)[0]!;
    expect(wake).toMatchObject({ status: "quarantined" });
    expect(wake.summary).toContain("invalid action");
    expect(slack.postTopLevelMessage).not.toHaveBeenCalled();
    expect(store.getRegistration("reg-invalid")).toMatchObject({ enabled: false });
    store.close();
  });

  it("disables terminally broken registrations after worker-missing quarantine", async () => {
    const { service, store } = await createService();
    store.upsertRegistration({
      id: "reg-missing-worker",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:missing",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:missing",
      },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.enqueueDueRegistrationWakes();
    await service.deliverQueuedWakes();
    await service.enqueueDueRegistrationWakes();

    const wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:missing");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "quarantined" });
    expect(store.getRegistration("reg-missing-worker")).toMatchObject({ enabled: false });
    store.close();
  });

  it("writes request and response items for a root workstream worker", async () => {
    const { dir, service, codex, store } = await createService();
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-2");

    const context: SlackMessageContext = {
      teamId: "T1",
      channelId: "C1",
      channelType: "channel",
      userId: "U1",
      username: "alice",
      text: "Investigate the failing deploy",
      ts: "7.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-workstream",
      teamId: "T1",
      channelId: "C1",
      messageTs: "7.000",
      rootTs: "7.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-workstream");

    const worker = store.getWorker("T1", "C1", "7.000");
    expect(worker?.requestItemPath).toBeTruthy();
    const requestItem = await fs.readFile(worker!.requestItemPath!, "utf8");
    expect(requestItem).toContain('"kind": "request"');
    expect(requestItem).toContain(worker!.key);

    await service.onWorkerCompleted(worker!.key, "Deploy issue is fixed.", "completed");

    const itemFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    expect(itemFiles.some((file) => file.startsWith("res-"))).toBe(true);
    const responseFile = itemFiles.find((file) => file.startsWith("res-"))!;
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFile), "utf8")).resolves.toContain('"kind": "response"');
    store.close();
  });

  it("bootstraps the root workstream and root local protocol files", async () => {
    const { dir, service, slack, store } = await createService();
    store.close();
    await fs.rm(path.join(dir, "test.db"), { force: true });
    service.store = new (service.store.constructor as any)(path.join(dir, "test.db"));
    service.workstreams = new WorkstreamManager(makeConfig(dir), service.store);

    await service.bootstrapWorkstreams();

    expect(slack.ensurePublicChannel).toHaveBeenCalledWith("T1", "general");
    await expect(fs.access(path.join(dir, "WORKSTREAM.md"))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).resolves.toContain("WORKSTREAM.md");
    await expect(fs.readFile(path.join(dir, ".slack-workers", "registrations.json"), "utf8")).resolves.toContain("[]");
    await expect(fs.access(path.join(dir, ".slack-workers", "bridge"))).resolves.toBeUndefined();
  });

  it("ignores started work events and posts DM assistant messages without edits", async () => {
    const { service, slack, store } = await createService();
    createDmSession(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.onDmWorklogItem("T1", "U-admin", {
      itemId: "tool-1",
      type: "webSearch",
      title: "Web Search",
      status: "started",
      detail: "weather: San Francisco, CA",
    });
    await service.onDmAgentMessage("T1", "U-admin", "agent-1", "Checking weather now.");
    await service.onDmCompleted("T1", "U-admin", "Checking weather now.", "completed");

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "Checking weather now."],
    ]);
    expect(slack.updateMessage).not.toHaveBeenCalled();
    const updated = store.getDmSession("T1", "U-admin");
    expect(updated?.currentAgentSlackTs).toBeNull();
    store.close();
  });
});
