import { describe, expect, it, vi } from "vitest";
import { CodexClient } from "../codex/client.js";

describe("codex client dynamic tool routing", () => {
  it("routes get_current_time through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const getCurrentTime = vi.fn().mockResolvedValue("current_time_utc: 2026-03-16T22:45:30.000Z");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { getCurrentTime };

    await client.handleDynamicToolCall("req-1", {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "get_current_time",
      arguments: {},
    });

    expect(getCurrentTime).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
    });
    expect(respond).toHaveBeenCalledWith("req-1", {
      contentItems: [{ type: "inputText", text: "current_time_utc: 2026-03-16T22:45:30.000Z" }],
      success: true,
    });
  });

  it("routes get_webhook_mailbox through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const getWebhookMailbox = vi.fn().mockResolvedValue("webhook_public_url: https://hooks.example.test/webhooks");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { getWebhookMailbox };

    await client.handleDynamicToolCall("req-2", {
      threadId: "thread-2",
      turnId: "turn-2",
      callId: "call-2",
      tool: "get_webhook_mailbox",
      arguments: {},
    });

    expect(getWebhookMailbox).toHaveBeenCalledWith({
      threadId: "thread-2",
      turnId: "turn-2",
      callId: "call-2",
    });
    expect(respond).toHaveBeenCalledWith("req-2", {
      contentItems: [{ type: "inputText", text: "webhook_public_url: https://hooks.example.test/webhooks" }],
      success: true,
    });
  });

  it("routes rotate_webhook_secret through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rotateWebhookSecret = vi.fn().mockResolvedValue("webhook_shared_secret: rotated-secret");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { rotateWebhookSecret };

    await client.handleDynamicToolCall("req-3", {
      threadId: "thread-3",
      turnId: "turn-3",
      callId: "call-3",
      tool: "rotate_webhook_secret",
      arguments: {},
    });

    expect(rotateWebhookSecret).toHaveBeenCalledWith({
      threadId: "thread-3",
      turnId: "turn-3",
      callId: "call-3",
    });
    expect(respond).toHaveBeenCalledWith("req-3", {
      contentItems: [{ type: "inputText", text: "webhook_shared_secret: rotated-secret" }],
      success: true,
    });
  });

  it("routes set_notification through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const setNotification = vi.fn().mockResolvedValue("Notifications enabled for this turn.");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { setNotification };

    await client.handleDynamicToolCall("req-3b", {
      threadId: "thread-3b",
      turnId: "turn-3b",
      callId: "call-3b",
      tool: "set_notification",
      arguments: { enabled: true },
    });

    expect(setNotification).toHaveBeenCalledWith({
      enabled: true,
    }, {
      threadId: "thread-3b",
      turnId: "turn-3b",
      callId: "call-3b",
    });
    expect(respond).toHaveBeenCalledWith("req-3b", {
      contentItems: [{ type: "inputText", text: "Notifications enabled for this turn." }],
      success: true,
    });
  });

  it("routes list_registrations_admin through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const adminListRegistrations = vi.fn().mockResolvedValue("reg-1 [enabled] webhook -> spawn (workstream)");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { adminListRegistrations };

    await client.handleDynamicToolCall("req-4", {
      threadId: "thread-4",
      turnId: "turn-4",
      callId: "call-4",
      tool: "list_registrations_admin",
      arguments: { workstream: "ops-debug" },
    });

    expect(adminListRegistrations).toHaveBeenCalledWith({
      workstream: "ops-debug",
    }, {
      threadId: "thread-4",
      turnId: "turn-4",
      callId: "call-4",
    });
    expect(respond).toHaveBeenCalledWith("req-4", {
      contentItems: [{ type: "inputText", text: "reg-1 [enabled] webhook -> spawn (workstream)" }],
      success: true,
    });
  });

  it("routes get_registration_admin through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const adminGetRegistration = vi.fn().mockResolvedValue("{\"id\":\"reg-1\"}");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { adminGetRegistration };

    await client.handleDynamicToolCall("req-5", {
      threadId: "thread-5",
      turnId: "turn-5",
      callId: "call-5",
      tool: "get_registration_admin",
      arguments: { registrationId: "reg-1" },
    });

    expect(adminGetRegistration).toHaveBeenCalledWith({
      registrationId: "reg-1",
    }, {
      threadId: "thread-5",
      turnId: "turn-5",
      callId: "call-5",
    });
    expect(respond).toHaveBeenCalledWith("req-5", {
      contentItems: [{ type: "inputText", text: "{\"id\":\"reg-1\"}" }],
      success: true,
    });
  });

  it("routes disable_registration_admin through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const adminDisableRegistration = vi.fn().mockResolvedValue("Disabled registration reg-1.");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { adminDisableRegistration };

    await client.handleDynamicToolCall("req-6", {
      threadId: "thread-6",
      turnId: "turn-6",
      callId: "call-6",
      tool: "disable_registration_admin",
      arguments: { registrationId: "reg-1" },
    });

    expect(adminDisableRegistration).toHaveBeenCalledWith({
      registrationId: "reg-1",
    }, {
      threadId: "thread-6",
      turnId: "turn-6",
      callId: "call-6",
    });
    expect(respond).toHaveBeenCalledWith("req-6", {
      contentItems: [{ type: "inputText", text: "Disabled registration reg-1." }],
      success: true,
    });
  });

  it("routes list_wake_deliveries_admin through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const adminListWakeDeliveries = vi.fn().mockResolvedValue("wake-1 delivered registration=reg-1");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { adminListWakeDeliveries };

    await client.handleDynamicToolCall("req-7", {
      threadId: "thread-7",
      turnId: "turn-7",
      callId: "call-7",
      tool: "list_wake_deliveries_admin",
      arguments: { workstream: "ops-debug", registrationId: "reg-1" },
    });

    expect(adminListWakeDeliveries).toHaveBeenCalledWith({
      workstream: "ops-debug",
      registrationId: "reg-1",
    }, {
      threadId: "thread-7",
      turnId: "turn-7",
      callId: "call-7",
    });
    expect(respond).toHaveBeenCalledWith("req-7", {
      contentItems: [{ type: "inputText", text: "wake-1 delivered registration=reg-1" }],
      success: true,
    });
  });

  it("routes archive_workstream_admin through the dynamic tool handler", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const adminArchiveWorkstream = vi.fn().mockResolvedValue("Archived workstream ops-debug.");
    const client = Object.create(CodexClient.prototype) as any;
    client.rpc = { respond };
    client.dynamicToolHandlers = { adminArchiveWorkstream };

    await client.handleDynamicToolCall("req-8", {
      threadId: "thread-8",
      turnId: "turn-8",
      callId: "call-8",
      tool: "archive_workstream_admin",
      arguments: { workstream: "ops-debug" },
    });

    expect(adminArchiveWorkstream).toHaveBeenCalledWith({
      workstream: "ops-debug",
    }, {
      threadId: "thread-8",
      turnId: "turn-8",
      callId: "call-8",
    });
    expect(respond).toHaveBeenCalledWith("req-8", {
      contentItems: [{ type: "inputText", text: "Archived workstream ops-debug." }],
      success: true,
    });
  });

  it("maps successful contextCompaction notifications to started/completed compaction events", async () => {
    const compactionHandler = vi.fn().mockResolvedValue(undefined);
    const client = Object.create(CodexClient.prototype) as any;
    client.activeTurns = new Map();
    client.compactionHandler = compactionHandler;

    await client.handleNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: { id: "compact-1", type: "contextCompaction" },
      },
    });
    await client.handleNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "compact-1", type: "contextCompaction", status: "completed" },
      },
    });

    expect(compactionHandler.mock.calls).toEqual([
      [{ threadId: "thread-1", itemId: "compact-1", status: "started" }],
      [{ threadId: "thread-1", itemId: "compact-1", status: "completed" }],
    ]);
  });

  it("maps failed contextCompaction completions to failed compaction events", async () => {
    const compactionHandler = vi.fn().mockResolvedValue(undefined);
    const client = Object.create(CodexClient.prototype) as any;
    client.activeTurns = new Map();
    client.compactionHandler = compactionHandler;

    await client.handleNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "compact-1", type: "contextCompaction", status: "failed", error: { message: "boom" } },
      },
    });

    expect(compactionHandler).toHaveBeenCalledWith({
      threadId: "thread-1",
      itemId: "compact-1",
      status: "failed",
    });
  });
});
