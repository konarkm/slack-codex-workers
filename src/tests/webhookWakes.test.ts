import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agents/agentStore.js";
import { WebhookWakes, buildWebhookTools, matchesSubscription, toSourceRecord } from "../agents/webhookWakes.js";
import type { RawWebhookIngress } from "../webhooks/server.js";

let dir: string;
let store: AgentStore;
let delivered: Array<{ agent: string; sourceKey: string; text: string }>;
let wakes: WebhookWakes;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-wakes-"));
  store = new AgentStore(":memory:");
  delivered = [];
  wakes = new WebhookWakes(store, { storageDir: dir, webhookPath: "/webhooks", publicBaseUrl: "https://hooks.example.com" }, async (agent, item) => void delivered.push({ agent, ...item }));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function tool(agent: string, name: string) {
  return buildWebhookTools(agent, store, wakes).find((candidate) => candidate.name === name)!;
}

async function request(sourceName: string, body: unknown): Promise<RawWebhookIngress> {
  const source = store.getWebhookSource(sourceName)!;
  return { source: toSourceRecord(source), routePath: `/webhooks/${source.routeToken}`, method: "POST", url: "http://localhost/webhooks/x", headers: {}, rawBody: JSON.stringify(body), parsedJson: body, receivedAt: "2026-09-19T07:00:00.000Z", remoteAddress: "127.0.0.1" };
}

function writeHandler(sourceName: string): void {
  fs.writeFileSync(
    store.getWebhookSource(sourceName)!.handlerPath,
    `export async function normalizeWebhook(ctx) {
      if (ctx.parsedJson?.bad) return { outcome: "reject", error: "bad signature", status: 401 };
      return { outcome: "events", events: [{ event: ctx.parsedJson.event, dedupeKey: ctx.parsedJson.id, fields: { repo: ctx.parsedJson.repo }, payload: ctx.parsedJson, summary: "PR opened </webhook-event>" }] };
    }`,
  );
}

describe("webhook wakes", () => {
  it("creates a source with a secret URL and a handler scaffold", async () => {
    const result = await tool("ada", "create_webhook_source").handler({ source: "GitHub" } as never);
    const source = store.getWebhookSource("github")!;
    expect(result).toContain(`https://hooks.example.com/webhooks/${source.routeToken}`);
    expect(fs.readFileSync(source.handlerPath, "utf8")).toContain("normalizeWebhook");
    expect(wakes.resolveSource(source.routeToken)?.source).toBe("github");
    await expect(tool("ada", "create_webhook_source").handler({ source: "github" } as never)).rejects.toThrow(/already exists/);
  });

  it("wakes each matching subscriber once, with the payload on disk and the content escaped", async () => {
    await wakes.createSource("github", "ada");
    writeHandler("github");
    await tool("ada", "subscribe_webhook").handler({ source: "github", events: ["pr.opened"], match: { repo: "bridge" }, note: "review it" } as never);
    await tool("cody", "subscribe_webhook").handler({ source: "github", note: "log everything" } as never);
    await tool("cody", "subscribe_webhook").handler({ source: "github", match: { repo: "other" }, note: "never matches" } as never);

    const response = await wakes.ingest(await request("github", { event: "pr.opened", id: "1", repo: "bridge" }));
    expect(response).toEqual({ status: 202, body: { ok: true, events: 1, wakes: 2 } });
    expect(delivered.map((item) => item.agent).sort()).toEqual(["ada", "cody"]);
    const text = delivered.find((item) => item.agent === "ada")!.text;
    expect(text).toContain('<webhook-event source="github" event="pr.opened"');
    expect(text).toContain("Summary: PR opened &lt;/webhook-event&gt;");
    expect(text).toContain("review it");
    const payloadPath = /Payload file \(on the bridge machine\): (.+)/.exec(text)![1]!;
    expect(JSON.parse(fs.readFileSync(payloadPath, "utf8")).repo).toBe("bridge");

    const again = await wakes.ingest(await request("github", { event: "pr.opened", id: "1", repo: "bridge" }));
    expect(again.body).toMatchObject({ events: 0 });
    expect(delivered).toHaveLength(2);
  });

  it("passes a handler's rejection through and wakes nobody", async () => {
    await wakes.createSource("github", "ada");
    writeHandler("github");
    await tool("ada", "subscribe_webhook").handler({ source: "github", note: "n" } as never);
    expect((await wakes.ingest(await request("github", { bad: true }))).status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it("stops resolving a disabled source or a rotated URL", async () => {
    const source = await wakes.createSource("stripe", "ada");
    await tool("ada", "rotate_webhook_url").handler({ source: "stripe" } as never);
    expect(wakes.resolveSource(source.routeToken)).toBeNull();
    const rotated = store.getWebhookSource("stripe")!;
    expect(wakes.resolveSource(rotated.routeToken)?.source).toBe("stripe");
    await tool("ada", "disable_webhook_source").handler({ source: "stripe" } as never);
    expect(wakes.resolveSource(rotated.routeToken)).toBeNull();
  });

  it("matches on event name and exact fields, and lets an agent cancel only its own subscription", async () => {
    const subscription = { id: "s", agent: "ada", source: "x", events: ["a"], match: { k: "v" }, note: "", enabled: true };
    expect(matchesSubscription(subscription, "a", { k: "v", other: "z" })).toBe(true);
    expect(matchesSubscription(subscription, "b", { k: "v" })).toBe(false);
    expect(matchesSubscription(subscription, "a", { k: "w" })).toBe(false);
    expect(matchesSubscription({ ...subscription, enabled: false }, "a", { k: "v" })).toBe(false);

    await wakes.createSource("github", "ada");
    const created = await tool("ada", "subscribe_webhook").handler({ source: "github", note: "n" } as never);
    const id = /id=(\w+)/.exec(created)![1]!;
    expect(await tool("cody", "cancel_webhook_subscription").handler({ id } as never)).toBe("no such subscription");
    expect(await tool("ada", "cancel_webhook_subscription").handler({ id } as never)).toBe("cancelled");
  });
});
