import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { SlackCodexWorkersService } from "../core/service.js";
import { WorkstreamManager } from "../workstreams/manager.js";
import type { DmSessionRecord, SlackMessageContext, WebhookSourceRecord, WorkerRecord } from "../types.js";

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
        archive: vi.fn().mockResolvedValue({ ok: true }),
        open: vi.fn().mockResolvedValue({ channel: { id: "D-opened" } }),
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
      },
    };

    public start = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
  },
}));

const tempDirs: string[] = [];
const activeServices: any[] = [];
let nextWebhookPort = 38000;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
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
    showSlackWorklog: false,
    workspaceTimezone: "America/Los_Angeles",
    webhookPort: nextWebhookPort++,
    webhookBindHost: "127.0.0.1",
    webhookPath: "/webhooks",
    webhookBodyMaxBytes: 256 * 1024,
    webhookBodyReadTimeoutMs: 30_000,
    webhookPayloadStorageDir: path.join(dir, "webhooks"),
    webhookPublicBaseUrl: "https://hooks.example.test",
    webhookTrustLoopbackProxy: false,
    ...overrides,
  };
}

async function createService(configOverrides: Partial<AppConfig> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-service-"));
  tempDirs.push(dir);
  const service = new SlackCodexWorkersService(makeConfig(dir, configOverrides)) as any;
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
    getMessagePermalink: vi.fn().mockResolvedValue("https://app.slack.com/archives/C1/p1000"),
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
    openDmChannel: vi.fn().mockResolvedValue("D-opened"),
    archivePublicChannel: vi.fn().mockResolvedValue(undefined),
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
    archivedAt: null,
  });
  return { dir, service, slack, codex, store };
}

