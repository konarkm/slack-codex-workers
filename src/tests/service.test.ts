import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { SlackCodexWorkersService } from "../core/service.js";
import type { SlackMessageContext, WorkerRecord } from "../types.js";

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
    attachmentMaxBytes: 25 * 1024 * 1024,
    attachmentTotalMaxBytes: 50 * 1024 * 1024,
    attachmentDownloadTimeoutMs: 30_000,
    attachmentRetentionMs: null,
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
    parentWorkerKey: null,
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
});
