import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logError, logInfo } from "../logger.js";
import type { AgentHost, AgentTool } from "./types.js";

// The MCP server name every harness sees; tools are addressed as `mcp__<name>__<tool>` (Claude) or `mcp__<name>.<tool>` (Codex).
// Not "workspace": Claude Code reserves that name for servers given on the command line and drops them silently.
export const TOOL_SERVER_NAME = "bridge";
export const TOOL_TOKEN_ENV = "SLACK_AGENTS_TOOL_TOKEN";

export interface ToolServerConfig {
  bindHost: string;
  port: number;
  // Where agents on other machines reach the server (the hub's tailnet address). Agents on this machine always use loopback.
  publicUrl: string | null;
}

export interface ToolAccess {
  url: string;
  token: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

class RequestError extends Error {
  constructor(readonly status: number, readonly rpcCode: number, message: string) {
    super(message);
  }
}

// The hub's tools, served to every agent over MCP (streamable HTTP, stateless). Each agent has its own token and its
// own tool set, so the server knows who is calling and a harness re-reading the catalog at session start always gets
// that agent's current tools. Adding a tool to the bridge therefore costs a hub restart and nothing else.
export class ToolServer {
  private server: Server | null = null;
  // The port actually bound; differs from the configured one when that is 0.
  private port: number;
  // Keyed by token, not agent name: a seat being torn down and a new seat for the same agent can overlap, and each must
  // revoke only its own access.
  private readonly grants = new Map<string, { agent: string; tools: AgentTool[] }>();

  constructor(private readonly config: ToolServerConfig) {
    this.port = config.port;
  }

  // Where an agent on the given host reaches the server. Throws when an agent on another machine has no route here.
  urlFor(host: AgentHost): string {
    if (host.kind === "local") return `http://${loopbackFor(this.config.bindHost)}:${this.port}/mcp`;
    if (!this.config.publicUrl) {
      throw new Error("this agent runs on another machine, and the tool server has no address it can reach: set TOOL_SERVER_PUBLIC_URL to the hub's tailnet URL and TOOL_SERVER_BIND_HOST to an address that serves it");
    }
    return this.config.publicUrl;
  }

  // A fresh token for one seat's tools. The seat revokes exactly this token when it stops.
  grant(agent: string, host: AgentHost, tools: AgentTool[]): ToolAccess {
    const url = this.urlFor(host);
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, { agent, tools });
    return { url, token };
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (error instanceof RequestError) {
          if (!res.headersSent) sendJson(res, error.status, { jsonrpc: "2.0", id: null, error: { code: error.rpcCode, message: error.message } });
          else res.end();
          return;
        }
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
    logInfo("tool server listening", { local: this.urlFor({ kind: "local" }), public: this.config.publicUrl });
    if (this.config.publicUrl && isLoopback(this.config.bindHost)) {
      logError("TOOL_SERVER_PUBLIC_URL is set but the tool server only listens on loopback; agents on other machines cannot reach it. Set TOOL_SERVER_BIND_HOST too.", { bindHost: this.config.bindHost });
    }
  }

  // Called after the agents have stopped, so any call still open belongs to nobody; it is cut rather than waited on.
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
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
    const body = withDefaultArguments(await readJson(req));
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

// MCP lets a tools/call leave out `arguments`; the tools' schemas expect an object, so a call to a tool that takes none
// would otherwise fail validation.
function withDefaultArguments(body: unknown): unknown {
  const fill = (message: unknown): unknown => {
    if (!message || typeof message !== "object") return message;
    const call = message as { method?: unknown; params?: { arguments?: unknown } };
    if (call.method !== "tools/call" || !call.params || typeof call.params !== "object" || call.params.arguments !== undefined) return message;
    return { ...call, params: { ...call.params, arguments: {} } };
  };
  return Array.isArray(body) ? body.map(fill) : fill(body);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

// The address a process on this machine uses to reach a server bound to `bindHost`.
function loopbackFor(bindHost: string): string {
  if (bindHost === "::1") return "[::1]";
  if (isLoopback(bindHost) || bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "") return "127.0.0.1";
  return bindHost.includes(":") ? `[${bindHost}]` : bindHost;
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
    if (size > MAX_BODY_BYTES) throw new RequestError(413, -32600, "request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, -32700, "parse error: the body is not JSON");
  }
}
