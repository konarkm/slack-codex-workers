import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logError, logInfo } from "../logger.js";
import type { AgentTool } from "./types.js";

// The MCP server name every harness sees; tools are addressed as `mcp__<name>__<tool>` (Claude) or `mcp__<name>.<tool>` (Codex).
// Not "workspace": Claude Code reserves that name for servers given on the command line and drops them silently.
export const TOOL_SERVER_NAME = "bridge";
export const TOOL_TOKEN_ENV = "SLACK_AGENTS_TOOL_TOKEN";

export interface ToolServerConfig {
  bindHost: string;
  port: number;
  // Where agents reach the server; needed when an agent runs on another machine. Defaults to the bind address.
  publicUrl: string | null;
}

export interface ToolAccess {
  url: string;
  token: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

// The hub's tools, served to every agent over MCP (streamable HTTP, stateless). Each agent has its own token and its
// own tool set, so the server knows who is calling and a harness re-reading the catalog at session start always gets
// that agent's current tools. Adding a tool to the bridge therefore costs a hub restart and nothing else.
export class ToolServer {
  private server: Server | null = null;
  // The port actually bound; differs from the configured one when that is 0.
  private port: number;
  private readonly grants = new Map<string, { agent: string; tools: AgentTool[] }>();
  private readonly tokensByAgent = new Map<string, string>();

  constructor(private readonly config: ToolServerConfig) {
    this.port = config.port;
  }

  url(): string {
    return this.config.publicUrl ?? `http://${this.config.bindHost}:${this.port}/mcp`;
  }

  // Gives an agent a token for its tools; a later grant for the same agent replaces the earlier one.
  grant(agent: string, tools: AgentTool[]): ToolAccess {
    this.revoke(agent);
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, { agent, tools });
    this.tokensByAgent.set(agent, token);
    return { url: this.url(), token };
  }

  revoke(agent: string): void {
    const token = this.tokensByAgent.get(agent);
    if (token) this.grants.delete(token);
    this.tokensByAgent.delete(agent);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        logError("tool server request failed", { error: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (address && typeof address === "object") this.port = address.port;
    logInfo("tool server listening", { url: this.url() });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const grant = this.grantFor(req.headers.authorization);
    if (!grant) {
      sendJson(res, 401, { error: "unknown or missing agent token" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no event stream to open and no session to delete.
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJson(req);
    const mcp = new McpServer({ name: TOOL_SERVER_NAME, version: "1.0.0" });
    for (const tool of grant.tools) {
      mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args: unknown) => {
        try {
          const text = await tool.handler(args as never);
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private grantFor(header: string | undefined): { agent: string; tools: AgentTool[] } | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    return match ? (this.grants.get(match[1]!) ?? null) : null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
