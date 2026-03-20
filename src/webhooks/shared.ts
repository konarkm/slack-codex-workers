export const webhookSourcePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeWebhookSource(value: string | null | undefined): string | null {
  const source = value?.trim() ?? "";
  return webhookSourcePattern.test(source) ? source : null;
}
