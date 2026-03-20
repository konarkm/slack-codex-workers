import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWebhookHandler } from "../webhooks/handlers.js";
import type { WebhookSourceRecord } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function writeHandler(contents: string): Promise<{ source: WebhookSourceRecord; path: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-webhook-handler-"));
  tempDirs.push(dir);
  const handlerPath = path.join(dir, "handler.mjs");
  await fs.writeFile(handlerPath, contents);
  return {
    path: handlerPath,
    source: {
      id: "src-1",
      teamId: "T1",
      source: "linear",
      routeToken: "route-1",
      handlerPath,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("webhook handlers", () => {
  it("loads a handler module and normalizes events", async () => {
    const { source } = await writeHandler(`
      export async function normalizeWebhook(ctx) {
        return {
          outcome: "events",
          events: [{
            event: "issue.updated",
            dedupeKey: "evt-1",
            fields: { issue_id: "LIN-123" },
            payload: { ok: true },
          }],
        };
      }
    `);

    const result = await runWebhookHandler(source, {
      routePath: "/webhooks/route-1",
      method: "POST",
      url: "https://hooks.example.test/webhooks/route-1",
      headers: {},
      rawBody: "{}",
      parsedJson: {},
      receivedAt: "2026-01-01T00:00:00.000Z",
      remoteAddress: "127.0.0.1",
    });

    expect(result).toEqual({
      outcome: "events",
      events: [{
        event: "issue.updated",
        dedupeKey: "evt-1",
        fields: { issue_id: "LIN-123" },
        payload: { ok: true },
        summary: null,
      }],
    });
  });

  it("rejects handler modules without normalizeWebhook or default export", async () => {
    const { source } = await writeHandler(`export const nope = true;`);

    await expect(runWebhookHandler(source, {
      routePath: "/webhooks/route-1",
      method: "POST",
      url: "https://hooks.example.test/webhooks/route-1",
      headers: {},
      rawBody: "{}",
      parsedJson: {},
      receivedAt: "2026-01-01T00:00:00.000Z",
      remoteAddress: "127.0.0.1",
    })).rejects.toThrow("must export normalizeWebhook");
  });

  it("rejects malformed handler results", async () => {
    const { source } = await writeHandler(`
      export async function normalizeWebhook() {
        return {
          outcome: "events",
          events: [{ event: "issue.updated", dedupeKey: "evt-1", fields: 123 }],
        };
      }
    `);

    await expect(runWebhookHandler(source, {
      routePath: "/webhooks/route-1",
      method: "POST",
      url: "https://hooks.example.test/webhooks/route-1",
      headers: {},
      rawBody: "{}",
      parsedJson: {},
      receivedAt: "2026-01-01T00:00:00.000Z",
      remoteAddress: "127.0.0.1",
    })).rejects.toThrow("fields must be a string map");
  });
});
