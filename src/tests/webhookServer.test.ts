import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebhookServerConfig } from "../settings.js";

type AppConfig = WebhookServerConfig & Record<string, unknown>;
import { WebhookIngressServer } from "../webhooks/server.js";
import type { WebhookSourceRecord } from "../types.js";

const activeServers: WebhookIngressServer[] = [];

function makeSource(overrides: Partial<WebhookSourceRecord> = {}): WebhookSourceRecord {
  return {
    id: "src-1",
    teamId: "T1",
    source: "linear",
    routeToken: "route-secret",
    handlerPath: "/tmp/linear/handler.mjs",
    enabled: true,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

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
    showSlackWorklog: false,
    workspaceTimezone: "America/Los_Angeles",
    webhookPort: 0,
    webhookBindHost: "127.0.0.1",
    webhookPath: "/webhooks",
    webhookBodyMaxBytes: 64,
    webhookBodyReadTimeoutMs: 30_000,
    webhookPayloadStorageDir: "/tmp/webhooks",
    webhookPublicBaseUrl: "https://hooks.example.test",
    webhookTrustLoopbackProxy: false,
    ...overrides,
  };
}

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop();
  }
});

describe("webhook ingress server", () => {
  it("rejects non-post methods", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`);
    expect(response.status).toBe(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns not_found for unknown routes", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), () => null, handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/unknown`, {
      method: "POST",
      body: "hello",
    });

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never blocks a client for hits on unknown webhook URLs", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), () => null, handler);
    activeServers.push(server);
    await server.start();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/unknown`, { method: "POST", body: "hello" });
      expect(response.status).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns not_found for disabled sources", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), () => makeSource({ enabled: false }), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      body: "hello",
    });

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces the webhook body limit before calling the handler", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(makeConfig(), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(512) }),
    });

    expect(response.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("forwards authenticated route traffic to the handler with best-effort JSON parsing", async () => {
    const handler = vi.fn().mockResolvedValue({
      status: 202,
      body: { ok: true, emittedEvents: 1 },
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linear-signature": "sig",
      },
      body: JSON.stringify({ action: "Issue", data: { id: "LIN-123" } }),
    });

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ source: "linear", routeToken: "route-secret" }),
      routePath: "/webhooks/route-secret",
      parsedJson: { action: "Issue", data: { id: "LIN-123" } },
      rawBody: expect.stringContaining("\"Issue\""),
      headers: expect.objectContaining({
        "content-type": "application/json",
        "x-linear-signature": "sig",
      }),
    }));
  });

  it("still forwards non-json bodies with parsedJson set to null", async () => {
    const handler = vi.fn().mockResolvedValue({
      status: 202,
      body: { ok: true, emittedEvents: 0 },
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw=payload&sig=abc",
    });

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      parsedJson: null,
      rawBody: "raw=payload&sig=abc",
    }));
  });

  it("rate limits repeated handler auth failures from the same client", async () => {
    const handler = vi.fn().mockResolvedValue({
      status: 401,
      body: { ok: false, error: "signature_invalid" },
    });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();

    let response: Response | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
    }

    response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(429);
  });

  it("counts failed auth per client and per source URL, so one sender's failures do not block another source", async () => {
    const handler = vi.fn().mockResolvedValue({ status: 401, body: { ok: false } });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024 }), (token) => makeSource({ routeToken: token }), handler);
    activeServers.push(server);
    await server.start();
    const post = (token: string) => fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/${token}`, { method: "POST", body: "{}" });

    for (let attempt = 0; attempt < 10; attempt += 1) expect((await post("route-a")).status).toBe(401);
    expect((await post("route-a")).status).toBe(429);
    expect((await post("route-b")).status).toBe(401);
  });

  it("keys clients behind the tunnel by cf-connecting-ip, never by the x-forwarded-for a client can set", async () => {
    const handler = vi.fn().mockResolvedValue({ status: 401, body: { ok: false } });
    const server = new WebhookIngressServer(makeConfig({ webhookBodyMaxBytes: 1024, webhookTrustLoopbackProxy: true }), () => makeSource(), handler);
    activeServers.push(server);
    await server.start();
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, { method: "POST", headers, body: "{}" });

    // A new x-forwarded-for on every try does not escape the block.
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await post({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": `203.0.113.${attempt}` })).status).toBe(401);
    expect((await post({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.99" })).status).toBe(429);
    expect((await post({ "cf-connecting-ip": "198.51.100.2" })).status).toBe(401);
    // Without the tunnel's header the client is the proxy's own address, whatever x-forwarded-for says.
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await post({ "x-forwarded-for": `192.0.2.${attempt}` })).status).toBe(401);
    expect((await post({ "x-forwarded-for": "192.0.2.99" })).status).toBe(429);
  });

  it("forgets clients whose auth failures have expired, even if they never come back", async () => {
    const server = new WebhookIngressServer(makeConfig({ webhookTrustLoopbackProxy: true }), () => makeSource(), vi.fn().mockResolvedValue({ status: 401, body: { ok: false } }));
    activeServers.push(server);
    await server.start();
    const miss = (client: string) =>
      fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, { method: "POST", headers: { "cf-connecting-ip": client }, body: "{}" });
    const failures = (server as unknown as { authFailures: Map<string, unknown> }).authFailures;

    for (let client = 0; client < 20; client += 1) expect((await miss(`198.51.100.${client}`)).status).toBe(401);
    expect(failures.size).toBe(20);

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000);
    try {
      await miss("203.0.113.1");
    } finally {
      clock.mockRestore();
    }
    expect([...failures.keys()]).toEqual(["203.0.113.1 route-secret"]);
  });

  it("returns shutting_down before invoking the handler when ingress is closed", async () => {
    const handler = vi.fn();
    const server = new WebhookIngressServer(
      makeConfig({ webhookBodyMaxBytes: 1024 }),
      () => makeSource(),
      handler,
      () => false,
    );
    activeServers.push(server);
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.getListeningPort()}/webhooks/route-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
