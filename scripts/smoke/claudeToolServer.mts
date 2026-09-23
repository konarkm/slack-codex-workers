import { spawn } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { TOOL_SERVER_NAME, ToolServer } from "../../src/agents/toolServer.js";

const server = new ToolServer({ bindHost: "127.0.0.1", port: 0, publicUrl: null });
await server.start();
const access = server.grant("probe", [{ name: "get_current_time", description: "time", shape: { zone: z.string().optional() }, handler: async () => new Date().toISOString() }]);
const config = JSON.stringify({ mcpServers: { [TOOL_SERVER_NAME]: { type: "http", url: access.url, headers: { Authorization: `Bearer ${access.token}` }, alwaysLoad: true } } });
const debugFile = "/tmp/claude-http-probe.log";
fs.rmSync(debugFile, { force: true });
const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn("claude", ["-p", "Call the get_current_time tool and reply with what it returned.", "--mcp-config", config, "--strict-mcp-config", "--setting-sources", "project,local", "--output-format", "json", "--debug-file", debugFile, "--max-turns", "3", "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"], { cwd: "/tmp", env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDEAI_CONNECTORS: "1", ENABLE_TOOL_SEARCH: process.env.PROBE_TOOL_SEARCH ?? "true" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
console.log("exit", result.status);
console.log("result:", JSON.parse(result.stdout).result);
console.log("stderr", result.stderr.slice(0, 600));
const log = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8") : "";
console.log("debug lines mentioning mcp/workspace:");
for (const line of log.split("\n")) if (/bridge|reserved|deferred|tool search/i.test(line)) console.log("  ", line.slice(0, 220));
await server.stop();
process.exit(0);
