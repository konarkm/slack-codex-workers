import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { Store } from "../db/store.js";
import type { WebhookSourceRecord } from "../types.js";
import { normalizeWebhookSource } from "./shared.js";

export class WebhookSourceManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {}

  listSources(teamId: string): WebhookSourceRecord[] {
    return this.store.listWebhookSources(teamId);
  }

  getSource(teamId: string, source: string): WebhookSourceRecord | null {
    const normalized = normalizeWebhookSource(source);
    if (!normalized) {
      throw new Error("Webhook source must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.");
    }
    return this.store.getWebhookSource(teamId, normalized);
  }

  async createSource(teamId: string, source: string): Promise<WebhookSourceRecord> {
    const normalized = normalizeWebhookSource(source);
    if (!normalized) {
      throw new Error("Webhook source must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.");
    }
    if (this.store.getWebhookSource(teamId, normalized)) {
      throw new Error(`Webhook source ${normalized} already exists.`);
    }
    const handlerPath = this.buildHandlerPath(teamId, normalized);
    await fs.mkdir(path.dirname(handlerPath), { recursive: true });
    await fs.writeFile(handlerPath, buildWebhookHandlerScaffold(normalized), { flag: "wx" });
    return this.store.createWebhookSource({
      id: `src-${randomUUID().slice(0, 8)}`,
      teamId,
      source: normalized,
      routeToken: generateRouteToken(),
      handlerPath,
      enabled: true,
    });
  }

  disableSource(teamId: string, source: string): WebhookSourceRecord {
    const current = this.getRequiredSource(teamId, source);
    return this.store.updateWebhookSource(teamId, current.source, { enabled: false })!;
  }

  rotateSourceRoute(teamId: string, source: string): WebhookSourceRecord {
    const current = this.getRequiredSource(teamId, source);
    return this.store.updateWebhookSource(teamId, current.source, { routeToken: generateRouteToken() })!;
  }

  getSourceRoutePath(source: Pick<WebhookSourceRecord, "routeToken">): string {
    const base = this.config.webhookPath === "/" ? "" : this.config.webhookPath;
    return `${base}/${source.routeToken}`;
  }

  getSourcePublicUrl(source: Pick<WebhookSourceRecord, "routeToken">): string | null {
    if (!this.config.webhookPublicBaseUrl) return null;
    return `${this.config.webhookPublicBaseUrl}${this.getSourceRoutePath(source)}`;
  }

  private getRequiredSource(teamId: string, source: string): WebhookSourceRecord {
    const current = this.getSource(teamId, source);
    if (!current) {
      throw new Error(`Webhook source ${source} does not exist.`);
    }
    return current;
  }

  private buildHandlerPath(teamId: string, source: string): string {
    return path.join(this.config.workspaceRoot, ".slack-workers", "bridge", "webhook-sources", teamId, source, "handler.mjs");
  }
}

function generateRouteToken(): string {
  return randomBytes(18).toString("hex");
}

function buildWebhookHandlerScaffold(source: string): string {
  return `/**
 * Webhook handler for source "${source}".
 *
 * This file runs as trusted local code inside the bridge process.
 *
 * normalizeWebhook(ctx) receives:
 *   ctx.source        -> { id, teamId, source, routeToken, handlerPath, enabled, createdAt, updatedAt }
 *   ctx.method        -> HTTP method
 *   ctx.url           -> full request URL
 *   ctx.routePath     -> resolved webhook route path
 *   ctx.headers       -> normalized request headers
 *   ctx.rawBody       -> raw request body string
 *   ctx.parsedJson    -> best-effort parsed JSON body, or null
 *   ctx.receivedAt    -> ISO timestamp
 *   ctx.remoteAddress -> caller IP when available
 *
 * Export an async normalizeWebhook(ctx) function that returns one of:
 *   { outcome: "events", events: [{ event, dedupeKey, fields, payload, summary? }] }
 *   { outcome: "noop", reason?: string }
 *   { outcome: "reject", error: string, status?: 400 | 401 | 403 }
 */
export async function normalizeWebhook(ctx) {
  return {
    outcome: "noop",
    reason: "Handler not implemented yet.",
  };
}
`;
}