async function createWebhookSource(
  service: any,
  overrides: Partial<WebhookSourceRecord> = {},
  handlerBody?: string,
): Promise<WebhookSourceRecord> {
  const sourceName = overrides.source ?? "github";
  const routeToken = overrides.routeToken ?? `route-${sourceName}`;
  const handlerPath = overrides.handlerPath ?? path.join(service.config.workspaceRoot, `${sourceName}-handler.mjs`);
  await fs.mkdir(path.dirname(handlerPath), { recursive: true });
  await fs.writeFile(handlerPath, handlerBody ?? `
export async function normalizeWebhook(ctx) {
  const body = ctx.parsedJson && typeof ctx.parsedJson === "object" ? ctx.parsedJson : {};
  if (body && body.reject === true) {
    return { outcome: "reject", error: "signature_invalid", status: 401 };
  }
  if (body && body.noop === true) {
    return { outcome: "noop", reason: "ignored" };
  }
  const events = Array.isArray(body.events) ? body.events : [{
    event: typeof body.event === "string" ? body.event : "unknown",
    dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : (typeof body.id === "string" ? body.id : "evt-default"),
    fields: body.fields ?? body.match ?? null,
    payload: Object.hasOwn(body, "payload") ? body.payload : body,
    summary: typeof body.summary === "string" ? body.summary : null,
  }];
  return { outcome: "events", events };
}
`);
  return service.store.createWebhookSource({
    id: overrides.id ?? `src-${sourceName}-${routeToken}`,
    teamId: "T1",
    source: sourceName,
    routeToken,
    handlerPath,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeRawWebhookIngress(source: WebhookSourceRecord, overrides: Record<string, unknown> = {}) {
  return {
    source,
    routePath: `/webhooks/${source.routeToken}`,
    method: "POST",
    url: `https://hooks.example.test/webhooks/${source.routeToken}`,
    headers: { "content-type": "application/json" },
    rawBody: "{}",
    parsedJson: {},
    receivedAt: "2026-01-01T00:01:00.000Z",
    remoteAddress: "127.0.0.1",
    ...overrides,
  };
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
    terminalResponseItemId: null,
    turnNotificationTurnId: null,
    turnNotificationEnabled: false,
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
  it("suppresses worker worklog Slack posts by default", async () => {
    const { service, slack } = await createService();
    createWorker(service);

    await (service as any).onWorkerWorklogItem("T1:C1:1.000", {
      itemId: "item-1",
      type: "commandExecution",
      title: "Run command: echo hi",
      status: "completed",
    });

    expect(slack.postThreadReply).not.toHaveBeenCalled();
  });

  it("posts worker worklog Slack updates when enabled", async () => {
    const { service, slack } = await createService({ showSlackWorklog: true });
    createWorker(service);

    await (service as any).onWorkerWorklogItem("T1:C1:1.000", {
      itemId: "item-1",
      type: "commandExecution",
      title: "Run command: echo hi",
      status: "completed",
    });

    expect(slack.postThreadReply).toHaveBeenCalledWith("C1", "1.000", ":white_check_mark: Run command: echo hi", { username: "Gear", iconEmoji: "gear" });
  });

  it("suppresses DM worklog Slack posts by default", async () => {
    const { service, slack } = await createService();
    createDmSession(service);

    await (service as any).onDmWorklogItem("T1", "U-admin", "dm-thread-1", {
      itemId: "item-1",
      type: "commandExecution",
      title: "Run command: echo hi",
      status: "completed",
    });

    expect(slack.postTopLevelMessage).not.toHaveBeenCalled();
  });

  it("posts DM worklog Slack updates when enabled", async () => {
    const { service, slack } = await createService({ showSlackWorklog: true });
    createDmSession(service);

    await (service as any).onDmWorklogItem("T1", "U-admin", "dm-thread-1", {
      itemId: "item-1",
      type: "commandExecution",
      title: "Run command: echo hi",
      status: "completed",
    });

    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", ":white_check_mark: Run command: echo hi");
  });

  it("ignores non-user message subtypes like channel_join", async () => {
    const { service, store } = await createService();

    await (service as any).handleMessageEvent({
      type: "message",
      subtype: "channel_join",
      user: "U1",
      channel: "C1",
      channel_type: "channel",
      ts: "2.000",
      text: "<@U1> has joined the channel",
    });

    expect(store.getInboundMessage("T1:C1:2.000:channel-root")).toBeNull();
    expect(store.listWorkers()).toHaveLength(0);
  });

  it("accepts file_share messages as inbound user content", async () => {
    const { service, store, slack, codex } = await createService();
    (slack.extractFiles as any).mockReturnValue([
      {
        id: "F1",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.test/image.png",
      },
    ]);
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-2" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-2");

    await (service as any).handleMessageEvent({
      type: "message",
      subtype: "file_share",
      user: "U1",
      channel: "C1",
      channel_type: "channel",
      ts: "3.000",
      text: "",
      files: [{ id: "F1" }],
    });

    expect(store.getInboundMessage("T1:C1:3.000:channel-root")?.status).toBe("processed");
    expect(store.listWorkers()).toHaveLength(1);
  });

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

  it("does not crash startup reconciliation when Slack cannot reply to a worker root message", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      key: "T1:C1:join-root",
      rootTs: "2.000",
      activeTurnId: "turn-stale",
      status: "running",
    });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    slack.postThreadReply.mockRejectedValueOnce(new Error("cannot_reply_to_message"));

    await expect((service as any).reconcileWorkerOnStartup(worker)).resolves.toBeUndefined();

    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.status).toBe("idle");
    expect(updated?.activeTurnId).toBeNull();
    expect(updated?.lastError).toContain("Recovered stale active turn after runtime startup.");
  });

  it("survives full startup when persisted worker reconciliation hits cannot_reply_to_message", async () => {
    const { service, slack, codex, store } = await createService();
    createWorker(service, {
      key: "T1:C1:join-root",
      rootTs: "2.000",
      activeTurnId: "turn-stale",
      status: "running",
    });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    slack.postThreadReply.mockRejectedValueOnce(new Error("cannot_reply_to_message"));

    await expect(service.start()).resolves.toBeUndefined();

    const updated = store.getWorkerByKey("T1:C1:join-root");
    expect(updated?.status).toBe("idle");
    expect(updated?.activeTurnId).toBeNull();
    expect(updated?.lastError).toContain("Recovered stale active turn after runtime startup.");
    expect(service.runtimeStarted).toBe(true);
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

  it("spawns into the current workstream when workstream is omitted", async () => {
    const { service, slack, codex, store } = await createService();
    store.upsertWorkstream({
      id: "T1:customers/ef",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ef",
      relativePath: "customers/ef",
      channelId: "C-ef",
      channelName: "ef",
      description: null,
      archivedAt: null,
    });
    store.upsertWorker({
      key: "T1:C-ef:2.000",
      teamId: "T1",
      channelId: "C-ef",
      rootTs: "2.000",
      workstreamId: "T1:customers/ef",
      appThreadId: "thread-parent-ef",
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
      terminalResponseItemId: null,
      turnNotificationTurnId: null,
      turnNotificationEnabled: false,
      lastError: null,
      lastInboundMessageTs: null,
      pendingRequest: null,
    });
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-child-current" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-child-current");

    const result = await service.handleSpawnWorkerTool(
      { title: "Follow up", initialUserMessage: "Do it here", mode: "fresh" },
      { threadId: "thread-parent-ef", turnId: "turn-1", callId: "call-current" },
    );

    expect(result).toContain("workstream customers/ef");
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "C-ef",
      "Follow up\n\nDo it here",
      expect.objectContaining({ username: expect.any(String) }),
    );
    expect(store.getWorkerByAppThreadId("thread-child-current")).toMatchObject({
      channelId: "C-ef",
      workstreamId: "T1:customers/ef",
    });
    store.close();
  });

  it("lists active workstreams for the current worker team", async () => {
    const { service, store } = await createService();
    createWorker(service);
    store.upsertWorkstream({
      id: "T1:customers/ef",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ef",
      relativePath: "customers/ef",
      channelId: "C-ef",
      channelName: "ef",
      description: null,
      archivedAt: null,
    });

    await expect(service.handleListWorkstreamsTool(
      "ef",
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    )).resolves.toBe("customers/ef (#ef, C-ef)");
    store.close();
  });

  it("spawns a child worker into an explicitly targeted workstream path", async () => {
    const { service, codex, store } = await createService();
    createWorker(service);
    store.upsertWorkstream({
      id: "T1:customers/ef",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ef",
      relativePath: "customers/ef",
      channelId: "C-ef",
      channelName: "ef",
      description: null,
      archivedAt: null,
    });
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-child" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-child");

    const result = await service.handleSpawnWorkerTool(
      { workstream: "customers/ef", title: "Child task", initialUserMessage: "Do the thing", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );

    expect(result).toContain("workstream customers/ef");
    expect(store.getWorkerByAppThreadId("thread-child")).toMatchObject({
      channelId: "C-ef",
      workstreamId: "T1:customers/ef",
    });
    store.close();
  });

  it("treats root aliases as the root workstream when spawning a child worker", async () => {
    const { service, codex, store } = await createService();
    createWorker(service);
    codex.createWorkerThread.mockResolvedValue({ threadId: "thread-child-root" });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-child-root");

    const result = await service.handleSpawnWorkerTool(
      { workstream: "/root", title: "Root child", initialUserMessage: "Stay in root", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-root" },
    );

    expect(result).toContain("workstream root");
    expect(store.getWorkerByAppThreadId("thread-child-root")).toMatchObject({
      channelId: "C1",
      workstreamId: "T1:root",
    });
    store.close();
  });

  it("treats bare root and dot aliases as the root workstream when spawning a child worker", async () => {
    const { service, slack, codex, store } = await createService();
    createWorker(service);
    slack.postTopLevelMessage
      .mockResolvedValueOnce("3.000")
      .mockResolvedValueOnce("4.000");
    codex.createWorkerThread
      .mockResolvedValueOnce({ threadId: "thread-child-root-name" })
      .mockResolvedValueOnce({ threadId: "thread-child-root-dot" });
    codex.startTurnWithResumeFallback
      .mockResolvedValueOnce("turn-child-root-name")
      .mockResolvedValueOnce("turn-child-root-dot");

    await expect(service.handleSpawnWorkerTool(
      { workstream: "root", title: "Root child name", initialUserMessage: "Stay in root", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-root-name" },
    )).resolves.toContain("workstream root");
    await expect(service.handleSpawnWorkerTool(
      { workstream: ".", title: "Root child dot", initialUserMessage: "Stay in root", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-root-dot" },
    )).resolves.toContain("workstream root");

    expect(store.getWorkerByAppThreadId("thread-child-root-name")).toMatchObject({
      channelId: "C1",
      workstreamId: "T1:root",
    });
    expect(store.getWorkerByAppThreadId("thread-child-root-dot")).toMatchObject({
      channelId: "C1",
      workstreamId: "T1:root",
    });
    store.close();
  });

  it("fails clearly when a targeted workstream path does not exist", async () => {
    const { service, store } = await createService();
    createWorker(service);

    await expect(service.handleSpawnWorkerTool(
      { workstream: "missing/path", title: "Child task", initialUserMessage: "Do the thing", mode: "fresh" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    )).resolves.toBe("Workstream not found: missing/path");
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

  it("posts compact lifecycle messages in a worker thread", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });

    await service.handleThreadCommand(worker, "compact", []);
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "completed" });

    expect(codex.compactThread).toHaveBeenCalledWith("thread-1");
    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Compacting context."],
      ["C1", "1.000", "_System_: Context compacted."],
    ]);
    store.close();
  });

  it("posts compact failure messages in a worker thread", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });
    codex.compactThread.mockRejectedValue(new Error("boom"));

    await service.handleThreadCommand(worker, "compact", []);

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Context compaction failed: boom"],
    ]);
    store.close();
  });

  it("treats failed worker compaction completion events as failures", async () => {
    const { service, slack, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });

    await service.handleThreadCommand(worker, "compact", []);
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "failed" });

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Compacting context."],
      ["C1", "1.000", "_System_: Context compaction failed."],
    ]);
    store.close();
  });

  it("ignores stale worker compaction events for a different item id", async () => {
    const { service, slack, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });

    await service.handleThreadCommand(worker, "compact", []);
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "stale-old", status: "completed" });

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Compacting context."],
    ]);
    store.close();
  });

  it("ignores pre-start worker completion events until the real compaction starts", async () => {
    const { service, slack, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });

    await service.handleThreadCommand(worker, "compact", []);
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "stale-old", status: "completed" });
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "thread-1", itemId: "compact-1", status: "completed" });

    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Compacting context."],
      ["C1", "1.000", "_System_: Context compacted."],
    ]);
    store.close();
  });

  it("rejects duplicate worker thread compaction requests while one is pending", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });
    codex.compactThread.mockResolvedValue(undefined);

    await service.handleThreadCommand(worker, "compact", []);
    await service.handleThreadCommand(worker, "compact", []);

    expect(codex.compactThread).toHaveBeenCalledTimes(1);
    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "Context compaction is already in progress for this thread."],
    ]);
    store.close();
  });

  it("allows retrying worker compaction when the previous pending attempt is stale", async () => {
    vi.useFakeTimers();
    try {
      const { service, slack, codex, store } = await createService();
      const worker = createWorker(service, {
        status: "idle",
        activeTurnId: null,
        appThreadId: "thread-1",
      });
      codex.compactThread.mockResolvedValue(undefined);

      await service.handleThreadCommand(worker, "compact", []);
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await service.handleThreadCommand(worker, "compact", []);

      expect(codex.compactThread).toHaveBeenCalledTimes(2);
      expect(slack.postThreadReply.mock.calls).toEqual([
        ["C1", "1.000", "Compaction requested for thread thread-1"],
        ["C1", "1.000", "Compaction requested for thread thread-1"],
      ]);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels worker thread compaction if the thread is no longer idle by send time", async () => {
    const { service, slack, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "thread-1",
    });
    slack.postThreadReply.mockImplementationOnce(async (...args: unknown[]) => {
      service.store.updateWorkerState(worker.key, {
        activeTurnId: "turn-2",
        status: "running",
      });
      return "reply-ts";
    });

    await service.handleThreadCommand(worker, "compact", []);

    expect(codex.compactThread).not.toHaveBeenCalled();
    expect(slack.postThreadReply.mock.calls).toEqual([
      ["C1", "1.000", "Compaction requested for thread thread-1"],
      ["C1", "1.000", "_System_: Context compaction canceled because the thread is no longer idle."],
    ]);
    store.close();
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
    await service.onDmCompleted("T1", "U-admin", "dm-thread-1", "", "interrupted");

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

  it("posts compact lifecycle messages in the admin DM", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });

    const result = await service.handleDmCommand(session, "compact", []);
    expect(result.response).toBe("Compaction requested for thread dm-thread-1");
    await result.afterSend?.();
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "completed" });

    expect(codex.compactThread).toHaveBeenCalledWith("dm-thread-1");
    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Compacting context."],
      ["D1", "_System_: Context compacted."],
    ]);
    store.close();
  });

  it("posts compact failure messages in the admin DM", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });
    codex.compactThread.mockRejectedValue(new Error("boom"));

    const result = await service.handleDmCommand(session, "compact", []);
    await result.afterSend?.();

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Context compaction failed: boom"],
    ]);
    store.close();
  });

  it("treats failed DM compaction completion events as failures", async () => {
    const { service, slack, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });

    const result = await service.handleDmCommand(session, "compact", []);
    expect(result.response).toBe("Compaction requested for thread dm-thread-1");
    await result.afterSend?.();
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "failed" });

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Compacting context."],
      ["D1", "_System_: Context compaction failed."],
    ]);
    store.close();
  });

  it("ignores stale DM compaction events for a different item id", async () => {
    const { service, slack, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });

    const result = await service.handleDmCommand(session, "compact", []);
    await result.afterSend?.();
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "stale-old", status: "completed" });

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Compacting context."],
    ]);
    store.close();
  });

  it("ignores pre-start DM completion events until the real compaction starts", async () => {
    const { service, slack, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });

    const result = await service.handleDmCommand(session, "compact", []);
    await result.afterSend?.();
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "stale-old", status: "completed" });
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "started" });
    await (service as any).handleCompactionEvent({ threadId: "dm-thread-1", itemId: "compact-1", status: "completed" });

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Compacting context."],
      ["D1", "_System_: Context compacted."],
    ]);
    store.close();
  });

  it("rejects duplicate DM compaction requests while one is pending", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });
    codex.compactThread.mockResolvedValue(undefined);

    const first = await service.handleDmCommand(session, "compact", []);
    expect(first.response).toBe("Compaction requested for thread dm-thread-1");
    await first.afterSend?.();
    const second = await service.handleDmCommand(session, "compact", []);

    expect(codex.compactThread).toHaveBeenCalledTimes(1);
    expect(second.response).toBe("Context compaction is already in progress for this DM.");
    store.close();
  });

  it("allows retrying DM compaction when the previous pending attempt is stale", async () => {
    vi.useFakeTimers();
    try {
      const { service, codex, store } = await createService();
      const session = createDmSession(service, {
        status: "idle",
        activeTurnId: null,
        appThreadId: "dm-thread-1",
      });
      codex.compactThread.mockResolvedValue(undefined);

      const first = await service.handleDmCommand(session, "compact", []);
      expect(first.response).toBe("Compaction requested for thread dm-thread-1");
      await first.afterSend?.();
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      const second = await service.handleDmCommand(session, "compact", []);
      expect(second.response).toBe("Compaction requested for thread dm-thread-1");
      await second.afterSend?.();

      expect(codex.compactThread).toHaveBeenCalledTimes(2);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels DM compaction if the DM is no longer idle by send time", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      status: "idle",
      activeTurnId: null,
      appThreadId: "dm-thread-1",
    });

    const result = await service.handleDmCommand(session, "compact", []);
    service.store.upsertDmSession({
      ...session,
      status: "running",
      activeTurnId: "turn-2",
    });
    await result.afterSend?.();

    expect(codex.compactThread).not.toHaveBeenCalled();
    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "_System_: Context compaction canceled because this DM is no longer idle."],
    ]);
    store.close();
  });

  it("creates a fresh admin thread immediately with the new-thread command", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-old" });
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    const result = await service.handleDmCommand(session, "new-thread", []);

    expect(result.response).toContain("Created a fresh backing Codex admin thread.");
    expect(result.response).toContain("dm-thread-new");
    expect(store.getDmSession("T1", "U-admin")).toMatchObject({
      appThreadId: "dm-thread-new",
      status: "idle",
      activeTurnId: null,
    });
    store.close();
  });

  it("new-thread abandons the old DM turn and declines stale interactive prompts", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service, {
      appThreadId: "dm-thread-old",
      activeTurnId: "turn-old",
      status: "blocked_input",
      pendingRequest: {
        kind: "tool_user_input",
        requestId: "req-old",
        promptText: "Need input",
        threadId: "dm-thread-old",
        turnId: "turn-old",
        itemId: null,
        questionIds: [],
        schemaJson: null,
        createdAt: "2026-03-18T00:00:00.000Z",
      },
    });
    (service as any).pendingInteractiveRequests.set("dm-thread-old", {
      kind: "tool_user_input",
      requestId: "req-old",
      threadId: "dm-thread-old",
      turnId: "turn-old",
      itemId: null,
      promptText: "Need input",
      questionIds: [],
      schemaJson: null,
      params: {},
    });
    (service as any).startingDmTurns.set("dm:T1:U-admin", Promise.resolve("turn-stale"));
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    const result = await service.handleDmCommand(session, "new-thread", []);

    expect(result.response).toContain("dm-thread-new");
    expect(codex.interruptTurn).toHaveBeenCalledWith("dm-thread-old", "turn-old");
    expect(codex.respondToServerRequest).toHaveBeenCalledWith("req-old", { answers: {} });
    expect((service as any).pendingInteractiveRequests.has("dm-thread-old")).toBe(false);
    expect((service as any).startingDmTurns.has("dm:T1:U-admin")).toBe(false);
    expect(store.getDmSession("T1", "U-admin")).toMatchObject({
      appThreadId: "dm-thread-new",
      activeTurnId: null,
      pendingRequest: null,
      status: "idle",
    });
    store.close();
  });

  it("new-thread still succeeds when declining a stale interactive request fails", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service, {
      appThreadId: "dm-thread-old",
      activeTurnId: "turn-old",
      status: "blocked_input",
      pendingRequest: {
        kind: "tool_user_input",
        requestId: "req-old",
        promptText: "Need input",
        threadId: "dm-thread-old",
        turnId: "turn-old",
        itemId: null,
        questionIds: [],
        schemaJson: null,
        createdAt: "2026-03-18T00:00:00.000Z",
      },
    });
    (service as any).pendingInteractiveRequests.set("dm-thread-old", {
      kind: "tool_user_input",
      requestId: "req-old",
      threadId: "dm-thread-old",
      turnId: "turn-old",
      itemId: null,
      promptText: "Need input",
      questionIds: [],
      schemaJson: null,
      params: {},
    });
    codex.respondToServerRequest.mockRejectedValue(new Error("gone"));
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    const result = await service.handleDmCommand(session, "new-thread", []);

    expect(result.response).toContain("dm-thread-new");
    expect((service as any).pendingInteractiveRequests.has("dm-thread-old")).toBe(false);
    expect(store.getDmSession("T1", "U-admin")?.appThreadId).toBe("dm-thread-new");
    store.close();
  });

  it("new-thread preserves effective team defaults when the DM has no override", async () => {
    const { service, codex, store } = await createService();
    const session = createDmSession(service, {
      appThreadId: "dm-thread-old",
      settings: { model: null, effort: null },
    });
    store.setTeamDefaults("T1", { model: "gpt-5.5", effort: "medium" });
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    await service.handleDmCommand(session, "new-thread", []);

    expect(codex.createAdminThread).toHaveBeenCalledWith({ model: "gpt-5.5", effort: "medium" });
    store.close();
  });

  it("ignores stale DM completion callbacks after new-thread swaps the backing thread", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      appThreadId: "dm-thread-old",
      status: "running",
      activeTurnId: "turn-old",
      lastInboundMessageTs: "9.000",
    });
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    await service.handleDmCommand(session, "new-thread", []);
    await (service as any).onDmCompleted("T1", "U-admin", "dm-thread-old", "stale text", "completed");

    const updated = store.getDmSession("T1", "U-admin");
    expect(updated).toMatchObject({
      appThreadId: "dm-thread-new",
      status: "idle",
      activeTurnId: null,
    });
    expect(slack.postTopLevelMessage).toHaveBeenCalledTimes(1);
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "D1",
      "_System_: Reattached this admin DM to a fresh Codex thread. Prior runtime context was lost.",
    );
    store.close();
  });

  it("clears stale DM buffered assistant text when new-thread swaps the backing thread", async () => {
    const { service, slack, codex, store } = await createService();
    const session = createDmSession(service, {
      appThreadId: "dm-thread-old",
      status: "running",
      activeTurnId: "turn-old",
    });
    await (service as any).onDmAgentMessage("T1", "U-admin", "dm-thread-old", "agent-old", "stale buffered text");
    codex.createAdminThread.mockResolvedValue({ threadId: "dm-thread-new", threadName: null });

    await service.handleDmCommand(session, "new-thread", []);
    await (service as any).onDmAgentMessage("T1", "U-admin", "dm-thread-new", "agent-new", "fresh buffered text");
    await (service as any).onDmCompleted("T1", "U-admin", "dm-thread-new", "", "completed");

    expect(slack.postTopLevelMessage.mock.calls).toContainEqual([
      "D1",
      "fresh buffered text",
    ]);
    expect(slack.postTopLevelMessage.mock.calls).not.toContainEqual([
      "D1",
      "stale buffered text",
    ]);
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
    const { service, slack, store } = await createService({ showSlackWorklog: true });
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
      ["C1", "1.000", "San Francisco is 58 F and clear.", { username: "Gear", iconEmoji: "gear" }],
    ]);
    expect(slack.updateMessage).not.toHaveBeenCalled();
    const updated = store.getWorkerByKey("T1:C1:1.000");
    expect(updated?.currentAgentSlackTs).toBeNull();
    store.close();
  });

  it("posts visible final worker replies without mentioning the owner by default", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: false,
    });

    await service.onWorkerCompleted("T1:C1:1.000", "San Francisco is 58 F and clear.", "completed");

    expect(slack.postThreadReply).toHaveBeenLastCalledWith(
      "C1",
      "1.000",
      "San Francisco is 58 F and clear.",
      { username: "Gear", iconEmoji: "gear" },
    );
    const updated = store.getWorkerByKey("T1:C1:1.000");
    expect(updated?.turnNotificationTurnId).toBeNull();
    expect(updated?.turnNotificationEnabled).toBe(false);
    store.close();
  });

  it("mentions the owner on final worker replies only when the turn opts in", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: true,
    });

    await service.onWorkerCompleted("T1:C1:1.000", "San Francisco is 58 F and clear.", "completed");

    expect(slack.postThreadReply).toHaveBeenLastCalledWith(
      "C1",
      "1.000",
      "<@U1> San Francisco is 58 F and clear.",
      { username: "Gear", iconEmoji: "gear" },
    );
    store.close();
  });

  it("applies notification gating to failed worker turns too", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: false,
    });

    await service.onWorkerCompleted("T1:C1:1.000", "", "failed", "boom");
    expect(slack.postThreadReply).toHaveBeenLastCalledWith(
      "C1",
      "1.000",
      "Turn failed. boom",
      { username: "Gear", iconEmoji: "gear" },
    );

    slack.postThreadReply.mockClear();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-2",
      turnNotificationTurnId: "turn-2",
      turnNotificationEnabled: true,
    });

    await service.onWorkerCompleted("T1:C1:1.000", "", "failed", "boom");
    expect(slack.postThreadReply).toHaveBeenLastCalledWith(
      "C1",
      "1.000",
      "<@U1> Turn failed. boom",
      { username: "Gear", iconEmoji: "gear" },
    );
    store.close();
  });

  it("stores turn-scoped notification preference through the worker tool handler", async () => {
    const { service, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-1",
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: false,
    });

    await expect(service.handleSetNotificationTool(
      { enabled: true },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    )).resolves.toBe("Notifications enabled for this turn.");
    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: true,
    });

    await expect(service.handleSetNotificationTool(
      { enabled: false },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-2" },
    )).resolves.toBe("Notifications disabled for this turn.");
    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      turnNotificationTurnId: "turn-1",
      turnNotificationEnabled: false,
    });
    store.close();
  });

  it("returns the current worker thread permalink payload from the worker tool handler", async () => {
    const { service, slack, store } = await createService();
    createWorker(service, {
      teamId: "T1",
      channelId: "C1",
      rootTs: "1.000",
      appThreadId: "thread-1",
    });

    await expect(service.handleGetCurrentSlackThreadLinkTool(
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    )).resolves.toBe(JSON.stringify({
      permalink: "https://app.slack.com/archives/C1/p1000",
      team_id: "T1",
      channel_id: "C1",
      root_ts: "1.000",
    }, null, 2));
    expect(slack.getMessagePermalink).toHaveBeenCalledWith("C1", "1.000");
    store.close();
  });

  it("rejects current worker thread permalink lookup outside a worker thread", async () => {
    const { service, store } = await createService();
    createDmSession(service, { appThreadId: "dm-thread-1" });

    await expect(service.handleGetCurrentSlackThreadLinkTool(
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    )).rejects.toThrow("Slack thread link lookup requires a worker thread context.");
    store.close();
  });

  it("rejects stale set_notification tool calls from non-current turns", async () => {
    const { service, store } = await createService();
    createWorker(service, {
      status: "running",
      activeTurnId: "turn-2",
      turnNotificationTurnId: "turn-2",
      turnNotificationEnabled: false,
    });

    await expect(service.handleSetNotificationTool(
      { enabled: true },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-stale" },
    )).rejects.toThrow("Notification control requires the current active worker turn.");
    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      turnNotificationTurnId: "turn-2",
      turnNotificationEnabled: false,
    });
    store.close();
  });

  it("accepts set_notification during the narrow turn-start window before activeTurnId is persisted", async () => {
    const { service, store } = await createService();
    createWorker(service, {
      status: "idle",
      activeTurnId: null,
      turnNotificationTurnId: null,
      turnNotificationEnabled: false,
    });
    const pendingTurn = deferred<string>();
    service.startingWorkerTurns.set("T1:C1:1.000", pendingTurn.promise);

    const callPromise = service.handleSetNotificationTool(
      { enabled: true },
      { threadId: "thread-1", turnId: "turn-starting", callId: "call-starting" },
    );
    pendingTurn.resolve("turn-starting");

    await expect(callPromise).resolves.toBe("Notifications enabled for this turn.");
    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      turnNotificationTurnId: "turn-starting",
      turnNotificationEnabled: true,
    });
    store.close();
  });

  it("resets notification preference to silent by default when a new worker turn starts", async () => {
    const { service, codex, store } = await createService();
    const worker = createWorker(service, {
      status: "idle",
      activeTurnId: null,
      turnNotificationTurnId: "old-turn",
      turnNotificationEnabled: true,
    });
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-2");

    await service.startWorkerTurn(worker, { text: "check in", imagePaths: [] });

    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      activeTurnId: "turn-2",
      status: "running",
      turnNotificationTurnId: "turn-2",
      turnNotificationEnabled: false,
    });
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
      "Checking weather now.",
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
    expect(slack.postThreadReply.mock.calls[1]?.[2]).toContain("webhook_bind: 127.0.0.1:");
    expect(slack.postThreadReply.mock.calls[1]?.[2]).toContain("webhook_public_url_base: https://hooks.example.test/webhooks");
    expect(slack.postThreadReply.mock.calls[1]?.[2]).toContain("webhook_proxy_trust: disabled");
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

  it("does not fail if a pending relaunch notice cannot be posted", async () => {
    const { service, slack, store } = await createService();
    store.setPendingRestartNotice({
      target: "bridge",
      teamId: "T1",
      userId: "U-admin",
      channelId: "D1",
      requestedAt: "2026-03-12T12:00:00.000Z",
    });
    slack.postTopLevelMessage.mockRejectedValueOnce(new Error("cannot_reply_to_message"));

    await expect(service.postPendingRestartNotice()).resolves.toBeUndefined();

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
    expect(result.response).toContain("Open in Slack app:");
    expect(result.response).toContain("Browser fallback:");
    expect(result.response).toContain("Join Channel");
    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "ops");
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toMatchObject({
      relativePath: "ops",
      channelName: "ops",
      archivedAt: null,
    });
    await expect(fs.readFile(path.join(dir, "ops", "WORKSTREAM.md"), "utf8")).resolves.toContain("Slack surface: #ops");
    await expect(fs.readFile(path.join(dir, "ops", "AGENTS.md"), "utf8")).resolves.toContain("WORKSTREAM.md");
    await expect(fs.readFile(path.join(dir, "ops", ".slack-workers", "registrations.json"), "utf8")).resolves.toContain("[]");
    store.close();
  });

  it("creates a workstream from a worker thread command using the current workstream as the default parent", async () => {
    const { service, slack, store } = await createService();
    createDmSession(service, { appThreadId: "dm-thread-1" });
    const worker = createWorker(service, { workstreamId: "T1:root" });

    await service.handleThreadCommand(worker, "workstream-create", ["ops"]);

    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "ops");
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toBeTruthy();
    expect(slack.postThreadReply).toHaveBeenCalledWith("C1", "1.000", expect.stringContaining("Created workstream ops."));
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Open in Slack app: <slack://channel?team=T1&id=C-ops|#ops>"));
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Browser fallback: <https://app.slack.com/client/T1/C-ops|open channel>"));
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Join Channel"));
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
    expect(result).toContain("Open in Slack app:");
    expect(slack.createPublicChannel).toHaveBeenCalledWith("T1", "research");
    expect(store.getWorkstreamByRelativePath("T1", "research")).toMatchObject({ relativePath: "research" });
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Created workstream research."));
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith("D1", expect.stringContaining("Join Channel"));
    store.close();
  });

  it("archives a workstream from the admin DM command and removes it from active routing", async () => {
    const { dir, service, slack, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });

    await service.handleDmCommand(session, "workstream-create", ["ops", "parent=root", "Handles", "ops"]);
    store.upsertRegistration({
      id: "reg-ops-1",
      teamId: "T1",
      workstreamId: "T1:ops",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "ops webhook",
      enabled: true,
      target: { kind: "workstream", workstreamId: "T1:ops", workerKey: null },
      action: { kind: "spawn" },
      trigger: { kind: "webhook", source: "ops", events: ["ready"], deliveryMode: "queue", match: null },
    });
    store.createPendingWake({
      id: "wake-ops-queued",
      teamId: "T1",
      registrationId: "reg-ops-1",
      workstreamId: "T1:ops",
      workerKey: null,
      status: "queued",
      summary: "ops wake",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    store.createPendingWake({
      id: "wake-ops-delivered",
      teamId: "T1",
      registrationId: "reg-ops-1",
      workstreamId: "T1:ops",
      workerKey: null,
      status: "delivered",
      summary: "old wake",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    store.createPendingWake({
      id: "wake-ops-failed-retry",
      teamId: "T1",
      registrationId: "reg-ops-1",
      workstreamId: "T1:ops",
      workerKey: null,
      status: "failed",
      summary: "retry wake",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 1,
      nextAttemptAt: "2026-03-19T00:00:00.000Z",
      lastError: "temporary",
    });

    const result = await service.handleDmCommand(session, "workstream-archive", ["ops"]);

    expect(result.response).toContain("Archived workstream ops.");
    expect(slack.archivePublicChannel).toHaveBeenCalledWith("C-ops");
    expect(store.getRegistration("reg-ops-1")).toMatchObject({ enabled: false });
    expect(store.getPendingWake("wake-ops-queued")).toMatchObject({
      status: "quarantined",
      lastError: "workstream archived",
    });
    expect(store.getPendingWake("wake-ops-failed-retry")).toMatchObject({
      status: "quarantined",
      lastError: "workstream archived",
    });
    expect(store.getPendingWake("wake-ops-delivered")).toMatchObject({ status: "delivered" });
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toBeNull();
    expect(store.getWorkstreamById("T1:ops", { includeArchived: true })).toMatchObject({
      archivedAt: expect.any(String),
    });
    const archivedRegistrations = await service.handleAdminListRegistrationsTool(
      { workstream: "ops" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    const archivedWakes = await service.handleAdminListWakeDeliveriesTool(
      { workstream: "ops" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(archivedRegistrations).toContain("reg-ops-1");
    expect(archivedWakes).toContain("wake-ops-queued");
    await expect(fs.access(path.join(dir, "ops", "WORKSTREAM.md"))).resolves.toBeUndefined();
    store.close();
  });

  it("refuses to archive root or a workstream with active children", async () => {
    const { service, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops",
      relativePath: "ops",
      channelId: "C-ops",
      channelName: "ops",
      description: "ops",
      archivedAt: null,
    });
    store.upsertWorkstream({
      id: "T1:ops/child",
      teamId: "T1",
      parentId: "T1:ops",
      slug: "child",
      relativePath: "ops/child",
      channelId: "C-child",
      channelName: "child",
      description: "child",
      archivedAt: null,
    });

    const rootResult = await service.handleDmCommand(session, "workstream-archive", ["root"]);
    const childResult = await service.handleDmCommand(session, "workstream-archive", ["ops"]);

    expect(rootResult.response).toContain("Root workstream cannot be archived.");
    expect(childResult.response).toContain("child workstreams exist");
    store.close();
  });

  it("refuses to archive a workstream with active workers or non-failed pending shells", async () => {
    const { service, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops",
      relativePath: "ops",
      channelId: "C-ops",
      channelName: "ops",
      description: "ops",
      archivedAt: null,
    });
    createWorker(service, {
      key: "T1:C-ops:2.000",
      channelId: "C-ops",
      rootTs: "2.000",
      workstreamId: "T1:ops",
      appThreadId: "thread-ops",
      status: "running",
    });

    const workerBlocked = await service.handleDmCommand(session, "workstream-archive", ["ops"]);
    expect(workerBlocked.response).toContain("active or blocked");

    store.updateWorkerState("T1:C-ops:2.000", { status: "idle", activeTurnId: null });
    store.upsertPendingWorkerShell({
      id: "shell-1",
      teamId: "T1",
      workstreamId: "T1:ops",
      channelId: "C-ops",
      rootTs: null,
      title: "pending",
      requestItemId: null,
      requestItemPath: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      settings: { model: null, effort: null },
      identity: null,
      parentWorkerKey: null,
      source: { sourceKind: "manual", sourceSummary: "pending shell" },
      status: "pending",
      appThreadId: null,
      lastError: null,
    });

    const shellBlocked = await service.handleDmCommand(session, "workstream-archive", ["ops"]);
    expect(shellBlocked.response).toContain("worker creation is still pending");

    store.deletePendingWorkerShell("shell-1");
    store.upsertPendingWorkerShell({
      id: "shell-failed",
      teamId: "T1",
      workstreamId: "T1:ops",
      channelId: "C-ops",
      rootTs: null,
      title: "failed shell",
      requestItemId: null,
      requestItemPath: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      settings: { model: null, effort: null },
      identity: null,
      parentWorkerKey: null,
      source: { sourceKind: "manual", sourceSummary: "failed shell" },
      status: "failed",
      appThreadId: null,
      lastError: "boom",
    });
    store.deletePendingWorkerShell("shell-1");
    const afterFailedShell = await service.handleDmCommand(session, "workstream-archive", ["ops"]);
    expect(afterFailedShell.response).toContain("Archived workstream ops.");
    store.close();
  });

  it("keeps local automation state unchanged if Slack archive fails", async () => {
    const { service, slack, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops",
      relativePath: "ops",
      channelId: "C-ops",
      channelName: "ops",
      description: "ops",
      archivedAt: null,
    });
    store.upsertRegistration({
      id: "reg-ops-1",
      teamId: "T1",
      workstreamId: "T1:ops",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "ops webhook",
      enabled: true,
      target: { kind: "workstream", workstreamId: "T1:ops", workerKey: null },
      action: { kind: "spawn" },
      trigger: { kind: "webhook", source: "ops", events: ["ready"], deliveryMode: "queue", match: null },
    });
    store.createPendingWake({
      id: "wake-ops-queued",
      teamId: "T1",
      registrationId: "reg-ops-1",
      workstreamId: "T1:ops",
      workerKey: null,
      status: "queued",
      summary: "ops wake",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    slack.archivePublicChannel.mockRejectedValueOnce(new Error("archive denied"));

    const result = await service.handleDmCommand(session, "workstream-archive", ["ops"]);

    expect(result.response).toContain("Workstream archive failed for ops: archive denied");
    expect(store.getRegistration("reg-ops-1")).toMatchObject({ enabled: true });
    expect(store.getPendingWake("wake-ops-queued")).toMatchObject({
      status: "queued",
      lastError: null,
    });
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toMatchObject({ relativePath: "ops" });
    expect(store.getWorkstreamById("T1:ops", { includeArchived: true })).toMatchObject({ archivedAt: null });
    store.close();
  });

  it("marks the workstream archived even if post-archive local cleanup fails", async () => {
    const { service, slack, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops",
      relativePath: "ops",
      channelId: "C-ops",
      channelName: "ops",
      description: "ops",
      archivedAt: null,
    });
    store.upsertRegistration({
      id: "reg-ops-1",
      teamId: "T1",
      workstreamId: "T1:ops",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "ops webhook",
      enabled: true,
      target: { kind: "workstream", workstreamId: "T1:ops", workerKey: null },
      action: { kind: "spawn" },
      trigger: { kind: "webhook", source: "ops", events: ["ready"], deliveryMode: "queue", match: null },
    });
    slack.archivePublicChannel.mockResolvedValueOnce(undefined);
    vi.spyOn(service.registrations, "disableRegistrationById").mockRejectedValueOnce(new Error("projection write failed"));

    const result = await service.handleDmCommand(session, "workstream-archive", ["ops"]);

    expect(result.response).toContain("Slack channel for ops was archived, but local cleanup failed: projection write failed");
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toBeNull();
    expect(store.getWorkstreamById("T1:ops", { includeArchived: true })).toMatchObject({
      archivedAt: expect.any(String),
    });
    expect(store.getRegistration("reg-ops-1")).toMatchObject({ enabled: true });
    store.close();
  });

  it("reports when a workstream is already archived", async () => {
    const { service, store } = await createService();
    const session = createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops",
      relativePath: "ops",
      channelId: "C-ops",
      channelName: "ops",
      description: "ops",
      archivedAt: "2026-03-18T12:00:00.000Z",
    });

    const result = await service.handleDmCommand(session, "workstream-archive", ["ops"]);

    expect(result.response).toContain("Workstream ops is already archived.");
    store.close();
  });

  it("reports current UTC time and workspace timezone through the time tool", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T22:45:30.000Z"));
    try {
      const { service, store } = await createService();

      const result = await (service as any).handleGetCurrentTimeTool({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
      });

      expect(result).toContain("current_time_utc: 2026-03-16T22:45:30.000Z");
      expect(result).toContain("workspace_timezone: America/Los_Angeles");
      expect(result).toContain("current_time_local: 03/16/2026, 15:45:30 PDT");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates and inspects a webhook source from a worker thread", async () => {
    const { service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });

    const created = await (service as any).handleCreateWebhookSourceTool(
      { source: "linear" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );
    const details = JSON.parse(created);

    expect(details.source).toBe("linear");
    expect(details.route_path).toMatch(/^\/webhooks\/[a-f0-9]+$/);
    expect(details.public_url).toMatch(/^https:\/\/hooks\.example\.test\/webhooks\/[a-f0-9]+$/);
    expect(details.handler_path).toContain("/.slack-workers/bridge/webhook-sources/T1/linear/handler.mjs");
    expect(details.handler_contract).toMatchObject({
      export_name: "normalizeWebhook",
      ctx_fields: [
        "source",
        "method",
        "url",
        "routePath",
        "headers",
        "rawBody",
        "parsedJson",
        "receivedAt",
        "remoteAddress",
      ],
    });
    expect(details.handler_contract.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "events" }),
      expect.objectContaining({ outcome: "noop" }),
      expect.objectContaining({ outcome: "reject" }),
    ]));

    const inspected = await (service as any).handleGetWebhookSourceTool(
      { source: "linear" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-2" },
    );
    expect(JSON.parse(inspected)).toMatchObject({
      source: "linear",
      enabled: true,
    });
    expect(store.getWebhookSource("T1", "linear")).toBeTruthy();
    store.close();
  });

  it("creates and rotates a webhook source only from a worker thread or admin DM context", async () => {
    const { service, store } = await createService();
    createDmSession(service, { appThreadId: "dm-thread-1" });
    store.createWebhookSource({
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "oldroute",
      handlerPath: "/tmp/linear/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.createWebhookSource({
      id: "src-1b",
      teamId: "T2",
      source: "linear",
      routeToken: "route-1b",
      handlerPath: "/tmp/linear-t2/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });

    const result = await (service as any).handleRotateWebhookSourceRouteTool({
      source: "linear",
    }, {
      threadId: "dm-thread-1",
      turnId: "turn-1",
      callId: "call-1",
    });

    const source = JSON.parse(result);
    expect(source.route_path).not.toBe("/webhooks/oldroute");
    expect(store.getWebhookSource("T1", "linear")?.routeToken).not.toBe("oldroute");

    await expect((service as any).handleRotateWebhookSourceRouteTool({
      source: "linear",
    }, {
      threadId: "unknown-thread",
      turnId: "turn-2",
      callId: "call-2",
    })).rejects.toThrow("worker thread or admin DM context");
    store.close();
  });

  it("lists webhook registrations for a shared source across the workspace", async () => {
    const { service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    createDmSession(service, { appThreadId: "dm-thread-1" });
    store.createWebhookSource({
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "route-1",
      handlerPath: "/tmp/linear/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.upsertWorkstream({
      id: "T1:customers",
      teamId: "T1",
      relativePath: "customers",
      parentId: "T1:root",
      slug: "customers",
      channelId: "C-customers",
      channelName: "customers",
      description: null,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.upsertRegistration({
      id: "reg-root",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: { kind: "worker", workstreamId: "T1:root", workerKey: "T1:C1:1.000" },
      action: { kind: "wake_self" },
      trigger: { kind: "webhook", source: "linear", events: ["issue.updated"], deliveryMode: "steer", match: { issue_id: "LIN-123" } },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.upsertRegistration({
      id: "reg-child",
      teamId: "T1",
      workstreamId: "T1:customers",
      workerKey: null,
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: false,
      target: { kind: "workstream", workstreamId: "T1:customers", workerKey: null },
      action: { kind: "spawn" },
      trigger: { kind: "webhook", source: "linear", events: ["project.updated"], deliveryMode: "queue", match: { project_id: "proj_123" } },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.upsertRegistration({
      id: "reg-other-source",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: { kind: "worker", workstreamId: "T1:root", workerKey: "T1:C1:1.000" },
      action: { kind: "wake_self" },
      trigger: { kind: "webhook", source: "stripe", events: ["invoice.paid"], deliveryMode: "queue", match: { customer_id: "cus_123" } },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
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
      target: { kind: "worker", workstreamId: "T1:root", workerKey: "T1:C1:1.000" },
      action: { kind: "wake_self" },
      trigger: { kind: "heartbeat", intervalMinutes: 15 },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.upsertRegistration({
      id: "reg-t2",
      teamId: "T2",
      workstreamId: "T1:root",
      workerKey: "T2:C2:1.000",
      ownerUserId: "U2",
      rootOwnerUserId: "U2",
      description: null,
      enabled: true,
      target: { kind: "worker", workstreamId: "T1:root", workerKey: "T2:C2:1.000" },
      action: { kind: "wake_self" },
      trigger: { kind: "webhook", source: "linear", events: ["issue.updated"], deliveryMode: "queue", match: { issue_id: "LIN-999" } },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });

    const workerView = await (service as any).handleListWebhookRegistrationsTool(
      { source: "linear" },
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(workerView).toContain("reg-root [enabled] workstream=root target=worker:T1:C1:1.000 delivery=steer events=issue.updated match={\"issue_id\":\"LIN-123\"}");
    expect(workerView).toContain("reg-child [disabled] workstream=customers target=workstream:T1:customers delivery=queue events=project.updated match={\"project_id\":\"proj_123\"}");
    expect(workerView).not.toContain("reg-other-source");
    expect(workerView).not.toContain("reg-heartbeat");
    expect(workerView).not.toContain("reg-t2");

    const adminView = await (service as any).handleListWebhookRegistrationsTool(
      { source: "linear" },
      { threadId: "dm-thread-1", turnId: "turn-2", callId: "call-2" },
    );
    expect(adminView).toContain("reg-root");
    expect(adminView).toContain("reg-child");
    expect(adminView).not.toContain("reg-other-source");
    expect(adminView).not.toContain("reg-heartbeat");
    expect(adminView).not.toContain("reg-t2");

    const emptySource = await (service as any).handleListWebhookRegistrationsTool(
      { source: "linear" },
      { threadId: "thread-1", turnId: "turn-4", callId: "call-4" },
    );
    store.disableRegistration("reg-root");
    store.disableRegistration("reg-child");
    const disabledOnly = await (service as any).handleListWebhookRegistrationsTool(
      { source: "linear" },
      { threadId: "thread-1", turnId: "turn-5", callId: "call-5" },
    );
    expect(emptySource).toContain("reg-root");
    expect(disabledOnly).toContain("reg-root [disabled] workstream=root target=worker:T1:C1:1.000 delivery=steer events=issue.updated match={\"issue_id\":\"LIN-123\"}");
    expect(disabledOnly).toContain("reg-child [disabled] workstream=customers target=workstream:T1:customers delivery=queue events=project.updated match={\"project_id\":\"proj_123\"}");
    expect(disabledOnly).not.toContain("[enabled]");

    store.createWebhookSource({
      id: "src-2",
      teamId: "T1",
      source: "github",
      routeToken: "route-2",
      handlerPath: "/tmp/github/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    const noDependents = await (service as any).handleListWebhookRegistrationsTool(
      { source: "github" },
      { threadId: "thread-1", turnId: "turn-6", callId: "call-6" },
    );
    expect(noDependents).toBe("No webhook registrations depend on source github.");

    await expect((service as any).handleListWebhookRegistrationsTool(
      { source: "missing" },
      { threadId: "thread-1", turnId: "turn-7", callId: "call-7" },
    )).rejects.toThrow("Webhook source missing does not exist.");
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

  it("lists and disables registrations from the admin DM with optional workstream filtering", async () => {
    const { service, store } = await createService();
    createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops-debug",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops-debug",
      relativePath: "ops-debug",
      channelId: "C-ops",
      channelName: "ops-debug",
      description: "ops",
      archivedAt: null,
    });
    store.upsertRegistration({
      id: "reg-admin-1",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "",
      rootOwnerUserId: "",
      description: "root webhook",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "webhook",
        source: "qa",
        events: ["root.check"],
        deliveryMode: "queue",
        match: null,
      },
    });
    store.upsertRegistration({
      id: "reg-admin-2",
      teamId: "T1",
      workstreamId: "T1:ops-debug",
      workerKey: null,
      ownerUserId: "",
      rootOwnerUserId: "",
      description: "ops heartbeat",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:ops-debug",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "heartbeat",
        intervalMinutes: 15,
      },
    });

    const listedAll = await service.handleAdminListRegistrationsTool(
      {},
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(listedAll).toContain("reg-admin-1");
    expect(listedAll).toContain("reg-admin-2");

    const listedFiltered = await service.handleAdminListRegistrationsTool(
      { workstream: "ops-debug" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(listedFiltered).toContain("reg-admin-2");
    expect(listedFiltered).not.toContain("reg-admin-1");

    const listedRoot = await service.handleAdminListRegistrationsTool(
      { workstream: "/root" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(listedRoot).toContain("reg-admin-1");
    expect(listedRoot).not.toContain("reg-admin-2");

    const detail = await service.handleAdminGetRegistrationTool(
      { registrationId: "reg-admin-2" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(detail).toContain('"id": "reg-admin-2"');

    const disabled = await service.handleAdminDisableRegistrationTool(
      { registrationId: "reg-admin-2" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(disabled).toContain("Disabled registration reg-admin-2");
    expect(store.getRegistration("reg-admin-2")).toMatchObject({ enabled: false });

    await expect(service.handleAdminListRegistrationsTool(
      { workstream: "   " },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    )).rejects.toThrow();

    await expect(service.handleAdminListRegistrationsTool(
      {},
      { threadId: "thread-1", turnId: "turn-1", callId: "call-1" },
    )).rejects.toThrow("admin DM");
    store.close();
  });

  it("lists wake deliveries from the admin DM with filters", async () => {
    const { service, store } = await createService();
    createDmSession(service, { appThreadId: "dm-thread-1" });
    store.upsertWorkstream({
      id: "T1:ops-debug",
      teamId: "T1",
      parentId: "T1:root",
      slug: "ops-debug",
      relativePath: "ops-debug",
      channelId: "C-ops",
      channelName: "ops-debug",
      description: "ops",
      archivedAt: null,
    });
    store.upsertRegistration({
      id: "reg-admin-1",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: null,
      ownerUserId: "",
      rootOwnerUserId: "",
      description: "root webhook",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "webhook",
        source: "qa",
        events: ["root.check"],
        deliveryMode: "queue",
        match: null,
      },
    });
    store.upsertRegistration({
      id: "reg-admin-2",
      teamId: "T1",
      workstreamId: "T1:ops-debug",
      workerKey: null,
      ownerUserId: "",
      rootOwnerUserId: "",
      description: "ops heartbeat",
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:ops-debug",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "heartbeat",
        intervalMinutes: 15,
      },
    });
    store.createPendingWake({
      id: "wake-admin-1",
      teamId: "T1",
      registrationId: "reg-admin-1",
      workstreamId: "T1:root",
      workerKey: null,
      status: "delivered",
      summary: "root delivered",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    store.createPendingWake({
      id: "wake-admin-2",
      teamId: "T1",
      registrationId: "reg-admin-2",
      workstreamId: "T1:ops-debug",
      workerKey: null,
      status: "queued",
      summary: "ops queued",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });

    const listedAll = await service.handleAdminListWakeDeliveriesTool(
      {},
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(listedAll).toContain("wake-admin-1");
    expect(listedAll).toContain("wake-admin-2");

    const filtered = await service.handleAdminListWakeDeliveriesTool(
      { workstream: "ops-debug", registrationId: "reg-admin-2" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(filtered).toContain("wake-admin-2");
    expect(filtered).not.toContain("wake-admin-1");

    const rootFiltered = await service.handleAdminListWakeDeliveriesTool(
      { workstream: "/root", registrationId: "reg-admin-1" },
      { threadId: "dm-thread-1", turnId: "turn-1", callId: "call-1" },
    );
    expect(rootFiltered).toContain("wake-admin-1");
    expect(rootFiltered).not.toContain("wake-admin-2");
    store.close();
  });

  it("queues and delivers heartbeat wakes into an idle worker", async () => {
    const { service, codex, slack, store } = await createService();
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
    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C1",
      "1.000",
      expect.stringContaining("_System_: Wake delivered to Codex:\n[system wake event]"),
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
      expect.stringContaining("Scheduled work: Daily digest\n\n[system wake event]"),
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
    const webhookSource = await createWebhookSource(service, { source: "github" });

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
        deliveryMode: "queue",
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "push",
        dedupeKey: "evt-1",
        fields: { repo: "acme/api" },
        payload: { ref: "refs/heads/main", commits: 3 },
      },
      rawBody: "{\"event\":\"push\"}",
    }));

    expect(result).toMatchObject({ status: 202, body: expect.objectContaining({ createdEvents: 1, matchedRegistrations: 1 }) });
    expect(service.scheduleRegistrationLoop).toHaveBeenCalledWith(0);
    await service.deliverQueuedWakes();

    const wakes = store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "delivered", firedEvent: "push" });
    expect(wakes[0]?.payloadPath).toContain(path.join(dir, "webhooks", "events", "github"));
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
    const webhookSource = await createWebhookSource(service, { source: "github" });

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
        deliveryMode: "queue",
        match: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const first = await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: { event: "push", dedupeKey: "evt-1", payload: { seq: 1 } },
      rawBody: "{\"event\":\"push\",\"id\":\"evt-1\"}",
    }));
    const second = await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: { event: "push", dedupeKey: "evt-1", payload: { seq: 2 } },
      rawBody: "{\"event\":\"push\",\"id\":\"evt-1\"}",
      receivedAt: "2026-01-01T00:02:00.000Z",
    }));

    expect(first).toMatchObject({ status: 202, body: expect.objectContaining({ createdEvents: 1, matchedRegistrations: 1 }) });
    expect(second).toMatchObject({ status: 202, body: expect.objectContaining({ duplicateEvents: 1, matchedRegistrations: 0 }) });
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
    store.close();
  });

  it("steers an active worker turn for webhook registrations with deliveryMode=steer", async () => {
    const { service, codex, slack, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root", activeTurnId: "turn-active", status: "running" });
    const webhookSource = await createWebhookSource(service, { source: "linear" });

    store.upsertRegistration({
      id: "reg-webhook-steer",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Track issue state",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "linear",
        events: ["issue.updated"],
        deliveryMode: "steer",
        match: { issue_id: "LIN-123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "issue.updated",
        dedupeKey: "evt-linear-1",
        fields: { issue_id: "LIN-123" },
        payload: { status: "todo" },
      },
    }));

    await service.deliverQueuedWakes();

    expect(codex.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-active",
      expect.objectContaining({
        text: expect.stringContaining("fired_event: issue.updated"),
      }),
    );
    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C1",
      "1.000",
      expect.stringContaining("_System_: Wake steered to Codex:\n[system wake event]"),
    );
    expect(codex.startTurnWithResumeFallback).not.toHaveBeenCalled();
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({
      status: "delivered",
    });
    store.close();
  });

  it("starts a fresh turn for webhook steer registrations when the worker is idle", async () => {
    const { service, codex, slack, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root", activeTurnId: null, status: "idle" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-fresh");
    const webhookSource = await createWebhookSource(service, { source: "linear" });

    store.upsertRegistration({
      id: "reg-webhook-steer-idle",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Track issue state",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "linear",
        events: ["issue.updated"],
        deliveryMode: "steer",
        match: { issue_id: "LIN-123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "issue.updated",
        dedupeKey: "evt-linear-2",
        fields: { issue_id: "LIN-123" },
        payload: { status: "backlog" },
      },
    }));

    await service.deliverQueuedWakes();

    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("fired_event: issue.updated"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C1",
      "1.000",
      expect.stringContaining("_System_: Wake delivered to Codex:\n[system wake event]"),
    );
    expect(codex.steerTurn).not.toHaveBeenCalled();
    store.close();
  });

  it("marks recovery-required when webhook steer hits a missing backing thread", async () => {
    const { service, codex, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root", activeTurnId: "turn-active", status: "running" });
    const webhookSource = await createWebhookSource(service, { source: "linear" });
    codex.steerTurn.mockRejectedValue(new Error("no thread found"));

    store.upsertRegistration({
      id: "reg-webhook-steer-missing",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Track issue state",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "linear",
        events: ["issue.updated"],
        deliveryMode: "steer",
        match: { issue_id: "LIN-123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "issue.updated",
        dedupeKey: "evt-linear-3",
        fields: { issue_id: "LIN-123" },
        payload: { status: "todo" },
      },
    }));

    await service.deliverQueuedWakes();

    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      status: "recovery_required",
      lastError: expect.stringContaining("Backing Codex thread is missing"),
    });
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({
      status: "queued",
    });
    expect(codex.startTurnWithResumeFallback).not.toHaveBeenCalled();
    store.close();
  });

  it("starts a fresh turn when webhook steer finds a stale active turn", async () => {
    const { service, codex, slack, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root", activeTurnId: "turn-stale", status: "running" });
    const webhookSource = await createWebhookSource(service, { source: "linear" });
    codex.steerTurn.mockRejectedValue(new Error("no active turn to steer"));
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-recovered");

    store.upsertRegistration({
      id: "reg-webhook-steer-stale",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "T1:C1:1.000",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Track issue state",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "T1:C1:1.000",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "webhook",
        source: "linear",
        events: ["issue.updated"],
        deliveryMode: "steer",
        match: { issue_id: "LIN-123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "issue.updated",
        dedupeKey: "evt-linear-4",
        fields: { issue_id: "LIN-123" },
        payload: { status: "todo" },
      },
    }));

    await service.deliverQueuedWakes();

    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        text: expect.stringContaining("fired_event: issue.updated"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C1",
      "1.000",
      expect.stringContaining("_System_: Wake delivered to Codex:\n[system wake event]"),
    );
    expect(store.getWorkerByKey("T1:C1:1.000")).toMatchObject({
      activeTurnId: "turn-recovered",
      status: "running",
    });
    store.close();
  });

  it("does not fan out webhook wakes when source, event, or match fields do not align", async () => {
    const { service, store } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    const githubSource = await createWebhookSource(service, { source: "github" });
    const stripeSource = await createWebhookSource(service, { source: "stripe", routeToken: "route-stripe" });
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
        deliveryMode: "queue",
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(service.ingestWebhookEvent(makeRawWebhookIngress(stripeSource, {
      parsedJson: { event: "push", dedupeKey: "evt-a", fields: { repo: "acme/api" }, payload: {} },
    }))).resolves.toMatchObject({ status: 202, body: expect.objectContaining({ matchedRegistrations: 0 }) });
    await expect(service.ingestWebhookEvent(makeRawWebhookIngress(githubSource, {
      parsedJson: { event: "pull_request", dedupeKey: "evt-b", fields: { repo: "acme/api" }, payload: {} },
      receivedAt: "2026-01-01T00:02:00.000Z",
    }))).resolves.toMatchObject({ status: 202, body: expect.objectContaining({ matchedRegistrations: 0 }) });
    await expect(service.ingestWebhookEvent(makeRawWebhookIngress(githubSource, {
      parsedJson: { event: "push", dedupeKey: "evt-c", fields: { repo: "other/repo" }, payload: {} },
      receivedAt: "2026-01-01T00:03:00.000Z",
    }))).resolves.toMatchObject({ status: 202, body: expect.objectContaining({ matchedRegistrations: 0 }) });

    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(0);
    expect(store.listWorkers()).toHaveLength(1);
    store.close();
  });

  it("spawns new work for matched webhook registrations targeting the workstream", async () => {
    const { service, codex, store, slack } = await createService();
    service.runtimeStarted = true;
    service.scheduleRegistrationLoop = vi.fn();
    createWorker(service, { workstreamId: "T1:root" });
    const webhookSource = await createWebhookSource(service, { source: "stripe", routeToken: "route-stripe" });
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
        deliveryMode: "queue",
        match: { account: "acct_123" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: {
        event: "invoice.failed",
        dedupeKey: "evt-stripe-1",
        fields: { account: "acct_123" },
        payload: { invoiceId: "in_123" },
      },
      rawBody: "{\"event\":\"invoice.failed\"}",
      receivedAt: "2026-01-01T00:03:00.000Z",
    }));

    expect(result).toMatchObject({ status: 202, body: expect.objectContaining({ matchedRegistrations: 1 }) });
    expect(service.scheduleRegistrationLoop).toHaveBeenCalledWith(0);
    await service.deliverQueuedWakes();

    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "C1",
      expect.stringContaining("Scheduled work: Triage incoming incidents\n\n[system wake event]"),
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
    const webhookSource = await createWebhookSource(service, { source: "github" });
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
        deliveryMode: "queue",
        match: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingestWebhookEvent(makeRawWebhookIngress(webhookSource, {
      parsedJson: { event: "push", dedupeKey: "evt-1", payload: {} },
    }));

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

    await expect(service.registrations.setWebhook(
      {
        teamId: "T1",
        workstream: workstream!,
        worker,
      },
      {
        source: "github",
        events: ["push"],
        target: "self",
      },
    )).rejects.toThrow("Webhook source github does not exist");

    await createWebhookSource(service, { source: "github", enabled: false });
    await expect(service.registrations.setWebhook(
      {
        teamId: "T1",
        workstream: workstream!,
        worker,
      },
      {
        source: "github",
        events: ["push"],
        target: "self",
      },
    )).rejects.toThrow("Webhook source github is disabled");
  });

  it("accepts webhook HTTP ingress through the running service and requests wake scheduling", async () => {
    const { service, store } = await createService();
    await service.start();
    const scheduleSpy = vi.spyOn(service, "scheduleRegistrationLoop");
    scheduleSpy.mockClear();
    createWorker(service, { workstreamId: "T1:root" });
    const source = await createWebhookSource(service, { source: "github", routeToken: "route-http" });
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
        deliveryMode: "queue",
        match: { repo: "acme/api" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const port = service.webhooks.getListeningPort();
    expect(port).not.toBeNull();
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/${source.routeToken}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event: "push",
        dedupeKey: "evt-http-1",
        fields: { repo: "acme/api" },
        payload: { commits: 1 },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      createdEvents: 1,
      matchedRegistrations: 1,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(0);
    expect(store.getWebhookEvent("T1", "github", "push", "evt-http-1")).not.toBeNull();
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")).toHaveLength(1);
    await service.stop();
  });

  it("disables a webhook source", async () => {
    const { service, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    store.createWebhookSource({
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "oldroute",
      handlerPath: "/tmp/linear/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });

    const result = await (service as any).handleDisableWebhookSourceTool({
      source: "linear",
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
    });

    expect(JSON.parse(result)).toMatchObject({
      source: "linear",
      enabled: false,
    });
    expect(store.getWebhookSource("T1", "linear")?.enabled).toBe(false);
    store.close();
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

  it("keeps wake delivery successful when posting the visibility system message fails", async () => {
    const { service, codex, slack, store } = await createService();
    createWorker(service, { workstreamId: "T1:root" });
    codex.reconcileThreadForSend.mockResolvedValue("idle");
    codex.startTurnWithResumeFallback.mockResolvedValue("turn-heartbeat");
    slack.postThreadReply.mockRejectedValueOnce(new Error("slack write failed"));

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

    expect(codex.startTurnWithResumeFallback).toHaveBeenCalledTimes(1);
    expect(store.listPendingWakesForScope("T1", "T1:root", "T1:C1:1.000")[0]).toMatchObject({
      status: "delivered",
    });
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

  it("writes only one durable response item for a worker across later completed turns", async () => {
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
      key: "msg-workstream-once",
      teamId: "T1",
      channelId: "C1",
      messageTs: "7.000",
      rootTs: "7.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-workstream-once");

    const worker = store.getWorker("T1", "C1", "7.000");
    expect(worker?.terminalResponseItemId).toBeNull();

    await service.onWorkerCompleted(worker!.key, "Deploy issue is fixed.", "completed");
    const afterFirst = store.getWorker("T1", "C1", "7.000");
    expect(afterFirst?.terminalResponseItemId).toBeTruthy();

    await service.onWorkerCompleted(worker!.key, "Adding another follow-up reply.", "completed");

    const archivedFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    const responseFiles = archivedFiles.filter((file) => file.startsWith("res-"));
    expect(responseFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.toContain("Deploy issue is fixed.");
    store.close();
  });

  it("does not consume the durable response artifact slot on interruption", async () => {
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
      ts: "8.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-workstream-interrupted",
      teamId: "T1",
      channelId: "C1",
      messageTs: "8.000",
      rootTs: "8.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-workstream-interrupted");

    const worker = store.getWorker("T1", "C1", "8.000");
    await service.onWorkerCompleted(worker!.key, "", "interrupted");

    const afterInterrupted = store.getWorker("T1", "C1", "8.000");
    expect(afterInterrupted?.terminalResponseItemId).toBeNull();

    await service.onWorkerCompleted(worker!.key, "Deploy issue is fixed.", "completed");

    const archivedFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    const responseFiles = archivedFiles.filter((file) => file.startsWith("res-"));
    expect(responseFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.toContain("Deploy issue is fixed.");
    store.close();
  });

  it("writes the one durable response item for a failed first terminal outcome", async () => {
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
      ts: "9.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-workstream-failed",
      teamId: "T1",
      channelId: "C1",
      messageTs: "9.000",
      rootTs: "9.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-workstream-failed");

    const worker = store.getWorker("T1", "C1", "9.000");
    await service.onWorkerCompleted(worker!.key, "", "failed", "boom");

    const afterFailed = store.getWorker("T1", "C1", "9.000");
    expect(afterFailed?.terminalResponseItemId).toBeTruthy();

    const archivedFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    const responseFiles = archivedFiles.filter((file) => file.startsWith("res-"));
    expect(responseFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.toContain("Turn failed. boom");
    store.close();
  });

  it("keeps the first durable failed response artifact when the worker later completes", async () => {
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
      ts: "10.000",
      threadTs: null,
      isDm: false,
      files: [],
    };
    store.createOrGetInboundMessage({
      key: "msg-workstream-failed-then-completed",
      teamId: "T1",
      channelId: "C1",
      messageTs: "10.000",
      rootTs: "10.000",
      kind: "channel-root",
      payloadJson: JSON.stringify(context),
    });

    await service.processInboundMessage("msg-workstream-failed-then-completed");

    const worker = store.getWorker("T1", "C1", "10.000");
    await service.onWorkerCompleted(worker!.key, "", "failed", "boom");
    await service.onWorkerCompleted(worker!.key, "Recovered now.", "completed");

    const archivedFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    const responseFiles = archivedFiles.filter((file) => file.startsWith("res-"));
    expect(responseFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.toContain("Turn failed. boom");
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.not.toContain("Recovered now.");
    store.close();
  });

  it("backfills terminalResponseItemId from an existing archived response artifact without duplicating it", async () => {
    const { dir, service, store } = await createService();
    const worker = createWorker(service, {
      key: "T1:C1:11.000",
      rootTs: "11.000",
      requestItemId: "req-test",
      requestItemPath: path.join(dir, ".slack-workers", "active", "req-test.md"),
      terminalResponseItemId: null,
      workstreamId: "T1:root",
    });
    const responseItemId = "res-test";
    await fs.mkdir(path.join(dir, ".slack-workers", "archive"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".slack-workers", "archive", `${responseItemId}.md`),
      [
        "<!-- slack-workers-item",
        JSON.stringify({
          id: responseItemId,
          kind: "response",
          status: "completed",
          workstream: "root",
          from: "root/T1:C1:11.000",
          to: "root",
          claimed_by: "root/T1:C1:11.000",
          bridge_worker_key: "T1:C1:11.000",
          source_kind: "worker-response",
          source_summary: "response for req-test",
          source_slack_channel_id: "C1",
          source_slack_message_ts: "11.000",
          created_at: "2026-03-18T00:00:00.000Z",
          updated_at: "2026-03-18T00:00:00.000Z",
        }, null, 2),
        "-->",
        "",
        "# Response to req-test",
        "",
        "Existing terminal response.",
        "",
      ].join("\n"),
    );

    await service.onWorkerCompleted(worker.key, "Recovered completion should not rewrite.", "completed");

    const updated = store.getWorkerByKey(worker.key);
    expect(updated?.terminalResponseItemId).toBe(responseItemId);

    const archivedFiles = await fs.readdir(path.join(dir, ".slack-workers", "archive"));
    const responseFiles = archivedFiles.filter((file) => file.startsWith("res-"));
    expect(responseFiles).toEqual([`${responseItemId}.md`]);
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.toContain("Existing terminal response.");
    await expect(fs.readFile(path.join(dir, ".slack-workers", "archive", responseFiles[0]!), "utf8")).resolves.not.toContain("Recovered completion should not rewrite.");
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
    expect(slack.openDmChannel).toHaveBeenCalledWith("U-admin");
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "D-opened",
      expect.stringContaining("Root workstream created: <slack://channel?team=T1&id=C1|Open #general in Slack app>"),
    );
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "D-opened",
      expect.stringContaining("<https://app.slack.com/client/T1/C1|this browser fallback>"),
    );
    expect(slack.postTopLevelMessage).toHaveBeenCalledWith(
      "D-opened",
      expect.stringContaining("Join Channel"),
    );
    await expect(fs.access(path.join(dir, "WORKSTREAM.md"))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).resolves.toContain("WORKSTREAM.md");
    await expect(fs.readFile(path.join(dir, ".slack-workers", "registrations.json"), "utf8")).resolves.toContain("[]");
    await expect(fs.access(path.join(dir, ".slack-workers", "bridge"))).resolves.toBeUndefined();
  });

  it("does not resend the root workstream onboarding DM after the root already exists", async () => {
    const { service, slack } = await createService();

    await service.bootstrapWorkstreams();
    slack.openDmChannel.mockClear();
    slack.postTopLevelMessage.mockClear();

    await service.bootstrapWorkstreams();

    expect(slack.openDmChannel).not.toHaveBeenCalled();
    expect(slack.postTopLevelMessage).not.toHaveBeenCalled();
  });

  it("ignores started work events and posts DM assistant messages without edits", async () => {
    const { service, slack, store } = await createService();
    createDmSession(service, {
      status: "running",
      activeTurnId: "turn-1",
    });

    await service.onDmWorklogItem("T1", "U-admin", "dm-thread-1", {
      itemId: "tool-1",
      type: "webSearch",
      title: "Web Search",
      status: "started",
      detail: "weather: San Francisco, CA",
    });
    await service.onDmAgentMessage("T1", "U-admin", "dm-thread-1", "agent-1", "Checking weather now.");
    await service.onDmCompleted("T1", "U-admin", "dm-thread-1", "Checking weather now.", "completed");

    expect(slack.postTopLevelMessage.mock.calls).toEqual([
      ["D1", "Checking weather now."],
    ]);
    expect(slack.updateMessage).not.toHaveBeenCalled();
    const updated = store.getDmSession("T1", "U-admin");
    expect(updated?.currentAgentSlackTs).toBeNull();
    store.close();
  });
});
