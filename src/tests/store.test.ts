import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

  it("stores webhook source definitions", async () => {
    const { store } = await createStore();
    store.createWebhookSource({
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "route-123",
      handlerPath: "/tmp/linear/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });

    expect(store.getWebhookSource("T1", "linear")).toEqual({
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "route-123",
      handlerPath: "/tmp/linear/handler.mjs",
      enabled: true,
      createdAt: "2026-03-17T00:00:00.000Z",
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
      settings: { model: "gpt-5.5", effort: "high", fastMode: true },
      identity: { username: "Gear", iconEmoji: "gear" },
      parentWorkerKey: null,
      requestItemId: null,
      requestItemPath: null,
      terminalResponseItemId: null,
      threadNotificationEnabled: true,
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
      threadNotificationEnabled: false,
      lastError: null,
      pendingRequest: null,
    });

    const worker = store.getWorkerByKey("worker-1");
    expect(worker?.activeTurnId).toBeNull();
    expect(worker?.currentAgentSlackTs).toBeNull();
    expect(worker?.currentAgentItemId).toBeNull();
    expect(worker?.currentWorklogSlackTs).toBeNull();
    expect(worker?.threadNotificationEnabled).toBe(false);
    expect(worker?.lastError).toBeNull();
    expect(worker?.pendingRequest).toBeNull();
    expect(worker?.settings.fastMode).toBe(true);
    store.close();
  });

  it("backfills thread notification state from active legacy turn rows only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-store-legacy-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "legacy.db");
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE workers (
        key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_ts TEXT NOT NULL,
        workstream_id TEXT,
        app_thread_id TEXT NOT NULL,
        active_turn_id TEXT,
        owner_user_id TEXT NOT NULL,
        root_owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        identity_json TEXT,
        parent_worker_key TEXT,
        request_item_id TEXT,
        request_item_path TEXT,
        terminal_response_item_id TEXT,
        turn_notification_turn_id TEXT,
        turn_notification_enabled INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_inbound_message_ts TEXT,
        pending_request_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, channel_id, root_ts)
      );
    `);
    const insert = legacyDb.prepare(`
      INSERT INTO workers (
        key, team_id, channel_id, root_ts, workstream_id, app_thread_id, active_turn_id, owner_user_id, root_owner_user_id,
        status, current_agent_slack_ts, current_agent_item_id, current_worklog_slack_ts, settings_json, identity_json,
        parent_worker_key, request_item_id, request_item_path, terminal_response_item_id, turn_notification_turn_id, turn_notification_enabled,
        last_error, last_inbound_message_ts, pending_request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "worker-active",
      "T1",
      "C1",
      "1.000",
      null,
      "thread-1",
      "turn-1",
      "U1",
      "U1",
      "running",
      null,
      null,
      null,
      JSON.stringify({ model: "gpt-5.5", effort: "high", fastMode: false }),
      null,
      null,
      null,
      null,
      null,
      "turn-1",
      0,
      null,
      null,
      null,
      "2026-03-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
    );
    insert.run(
      "worker-idle",
      "T1",
      "C1",
      "2.000",
      null,
      "thread-2",
      null,
      "U1",
      "U1",
      "idle",
      null,
      null,
      null,
      JSON.stringify({ model: "gpt-5.5", effort: "high", fastMode: false }),
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      "2026-03-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
    );
    legacyDb.close();

    const store = new Store(databasePath);
    expect(store.getWorkerByKey("worker-active")?.threadNotificationEnabled).toBe(false);
    expect(store.getWorkerByKey("worker-idle")?.threadNotificationEnabled).toBe(true);
    store.close();
  });

  it("preserves explicit thread notification values when the column already exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-store-legacy-existing-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "legacy-existing.db");
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE workers (
        key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_ts TEXT NOT NULL,
        workstream_id TEXT,
        app_thread_id TEXT NOT NULL,
        active_turn_id TEXT,
        owner_user_id TEXT NOT NULL,
        root_owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        identity_json TEXT,
        parent_worker_key TEXT,
        request_item_id TEXT,
        request_item_path TEXT,
        terminal_response_item_id TEXT,
        thread_notification_enabled INTEGER NOT NULL DEFAULT 1,
        turn_notification_turn_id TEXT,
        turn_notification_enabled INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_inbound_message_ts TEXT,
        pending_request_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, channel_id, root_ts)
      );
    `);
    const insert = legacyDb.prepare(`
      INSERT INTO workers (
        key, team_id, channel_id, root_ts, workstream_id, app_thread_id, active_turn_id, owner_user_id, root_owner_user_id,
        status, current_agent_slack_ts, current_agent_item_id, current_worklog_slack_ts, settings_json, identity_json,
        parent_worker_key, request_item_id, request_item_path, terminal_response_item_id, thread_notification_enabled,
        turn_notification_turn_id, turn_notification_enabled, last_error, last_inbound_message_ts, pending_request_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "worker-explicit-on",
      "T1",
      "C1",
      "1.000",
      null,
      "thread-1",
      "turn-1",
      "U1",
      "U1",
      "running",
      null,
      null,
      null,
      JSON.stringify({ model: "gpt-5.5", effort: "high", fastMode: false }),
      null,
      null,
      null,
      null,
      null,
      1,
      "turn-1",
      0,
      null,
      null,
      null,
      "2026-03-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
    );
    insert.run(
      "worker-mismatch",
      "T1",
      "C1",
      "2.000",
      null,
      "thread-2",
      "turn-live",
      "U1",
      "U1",
      "running",
      null,
      null,
      null,
      JSON.stringify({ model: "gpt-5.5", effort: "high", fastMode: false }),
      null,
      null,
      null,
      null,
      null,
      1,
      "turn-stale",
      0,
      null,
      null,
      null,
      "2026-03-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
    );
    insert.run(
      "worker-explicit-off",
      "T1",
      "C1",
      "3.000",
      null,
      "thread-3",
      "turn-3",
      "U1",
      "U1",
      "running",
      null,
      null,
      null,
      JSON.stringify({ model: "gpt-5.5", effort: "high", fastMode: false }),
      null,
      null,
      null,
      null,
      null,
      0,
      "turn-3",
      1,
      null,
      null,
      null,
      "2026-03-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
    );
    legacyDb.close();

    const store = new Store(databasePath);
    expect(store.getWorkerByKey("worker-explicit-on")?.threadNotificationEnabled).toBe(true);
    expect(store.getWorkerByKey("worker-mismatch")?.threadNotificationEnabled).toBe(true);
    expect(store.getWorkerByKey("worker-explicit-off")?.threadNotificationEnabled).toBe(false);
    store.close();
  });

  it("stores team fast-mode defaults", async () => {
    const { store } = await createStore();
    expect(store.getTeamDefaults("T1")).toMatchObject({
      model: "gpt-5.5",
      effort: "medium",
      fastMode: false,
    });

    store.setTeamDefaults("T1", {
      model: "gpt-5.5",
      effort: "high",
      fastMode: true,
    });

    expect(store.getTeamDefaults("T1")).toEqual({
      model: "gpt-5.5",
      effort: "high",
      fastMode: true,
    });
    store.close();
  });

  it("normalizes incompatible persisted team fast-mode defaults on read", async () => {
    const { store } = await createStore();
    store.setTeamDefaults("T1", {
      model: "gpt-5.3",
      effort: "medium",
      fastMode: true,
    });

    expect(store.getTeamDefaults("T1")).toEqual({
      model: "gpt-5.3",
      effort: "medium",
      fastMode: false,
    });
    expect(store.getTeamDefaults("T1")).toEqual({
      model: "gpt-5.3",
      effort: "medium",
      fastMode: false,
    });
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
      archivedAt: null,
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

  it("hides archived workstreams from active lookups while preserving archived lookup access", async () => {
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
      archivedAt: null,
    });
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

    const archived = store.archiveWorkstream("T1:ops", "2026-03-18T12:00:00.000Z");
    expect(archived).toMatchObject({ archivedAt: "2026-03-18T12:00:00.000Z" });
    expect(store.getWorkstreamById("T1:ops")).toBeNull();
    expect(store.getWorkstreamByRelativePath("T1", "ops")).toBeNull();
    expect(store.getWorkstreamByChannel("T1", "C-ops")).toBeNull();
    expect(store.listWorkstreams("T1").map((workstream) => workstream.relativePath)).toEqual(["", "ops/child"]);
    expect(store.listWorkstreams("T1", { includeArchived: true }).map((workstream) => workstream.relativePath)).toEqual(["", "ops", "ops/child"]);
    expect(store.listChildWorkstreams("T1:root").map((workstream) => workstream.relativePath)).toEqual([]);
    expect(store.listChildWorkstreams("T1:root", { includeArchived: true }).map((workstream) => workstream.relativePath)).toEqual(["ops"]);
    expect(store.getWorkstreamById("T1:ops", { includeArchived: true })).toMatchObject({
      relativePath: "ops",
      archivedAt: "2026-03-18T12:00:00.000Z",
    });
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
      fields: { repo: "acme/api" },
      rawRequestPath: "/tmp/raw-1.json",
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
      fields: { repo: "acme/api" },
      rawRequestPath: "/tmp/raw-2.json",
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
      fields: { repo: "acme/api" },
      rawRequestPath: "/tmp/raw-3.json",
      payloadPath: "/tmp/payload-3.json",
      summary: "github/pull_request",
    }, []);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(true);
    expect(second.record).toMatchObject({
      id: "evt-1",
      payloadPath: "/tmp/payload-1.json",
      fields: { repo: "acme/api" },
      rawRequestPath: "/tmp/raw-1.json",
    });
    expect(store.listPendingWakesForScope("T1", "T1:root", "worker-1")).toHaveLength(1);
    store.close();
  });
});
