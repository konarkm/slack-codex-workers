import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logInfo, logWarn } from "../logger.js";
import type { AppConfig } from "../config.js";

const webhookSourcePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

  constructor(
    private readonly config: AppConfig,
    private readonly handler: (input: NormalizedWebhookIngress) => Promise<WebhookIngressResult>,
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
      configuredSources: Object.keys(this.config.webhookSourceSecrets).sort(),
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
        this.respondJson(res, parsed.status, parsed.body);
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
  ): Promise<NormalizedWebhookIngress | { status: number; body: Record<string, unknown> }> {
    if (req.method !== "POST") {
      return { status: 405, body: { ok: false, error: "method_not_allowed" } };
    }

    const source = this.extractSource(req.url);
    if (!source) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }

    const expectedSecret = this.config.webhookSourceSecrets[source];
    if (!expectedSecret) {
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
    const providedSecret = this.extractSecret(req);
    if (!providedSecret || !safeSecretEquals(providedSecret, expectedSecret)) {
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
    if (!this.canAcceptRequest()) {
      return { status: 503, body: { ok: false, error: "shutting_down" } };
    }

    let rawBody: string;
    try {
      rawBody = await readRequestBody(req, this.config.webhookBodyMaxBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: message === "body_too_large" ? 413 : 400,
        body: { ok: false, error: message === "body_too_large" ? "payload_too_large" : "invalid_body" },
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

  private extractSource(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    const url = new URL(rawUrl, "http://127.0.0.1");
    const normalizedBase = this.config.webhookPath === "/" ? "" : this.config.webhookPath;
    if (!url.pathname.startsWith(`${normalizedBase}/`)) {
      return null;
    }
    const encodedSource = url.pathname.slice(normalizedBase.length + 1).trim();
    if (encodedSource.length === 0 || encodedSource.includes("/")) {
      return null;
    }
    let source: string;
    try {
      source = decodeURIComponent(encodedSource);
    } catch {
      return null;
    }
    return normalizeWebhookSource(source);
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

  private respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(`${JSON.stringify(body)}\n`);
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
