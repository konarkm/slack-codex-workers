export function buildWebhookHandlerScaffold(source: string): string {
  return `/**
 * Webhook handler for source "${source}".
 *
 * This file runs as trusted local code inside the bridge process.
 *
 * normalizeWebhook(ctx) receives:
 *   ctx.source        -> { id, source, routeToken, handlerPath, enabled, createdAt, updatedAt }
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
