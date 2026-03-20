import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  NormalizedWebhookEventInput,
  WebhookHandlerResult,
  WebhookSourceContext,
  WebhookSourceRecord,
} from "../types.js";

export async function runWebhookHandler(
  source: WebhookSourceRecord,
  ctx: Omit<WebhookSourceContext, "source">,
): Promise<WebhookHandlerResult> {
  const handler = await loadHandler(source.handlerPath);
  const result = await handler({
    source,
    ...ctx,
  });
  return normalizeHandlerResult(result);
}

type HandlerModule = {
  normalizeWebhook?: (ctx: WebhookSourceContext) => Promise<WebhookHandlerResult> | WebhookHandlerResult;
  default?: (ctx: WebhookSourceContext) => Promise<WebhookHandlerResult> | WebhookHandlerResult;
};

async function loadHandler(handlerPath: string): Promise<(ctx: WebhookSourceContext) => Promise<WebhookHandlerResult> | WebhookHandlerResult> {
  const stat = await fs.stat(handlerPath);
  if (!stat.isFile()) {
    throw new Error(`Webhook handler file is not a regular file: ${handlerPath}`);
  }
  const moduleUrl = `${pathToFileURL(path.resolve(handlerPath)).href}?mtime=${stat.mtimeMs}`;
  const loaded = await import(moduleUrl) as HandlerModule;
  const candidate = loaded.normalizeWebhook ?? loaded.default;
  if (typeof candidate !== "function") {
    throw new Error(`Webhook handler ${handlerPath} must export normalizeWebhook(ctx).`);
  }
  return candidate;
}

function normalizeHandlerResult(value: unknown): WebhookHandlerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook handler must return an object result.");
  }
  const result = value as Record<string, unknown>;
  if (result.outcome === "noop") {
    return {
      outcome: "noop",
      reason: typeof result.reason === "string" ? result.reason : null,
    };
  }
  if (result.outcome === "reject") {
    const error = typeof result.error === "string" && result.error.trim() ? result.error.trim() : null;
    if (!error) {
      throw new Error("Webhook handler reject results must include error.");
    }
    const status = result.status === 401 || result.status === 403 || result.status === 400
      ? result.status
      : undefined;
    return { outcome: "reject", error, status };
  }
  if (result.outcome === "events") {
    if (!Array.isArray(result.events) || result.events.length === 0) {
      throw new Error("Webhook handler events results must include at least one normalized event.");
    }
    return {
      outcome: "events",
      events: result.events.map(normalizeEvent),
    };
  }
  throw new Error(`Unsupported webhook handler outcome: ${String(result.outcome ?? "unknown")}`);
}

function normalizeEvent(value: unknown): NormalizedWebhookEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Normalized webhook events must be objects.");
  }
  const event = value as Record<string, unknown>;
  const eventName = typeof event.event === "string" && event.event.trim() ? event.event.trim() : null;
  const dedupeKey = typeof event.dedupeKey === "string" && event.dedupeKey.trim() ? event.dedupeKey.trim() : null;
  if (!eventName || !dedupeKey) {
    throw new Error("Normalized webhook events must include non-empty event and dedupeKey.");
  }
  let fields: Record<string, string> | null = null;
  if (event.fields !== undefined) {
    if (event.fields === null) {
      fields = null;
    } else if (typeof event.fields !== "object" || Array.isArray(event.fields)) {
      throw new Error("Normalized webhook event fields must be a string map.");
    } else {
      fields = Object.fromEntries(
        Object.entries(event.fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
  }
  return {
    event: eventName,
    dedupeKey,
    fields,
    payload: Object.hasOwn(event, "payload") ? event.payload : null,
    summary: typeof event.summary === "string" ? event.summary : null,
  };
}
