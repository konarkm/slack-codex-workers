import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { AgentStore } from "../../src/agents/agentStore.js";
import { buildSlackTools } from "../../src/agents/slackTools.js";
import { buildWakeTools } from "../../src/agents/wakes.js";
import { WebhookWakes, buildWebhookTools } from "../../src/agents/webhookWakes.js";

const store = new AgentStore(":memory:");
const wakes = new WebhookWakes(store, { storageDir: "/tmp/x", webhookPath: "/webhooks", publicBaseUrl: null }, async () => {});
const defs = [...buildWakeTools("ada", store, "UTC"), ...buildWebhookTools("ada", store, wakes), ...buildSlackTools({ slack: {} as never, noteVisibleAction() {}, recordThreadParticipation() {}, uploadConfig: {} as never, timezone: "UTC", canUploadLocalFiles: true })];
console.log("defined", defs.length, defs.map((d) => d.name).join(","));
const only = process.argv[2] ? process.argv[2].split(",") : null;
const server = createSdkMcpServer({ name: "workspace", tools: defs.filter((d) => !only || only.includes(d.name)).map((d) => tool(d.name, d.description, d.shape, async () => ({ content: [{ type: "text", text: "ok" }] }), { alwaysLoad: true })) });
async function* input() {
  yield { type: "user" as const, message: { role: "user" as const, content: PROMPT }, parent_tool_use_id: null };
  await new Promise(() => {});
}
const PROMPT = "Reply with only a comma-separated list of every tool available to you whose name starts with mcp__workspace__ (or the word NONE). Do not call any tool.";
const q = query({
  prompt: input(),
  options: { model: "claude-haiku-4-5-20251001", mcpServers: { workspace: server }, settingSources: [], strictMcpConfig: true, cwd: "/tmp", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
});
for await (const message of q) {
  if (message.type === "system" && message.subtype === "init") console.log("init tools:", message.tools.filter((name) => name.startsWith("mcp__")).length, message.tools.filter((name) => name.startsWith("mcp__")).join(","));
  if (message.type === "result") {
    console.log("RESULT:", message.subtype === "success" ? message.result : message.errors);
    process.exit(0);
  }
}
process.exit(0);
