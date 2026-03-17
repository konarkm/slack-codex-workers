import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { WebhookIngressServer } from "../webhooks/server.js";

const activeServers: WebhookIngressServer[] = [];

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "unused",
    codexBin: "codex",
    workspaceRoot: process.cwd(),
    databasePath: "/tmp/test.db",
    adminUserIds: ["U-admin"],
    allowedTeamId: null,
    messageEditThrottleMs: 1,
    appPort: 3013,
    supervisorRestartEnabled: false,
    launchMode: "dev",
    attachmentStorageDir: "/tmp/attachments",
    attachmentMaxBytes: 1024 * 1024 * 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 600_000,
    attachmentRetentionMs: null,
    slackUploadTimeoutMs: 600_000,
    slackUploadMaxFiles: 10,
    workspaceTimezone: "America/Los_Angeles",
    webhookPort: 0,
    webhookPath: "/webhooks",
    webhookBodyMaxBytes: 64,
    webhookPayloadStorageDir: "/tmp/webhooks",
    webhookSourceSecrets: { github: "secret-github" },
    ...overrides,
  };
}

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop();
  }
});

describe("webhook ingress server", () => {
  it("rejects unauthorized requests", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "push" }),
    });

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects encoded webhook sources that would escape the payload root", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/%2Ftmp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({ event: "push" }),
    });

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("still returns auth failure before exposing shutdown state", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(
      makeConfig(),
      handler,
      () => false,
    );
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "push" }),
    });

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces the webhook body limit", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({
        event: "push",
        payload: { text: "x".repeat(512) },
      }),
    });

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("normalizes authenticated requests and forwards them to the handler", async () => {
    const handler = vi.fn().mockResolvedValue({
      duplicate: false,
      matchedRegistrations: 2,
      eventId: "evt-1",
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({
        id: "delivery-1",
        event: "push",
        match: { repo: "acme/api", branch: "main", dropped: 1 },
        payload: { commits: 3 },
      }),
    });

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      source: "github",
      event: "push",
      dedupeKey: "delivery-1",
      match: { repo: "acme/api", branch: "main" },
      payload: { commits: 3 },
      rawBody: expect.stringContaining("\"event\":\"push\""),
    }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      matchedRegistrations: 2,
      eventId: "evt-1",
    });
  });

  it("accepts case-insensitive bearer auth and produces stable fallback ids for equivalent JSON", async () => {
    const handler = vi.fn().mockResolvedValue({
      duplicate: false,
      matchedRegistrations: 0,
      eventId: "evt-1",
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), handler);
    activeServers.push(server);
    await server.start();

    const first = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "bearer secret-github",
      },
      body: JSON.stringify({
        event: "push",
        payload: { b: 2, a: 1 },
      }),
    });
    const second = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({
        payload: { a: 1, b: 2 },
        event: "push",
      }),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0].dedupeKey).toBe(handler.mock.calls[1]?.[0].dedupeKey);
  });

  it("rejects requests while the runtime is shutting down", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(
      makeConfig({ webhookBodyMaxBytes: 1024 }),
      handler,
      () => false,
    );
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({ event: "push" }),
    });

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps shutdown races in the handler to a fail-closed 503", async () => {
    const handler = vi.fn().mockImplementation(async () => {
      const error = new Error("Webhook ingress unavailable during shutdown.") as Error & { code: string };
      error.code = "WEBHOOK_SHUTDOWN";
      throw error;
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-github",
      },
      body: JSON.stringify({ event: "push" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "shutting_down" });
  });
});
