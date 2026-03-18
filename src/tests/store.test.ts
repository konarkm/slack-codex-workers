import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../db/store.js";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: Store; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-store-"));
  tempDirs.push(dir);
  return {
    dir,
    store: new Store(path.join(dir, "test.db")),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("store", () => {
  it("stores and consumes pending restart metadata", async () => {
    const { store } = await createStore();
    store.setPendingRestart({
      target: "both",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      requestedAt: "2026-03-12T00:00:00.000Z",
    });
    expect(store.getPendingRestart()).toMatchObject({
      target: "both",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
    });

    store.setPendingRestartNotice({
      target: "bridge",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      requestedAt: "2026-03-12T00:00:01.000Z",
    });
    expect(store.consumePendingRestartNotice()).toMatchObject({
      target: "bridge",
      teamId: "T1",
    });
    expect(store.consumePendingRestartNotice()).toBeNull();

    store.clearPendingRestart();
    expect(store.getPendingRestart()).toBeNull();
    store.close();
  });

  it("stores webhook mailbox state in metadata", async () => {
    const { store } = await createStore();
    store.setWebhookMailboxState({
      currentSecret: "secret-current",
      previousSecret: "secret-previous",
      previousSecretExpiresAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });

    expect(store.getWebhookMailboxState()).toEqual({
      currentSecret: "secret-current",
      previousSecret: "secret-previous",
      previousSecretExpiresAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    store.close();
  });

  it("clears nullable worker fields when explicitly set to null", async () => {
    const { store } = await createStore();
    store.upsertWorker({
      key: "worker-1",
      teamId: "T1",
      channelId: "C1",
      rootTs: "1.000",
      workstreamId: null,
      appThreadId: "thread-1",
      activeTurnId: "turn-1",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      status: "running",
      currentAgentSlackTs: "2.000",
      currentAgentItemId: "item-1",
      currentWorklogSlackTs: "3.000",
      settings: { model: "gpt-5.4", effort: "high" },
      identity: { username: "Gear", iconEmoji: "gear" },
      parentWorkerKey: null,
      requestItemId: null,
      requestItemPath: null,
      lastError: "oops",
      lastInboundMessageTs: "4.000",
      pendingRequest: {
        kind: "tool_user_input",
        requestId: "req-1",
        promptText: "Need input",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questionIds: ["q1"],
        schemaJson: null,
        createdAt: new Date().toISOString(),
      },
    });

    store.updateWorkerState("worker-1", {
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      lastError: null,
      pendingRequest: null,
    });

    const worker = store.getWorkerByKey("worker-1");
    expect(worker?.activeTurnId).toBeNull();
    expect(worker?.currentAgentSlackTs).toBeNull();
    expect(worker?.currentAgentItemId).toBeNull();
    expect(worker?.currentWorklogSlackTs).toBeNull();
    expect(worker?.lastError).toBeNull();
    expect(worker?.pendingRequest).toBeNull();
    store.close();
  });

  it("replays only retryable inbound failures and refreshes payload on duplicate create", async () => {
    const { store } = await createStore();
    store.createOrGetInboundMessage({
      key: "msg-1",
      teamId: "T1",
      channelId: "C1",
      messageTs: "1.000",
      rootTs: "1.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "old" }),
    });
    store.markInboundMessageFailed("msg-1", "temporary");

    store.createOrGetInboundMessage({
      key: "msg-1",
      teamId: "T1",
      channelId: "C1",
      messageTs: "1.000",
      rootTs: "1.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "new" }),
    });

    store.createOrGetInboundMessage({
      key: "msg-2",
      teamId: "T1",
      channelId: "C1",
      messageTs: "2.000",
      rootTs: "2.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "reject" }),
    });
    store.markInboundMessageRejected("msg-2", "manual");

    const replayable = store.listReplayableInboundMessages();
    expect(replayable.map((record) => record.key)).toContain("msg-1");
    expect(replayable.map((record) => record.key)).not.toContain("msg-2");
    expect(store.getInboundMessage("msg-1")?.payloadJson).toContain("new");
    store.close();
  });

  it("stores registrations and disables them without deleting them", async () => {
    const { store } = await createStore();
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

    store.upsertRegistration({
      id: "reg-1",
      teamId: "T1",
      workstreamId: "T1:root",
      workerKey: "worker-1",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: "Check backlog",
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: "T1:root",
        workerKey: "worker-1",
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "heartbeat",
        intervalMinutes: 30,
      },
    });

    expect(store.listRegistrationsForScope("T1", "T1:root", "worker-1")).toHaveLength(1);
    expect(store.getRegistration("reg-1")).toMatchObject({
      enabled: true,
      trigger: { kind: "heartbeat", intervalMinutes: 30 },
    });

    store.disableRegistration("reg-1");
    expect(store.getRegistration("reg-1")).toMatchObject({ enabled: false });
    store.close();
  });

  it("lists pending wakes across a team for admin views", async () => {
    const { store } = await createStore();
    store.createPendingWake({
      id: "wake-1",
      teamId: "T1",
      registrationId: "reg-1",
      workstreamId: "T1:root",
      workerKey: "worker-1",
      status: "delivered",
      summary: "wake one",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    store.createPendingWake({
      id: "wake-2",
      teamId: "T2",
      registrationId: "reg-2",
      workstreamId: "T2:root",
      workerKey: null,
      status: "queued",
      summary: "wake two",
      payloadPath: null,
      firedEvent: null,
      dueAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });

    expect(store.listPendingWakesForTeam("T1").map((wake) => wake.id)).toEqual(["wake-1"]);
    store.close();
  });

  it("derives registration scope columns from the target payload", async () => {
    const { store } = await createStore();
    store.upsertRegistration({
      id: "reg-2",
      teamId: "T1",
      workstreamId: "wrong",
      workerKey: "wrong-worker",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      description: null,
      enabled: true,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
      action: { kind: "spawn" },
      trigger: {
        kind: "cron",
        schedule: "* * * * *",
        timezone: "UTC",
      },
    });

    expect(store.getRegistration("reg-2")).toMatchObject({
      workstreamId: "T1:root",
      workerKey: null,
      target: {
        kind: "workstream",
        workstreamId: "T1:root",
        workerKey: null,
      },
    });
    store.close();
  });

  it("dedupes webhook events by source, event, and dedupe key while atomically creating wakes", async () => {
    const { store } = await createStore();
    const first = store.createWebhookEventWithPendingWakesIfAbsent({
      id: "evt-1",
      teamId: "T1",
      source: "github",
      event: "push",
      dedupeKey: "delivery-1",
      match: { repo: "acme/api" },
      payloadPath: "/tmp/payload-1.json",
      summary: "github/push",
    }, [{
      id: "wake-1",
      teamId: "T1",
      registrationId: "reg-1",
      workstreamId: "T1:root",
      workerKey: "worker-1",
      status: "queued",
      summary: "webhook github/push fired",
      payloadPath: "/tmp/payload-1.json",
      firedEvent: "push",
      dueAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    }]);
    const second = store.createWebhookEventWithPendingWakesIfAbsent({
      id: "evt-2",
      teamId: "T1",
      source: "github",
      event: "push",
      dedupeKey: "delivery-1",
      match: { repo: "acme/api" },
      payloadPath: "/tmp/payload-2.json",
      summary: "github/push",
    }, [{
      id: "wake-2",
      teamId: "T1",
      registrationId: "reg-1",
      workstreamId: "T1:root",
      workerKey: "worker-1",
      status: "queued",
      summary: "webhook github/push fired",
      payloadPath: "/tmp/payload-2.json",
      firedEvent: "push",
      dueAt: "2026-01-01T00:00:01.000Z",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    }]);
    const third = store.createWebhookEventWithPendingWakesIfAbsent({
      id: "evt-3",
      teamId: "T1",
      source: "github",
      event: "pull_request",
      dedupeKey: "delivery-1",
      match: { repo: "acme/api" },
      payloadPath: "/tmp/payload-3.json",
      summary: "github/pull_request",
    }, []);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(true);
    expect(second.record).toMatchObject({
      id: "evt-1",
      payloadPath: "/tmp/payload-1.json",
      match: { repo: "acme/api" },
    });
    expect(store.listPendingWakesForScope("T1", "T1:root", "worker-1")).toHaveLength(1);
    store.close();
  });
});
