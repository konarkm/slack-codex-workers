import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentStore } from "../agents/agentStore.js";
import { buildSlackTools } from "../agents/slackTools.js";
import { buildWakeTools } from "../agents/wakes.js";
import { WebhookWakes, buildWebhookTools } from "../agents/webhookWakes.js";

describe("agent tool schemas", () => {
  const store = new AgentStore(":memory:");
  const webhooks = new WebhookWakes(store, { storageDir: "/tmp/unused", webhookPath: "/webhooks", publicBaseUrl: null }, async () => {});
  const tools = [
    ...buildWakeTools("ada", store, "UTC"),
    ...buildWebhookTools("ada", store, webhooks),
    ...buildSlackTools({ slack: {} as never, persona: { username: "ada", icon: null }, afterSend() {}, noteVisibleAction() {}, recordThreadParticipation() {}, uploadConfig: {} as never, timezone: "UTC", canUploadLocalFiles: true, actionTokenFor: () => null }),
  ];

  it("have unique names", () => {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  // Found live: one record-typed parameter made the Claude SDK serve no tools at all from the bridge's server.
  it("use only plain objects, arrays, and scalars, so both runtimes can serve them", () => {
    for (const tool of tools) {
      const schema = JSON.stringify(z.toJSONSchema(z.object(tool.shape)));
      expect(schema, tool.name).not.toContain("propertyNames");
      expect(schema, tool.name).not.toMatch(/"additionalProperties":\{/);
    }
  });
});
