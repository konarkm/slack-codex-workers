import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logInfo, logWarn } from "../logger.js";
import type { AppConfig } from "../config.js";
import type { WebhookMailboxState } from "../types.js";

const webhookSourcePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAILURE_MAX_ATTEMPTS = 10;
const AUTH_FAILURE_BLOCK_MS = 15 * 60 * 1000;

interface AuthFailureState {
  failures: number[];
  blockedUntil: number;
}

export function normalizeWebhookSource(value: string | null | undefined): string | null {
  const source = value?.trim() ?? "";
  return webhookSourcePattern.test(source) ? source : null;
}

export interface NormalizedWebhookIngress {
  source: string;
  event: string;
  dedupeKey: string;
  match: Record<string, string> | null;
  payload: unknown;
  receivedAt: string;
  rawBody: string;
}

interface WebhookIngressResult {
  duplicate: boolean;
  matchedRegistrations: number;
  eventId: string;
}

export class WebhookIngressServer {
  private server: Server | null = null;
  private readonly authFailures = new Map<string, AuthFailureState>();

  constructor(
    private readonly config: AppConfig,
    private readonly handler: (input: NormalizedWebhookIngress) => Promise<WebhookIngressResult>,
    private readonly getMailboxState: () => WebhookMailboxState | null,
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
      server.listen(this.config.webhookPort, () => {
        server.off("error", reject);
        resolve();
      });
    });
    logInfo("Webhook ingress started", {
      webhookPort: this.config.webhookPort,
      webhookPath: this.config.webhookPath,
      mailboxConfigured: Boolean(this.getMailboxState()?.currentSecret),
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
      const parsed = await this.normalizeRequest(req);
      if ("status" in parsed) {
        this.respondJson(res, parsed.status, parsed.body, parsed.headers);
        return;
      }
      if (!this.canAcceptRequest()) {
        this.respondJson(res, 503, { ok: false, error: "shutting_down" });
        return;
      }
      const result = await this.handler(parsed);
      this.respondJson(res, 202, {
        ok: true,
        duplicate: result.duplicate,
        matchedRegistrations: result.matchedRegistrations,
        eventId: result.eventId,
      });
    } catch (error) {
      if (isWebhookShutdownError(error)) {
        this.respondJson(res, 503, { ok: false, error: "shutting_down" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logWarn("Webhook ingress request failed", { error: message });
      this.respondJson(res, 500, { ok: false, error: "internal_error" });
    }
  }

  private async normalizeRequest(
    req: IncomingMessage,
  ): Promise<NormalizedWebhookIngress | { status: number; body: Record<string, unknown>; headers?: Record<string, string> }> {
    if (req.method !== "POST") {
      return { status: 405, body: { ok: false, error: "method_not_allowed" } };
    }

    if (!this.matchesWebhookPath(req.url)) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }

    const mailboxState = this.getMailboxState();
    if (!mailboxState?.currentSecret) {
      return { status: 503, body: { ok: false, error: "mailbox_unavailable" } };
    }
    const clientKey = this.resolveClientKey(req);
    const providedSecret = this.extractSecret(req);
    const previousSecretValid = Boolean(
      mailboxState.previousSecret
      && mailboxState.previousSecretExpiresAt
      && Date.parse(mailboxState.previousSecretExpiresAt) > Date.now(),
    );
    const authorized = Boolean(
      providedSecret
      && (
        safeSecretEquals(providedSecret, mailboxState.currentSecret)
        || (previousSecretValid && safeSecretEquals(providedSecret, mailboxState.previousSecret!))
      ),
    );
    if (!authorized) {
      const blockedUntil = this.getAuthBlockUntil(clientKey);
      if (blockedUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
        return {
          status: 429,
          body: {
            ok: false,
            error: "auth_rate_limited",
            retryAfterSeconds,
          },
          headers: { "retry-after": `${retryAfterSeconds}` },
        };
      }
      this.recordAuthFailure(clientKey);
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
    this.resetAuthFailures(clientKey);
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

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: 400, body: { ok: false, error: "invalid_json_object" } };
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid_json" } };
    }

    const source = normalizeWebhookSource(typeof parsedBody.source === "string" ? parsedBody.source : null);
    if (!source) {
      return { status: 400, body: { ok: false, error: "missing_source" } };
    }
    const event = typeof parsedBody.event === "string" && parsedBody.event.trim()
      ? parsedBody.event.trim()
      : null;
    if (!event) {
      return { status: 400, body: { ok: false, error: "missing_event" } };
    }

    const id = typeof parsedBody.id === "string" && parsedBody.id.trim()
      ? parsedBody.id.trim()
      : createHash("sha256").update(`${source}\n${event}\n${stableJsonStringify(parsedBody)}`).digest("hex");
    const match = extractStringMap(parsedBody.match);
    return {
      source,
      event,
      dedupeKey: id,
      match,
      payload: Object.hasOwn(parsedBody, "payload") ? parsedBody.payload : parsedBody,
      receivedAt: new Date().toISOString(),
      rawBody,
    };
  }

  private matchesWebhookPath(rawUrl: string | undefined): boolean {
    if (!rawUrl) return false;
    const url = new URL(rawUrl, "http://127.0.0.1");
    const normalizedBase = this.config.webhookPath || "/";
    return url.pathname === normalizedBase;
  }

  private extractSecret(req: IncomingMessage): string | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && /^Bearer /i.test(authHeader)) {
      const token = authHeader.slice(authHeader.indexOf(" ") + 1).trim();
      if (token) return token;
    }
    const secretHeader = req.headers["x-bridge-webhook-secret"];
    if (typeof secretHeader === "string" && secretHeader.trim()) {
      return secretHeader.trim();
    }
    return null;
  }

  private resolveClientKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
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

function extractStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function safeSecretEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isWebhookShutdownError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "WEBHOOK_SHUTDOWN",
  );
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}
