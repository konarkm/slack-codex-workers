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
});
