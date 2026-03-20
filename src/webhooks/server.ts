import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logInfo, logWarn } from "../logger.js";
import type { AppConfig } from "../config.js";
import type { WebhookSourceRecord } from "../types.js";

const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAILURE_MAX_ATTEMPTS = 10;
const AUTH_FAILURE_BLOCK_MS = 15 * 60 * 1000;

interface AuthFailureState {
  failures: number[];
  blockedUntil: number;
}

export interface RawWebhookIngress {
  source: WebhookSourceRecord;
  routePath: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedJson: unknown | null;
  receivedAt: string;
  remoteAddress: string | null;
}

export interface WebhookIngressResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class WebhookIngressServer {
  private server: Server | null = null;
  private readonly authFailures = new Map<string, AuthFailureState>();

  constructor(
    private readonly config: AppConfig,
    private readonly resolveSource: (routeToken: string) => WebhookSourceRecord | null,
    private readonly handler: (input: RawWebhookIngress) => Promise<WebhookIngressResponse>,
    private readonly canAcceptRequest: () => boolean = () => true,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.config.webhookPort, this.config.webhookBindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    logInfo("Webhook ingress started", {
      webhookPort: this.config.webhookPort,
      webhookBindHost: this.config.webhookBindHost,
      webhookPath: this.config.webhookPath,
      webhookTrustLoopbackProxy: this.config.webhookTrustLoopbackProxy,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  getListeningPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const clientKey = this.resolveClientKey(req);
      const blockedUntil = this.getAuthBlockUntil(clientKey);
      if (blockedUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
        this.respondJson(res, 429, {
          ok: false,
          error: "auth_rate_limited",
          retryAfterSeconds,
        }, { "retry-after": `${retryAfterSeconds}` });
        return;
      }

      const normalized = await this.normalizeRequest(req);
      if ("status" in normalized) {
        if (normalized.authFailure) {
          this.recordAuthFailure(clientKey);
        }
        this.respondJson(res, normalized.status, normalized.body, normalized.headers);
        return;
      }
      if (!this.canAcceptRequest()) {
        this.respondJson(res, 503, { ok: false, error: "shutting_down" });
        return;
      }
      const result = await this.handler(normalized);
      if (result.status === 401 || result.status === 403) {
        this.recordAuthFailure(clientKey);
      } else {
        this.resetAuthFailures(clientKey);
      }
      this.respondJson(res, result.status, result.body, result.headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn("Webhook ingress request failed", { error: message });
      this.respondJson(res, 500, { ok: false, error: "internal_error" });
    }
  }

  private async normalizeRequest(
    req: IncomingMessage,
  ): Promise<RawWebhookIngress | { status: number; body: Record<string, unknown>; headers?: Record<string, string>; authFailure?: boolean }> {
    if (req.method !== "POST") {
      return { status: 405, body: { ok: false, error: "method_not_allowed" } };
    }

    const routePath = this.extractRoutePath(req.url);
    if (!routePath) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }

    const source = this.resolveSource(routePath.routeToken);
    if (!source || !source.enabled) {
      return { status: 404, body: { ok: false, error: "not_found" }, authFailure: true };
    }

    if (!this.canAcceptRequest()) {
      return { status: 503, body: { ok: false, error: "shutting_down" } };
    }

    let rawBody: string;
    try {
      rawBody = await readRequestBody(req, this.config.webhookBodyMaxBytes, this.config.webhookBodyReadTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: message === "body_too_large" ? 413 : message === "body_read_timeout" ? 408 : 400,
        body: {
          ok: false,
          error: message === "body_too_large"
            ? "payload_too_large"
            : message === "body_read_timeout"
              ? "request_body_timeout"
              : "invalid_body",
        },
      };
    }

    let parsedJson: unknown | null = null;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      parsedJson = null;
    }

    return {
      source,
      routePath: routePath.fullPath,
      method: req.method,
      url: routePath.url.toString(),
      headers: normalizeHeaders(req.headers),
      rawBody,
      parsedJson,
      receivedAt: new Date().toISOString(),
      remoteAddress: req.socket.remoteAddress ?? null,
    };
  }

  private extractRoutePath(rawUrl: string | undefined): { fullPath: string; routeToken: string; url: URL } | null {
    if (!rawUrl) return null;
    const url = new URL(rawUrl, "http://127.0.0.1");
    const base = this.config.webhookPath === "/" ? "" : this.config.webhookPath;
    if (!url.pathname.startsWith(`${base}/`)) {
      return null;
    }
    const suffix = url.pathname.slice(base.length + 1);
    if (!suffix || suffix.includes("/")) {
      return null;
    }
    return {
      fullPath: url.pathname,
      routeToken: suffix,
      url,
    };
  }

  private resolveClientKey(req: IncomingMessage): string {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    if (this.config.webhookTrustLoopbackProxy && isLoopbackAddress(remoteAddress)) {
      const cfConnectingIp = req.headers["cf-connecting-ip"];
      if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
        return cfConnectingIp.trim();
      }
      const forwardedFor = req.headers["x-forwarded-for"];
      if (typeof forwardedFor === "string" && forwardedFor.trim()) {
        return forwardedFor.split(",")[0]!.trim();
      }
    }
    return remoteAddress;
  }

  private getAuthBlockUntil(clientKey: string): number {
    const state = this.authFailures.get(clientKey);
    if (!state) return 0;
    if (state.blockedUntil > 0 && state.blockedUntil <= Date.now()) {
      this.authFailures.delete(clientKey);
      return 0;
    }
    return state.blockedUntil;
  }

  private recordAuthFailure(clientKey: string): void {
    const now = Date.now();
    const current = this.authFailures.get(clientKey) ?? { failures: [], blockedUntil: 0 };
    const recentFailures = current.failures.filter((timestamp) => now - timestamp <= AUTH_FAILURE_WINDOW_MS);
    recentFailures.push(now);
    const blockedUntil = recentFailures.length >= AUTH_FAILURE_MAX_ATTEMPTS ? now + AUTH_FAILURE_BLOCK_MS : current.blockedUntil;
    this.authFailures.set(clientKey, { failures: recentFailures, blockedUntil });
  }

  private resetAuthFailures(clientKey: string): void {
    this.authFailures.delete(clientKey);
  }

  private respondJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers?: Record<string, string>): void {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    for (const [key, value] of Object.entries(headers ?? {})) {
      res.setHeader(key, value);
    }
    res.end(`${JSON.stringify(body)}\n`);
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("body_read_timeout"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        cleanup();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      if (!req.complete) {
        reject(new Error("invalid_body"));
      }
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.join(", ");
    }
  }
  return result;
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}
