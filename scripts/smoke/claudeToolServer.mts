// Proves the real Claude Code CLI loads the bridge's tools from the tool server the way the Claude runtime configures it:
// connected, kept in the prompt (not behind tool search), token read from the environment, and callable.
// Run: npx tsx scripts/smoke/claudeToolServer.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { TOOL_TOKEN_ENV, ToolServer } from "../../src/agents/toolServer.js";
import { claudeToolServerConfig } from "../../src/runtimes/claudeRuntime.js";

const server = new ToolServer({ bindHost: "127.0.0.1", port: 0, publicUrl: null });
await server.start();
const stamp = new Date().toISOString();
const access = server.grant("probe", { kind: "local" }, [{ name: "get_current_time", description: "The current time.", shape: { zone: z.string().optional() }, handler: async () => stamp }]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tool-server-"));
const debugFile = path.join(scratch, "debug.log");
const config = JSON.stringify({ mcpServers: claudeToolServerConfig(access.url) });

const result = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
  const child = spawn(
    "claude",
    ["-p", "Call the get_current_time tool and reply with exactly what it returned.", "--mcp-config", config, "--strict-mcp-config", "--setting-sources", "project,local", "--output-format", "json", "--debug-file", debugFile, "--max-turns", "3", "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"],
    // Tool search on, as it is for the agents, so the check proves alwaysLoad keeps the tools out of it.
    { cwd: scratch, env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDEAI_CONNECTORS: "1", ENABLE_TOOL_SEARCH: "true", [TOOL_TOKEN_ENV]: access.token }, stdio: ["ignore", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.on("close", (status) => resolve({ status, stdout }));
});
await server.stop();

const log = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8") : "";
const answer = String(JSON.parse(result.stdout || "{}").result ?? "");
const checks = {
  connected: /MCP server "bridge": Successfully connected/.test(log),
  notSearched: !/ToolSearchTool: selected mcp__bridge__/.test(log),
  called: /MCP server "bridge": Calling MCP tool: get_current_time/.test(log),
  answered: answer.includes(stamp),
};
console.log(checks);
console.log(Object.values(checks).every(Boolean) ? "PASS" : `FAIL (debug log: ${debugFile})`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
