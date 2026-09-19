// Shows which MCP servers and app connectors a Codex agent's app-server sees, without running a turn.
// Usage: tsx scripts/smoke/codexIsolation.ts <isolated|inherited> [deny-spec ...]   e.g. inherited mcp__codex_apps mcp__composio
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexRpcClient } from "../../src/codex/rpcClient.js";
import { codexDenyArgs } from "../../src/runtimes/codexRuntime.js";

const isolated = process.argv[2] !== "inherited";
const home = path.join(os.homedir(), ".slack-agents", "homes", "codex-smoke", ".codex-home");
if (isolated) {
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(path.join(home, "auth.json"))) fs.symlinkSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(home, "auth.json"));
}
const rpc = new CodexRpcClient("codex", process.cwd(), { name: "slack-agents", title: "Slack Agents", version: "0.2.0" }, () =>
  spawn("codex", ["app-server", ...codexDenyArgs(process.argv.slice(3))], { env: { ...process.env, ...(isolated ? { CODEX_HOME: home } : {}) }, stdio: ["pipe", "pipe", "pipe"] }),
);
await rpc.start();
const account = await rpc.request<{ account?: { type?: string } }>("account/read", {});
console.log("logged in:", account.account?.type ?? "no");
const servers = await rpc.request<{ data?: Array<{ name: string; tools?: Record<string, unknown> }> }>("mcpServerStatus/list", {}).catch((error) => ({ error: String(error) }));
console.log("mcp servers:", JSON.stringify("data" in servers ? (servers.data ?? []).map((server) => `${server.name}(${Object.keys(server.tools ?? {}).length})`) : servers).slice(0, 600));
const apps = await rpc.request<{ data?: Array<{ id?: string; name?: string; isAccessible?: boolean; isEnabled?: boolean }> }>("app/list", {}).catch((error) => ({ error: String(error) }));
console.log("apps:", JSON.stringify("data" in apps ? (apps.data ?? []).filter((app) => app.isAccessible).map((app) => app.name) : apps).slice(0, 400));
await rpc.stop();
process.exit(0);
