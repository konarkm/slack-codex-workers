import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { SlackCodexWorkersService } from "../core/service.js";
import type { DmSessionRecord, SlackMessageContext, WorkerRecord } from "../types.js";

const tempDirs: string[] = [];

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
    codexCwd: dir,
    databasePath: path.join(dir, "test.db"),
    adminUserIds: ["U-admin"],
    allowedTeamId: null,
    messageEditThrottleMs: 1,
    appPort: 3013,
    supervisorRestartEnabled: false,
    attachmentStorageDir: path.join(dir, "attachments"),
    attachmentMaxBytes: 1024 * 1024 * 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 600_000,
    attachmentRetentionMs: null,
    slackUploadTimeoutMs: 600_000,
    slackUploadMaxFiles: 10,
  };
}

async function createService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-service-"));
  tempDirs.push(dir);
  const service = new SlackCodexWorkersService(makeConfig(dir)) as any;
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
  };
  const codex = {
    reconcileThreadForSend: vi.fn(),
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
  return { dir, service, slack, codex, store: service.store };
}

function createWorker(service: any, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return service.store.upsertWorker({
    key: "T1:C1:1.000",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1.000",
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("service lifecycle decisions", () => {
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
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
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
    expect(response).toContain("Recover is only available");
    expect(slack.postTopLevelMessage).not.toHaveBeenCalled();
    store.close();
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

    const response = await service.handleDmCommand(service.store.getDmSession("T1", "U-admin"), "stop", []);
    await service.onDmCompleted("T1", "U-admin", "", "interrupted");

    expect(response).toBe("_System_: Interrupt requested.");
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
