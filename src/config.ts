import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import type { ReasoningEffort, RuntimeSettings } from "./types.js";

loadDotEnv();

const fallbackWorkspaceRoot = process.cwd();
const defaultStateDir = path.join(fallbackWorkspaceRoot, ".slack-workers", "bridge");
const defaultWorkspaceTimezone = resolveDefaultTimezone();
const defaultWebhookPath = "/webhooks";

const configSchema = z.object({
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().min(1),
  slackSigningSecret: z.string().min(1).default("unused-for-socket-mode"),
  codexBin: z.string().min(1).default("codex"),
  workspaceRoot: z.string().min(1).default(fallbackWorkspaceRoot),
  databasePath: z.string().min(1).default(path.join(defaultStateDir, "bridge.sqlite")),
  adminUserIds: z.array(z.string().min(1)).default([]),
  allowedTeamId: z.string().min(1).nullable().default(null),
  messageEditThrottleMs: z.number().int().positive().default(1200),
  appPort: z.number().int().positive().default(3013),
  supervisorRestartEnabled: z.boolean().default(false),
  launchMode: z.enum(["dev", "prod"]).default("dev"),
  attachmentStorageDir: z.string().min(1).default(path.join(defaultStateDir, "attachments")),
  attachmentMaxBytes: z.number().int().positive().default(1024 * 1024 * 1024),
  attachmentTotalMaxBytes: z.number().int().positive().nullable().default(null),
  attachmentDownloadTimeoutMs: z.number().int().positive().default(600_000),
  attachmentRetentionMs: z.number().int().positive().nullable().default(null),
  slackUploadTimeoutMs: z.number().int().positive().default(600_000),
  slackUploadMaxFiles: z.number().int().positive().default(10),
  showSlackWorklog: z.boolean().default(false),
  workspaceTimezone: z.string().min(1).default(defaultWorkspaceTimezone),
  webhookPort: z.number().int().positive().default(3014),
  webhookBindHost: z.string().min(1).default("127.0.0.1"),
  webhookPath: z.string().min(1).default(defaultWebhookPath),
  webhookBodyMaxBytes: z.number().int().positive().default(256 * 1024),
  webhookBodyReadTimeoutMs: z.number().int().positive().default(30_000),
  webhookPayloadStorageDir: z.string().min(1).default(path.join(defaultStateDir, "webhooks")),
  webhookPublicBaseUrl: z.string().min(1).nullable().default(null),
  webhookTrustLoopbackProxy: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.env.CODEX_CWD ?? process.cwd();
  const stateDir = prepareDefaultStateDir(
    workspaceRoot,
    !process.env.DATABASE_PATH && !process.env.ATTACHMENT_STORAGE_DIR,
  );
  const raw = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "unused-for-socket-mode",
    codexBin: process.env.CODEX_BIN ?? "codex",
    workspaceRoot,
    databasePath: process.env.DATABASE_PATH ?? path.join(stateDir, "bridge.sqlite"),
    adminUserIds: splitCsv(process.env.SLACK_ADMIN_USER_IDS),
    allowedTeamId: process.env.SLACK_ALLOWED_TEAM_ID ?? null,
    messageEditThrottleMs: parseNumber(process.env.MESSAGE_EDIT_THROTTLE_MS, 1200),
    appPort: parseNumber(process.env.PORT, 3013),
    supervisorRestartEnabled: parseBoolean(process.env.SUPERVISOR_RESTART_ENABLED, false),
    launchMode: parseLaunchMode(process.env.LAUNCH_MODE),
    attachmentStorageDir: process.env.ATTACHMENT_STORAGE_DIR ?? path.join(stateDir, "attachments"),
    attachmentMaxBytes: parseNumber(process.env.ATTACHMENT_MAX_BYTES, 1024 * 1024 * 1024),
    attachmentTotalMaxBytes: parseNullableNumber(process.env.ATTACHMENT_TOTAL_MAX_BYTES, null),
    attachmentDownloadTimeoutMs: parseNumber(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS, 600_000),
    attachmentRetentionMs: parseNullableNumber(process.env.ATTACHMENT_RETENTION_MS, null),
    slackUploadTimeoutMs: parseNumber(process.env.SLACK_UPLOAD_TIMEOUT_MS, 600_000),
    slackUploadMaxFiles: parseNumber(process.env.SLACK_UPLOAD_MAX_FILES, 10),
    showSlackWorklog: parseBoolean(process.env.SHOW_SLACK_WORKLOG, false),
    workspaceTimezone: resolveConfiguredTimezone(process.env.WORKSPACE_TIMEZONE),
    webhookPort: parseNumber(process.env.WEBHOOK_PORT, 3014),
    webhookBindHost: parseOptionalString(process.env.WEBHOOK_BIND_HOST) ?? "127.0.0.1",
    webhookPath: normalizeWebhookPath(process.env.WEBHOOK_PATH),
    webhookBodyMaxBytes: parseNumber(process.env.WEBHOOK_BODY_MAX_BYTES, 256 * 1024),
    webhookBodyReadTimeoutMs: parseNumber(process.env.WEBHOOK_BODY_READ_TIMEOUT_MS, 30_000),
    webhookPayloadStorageDir: process.env.WEBHOOK_PAYLOAD_STORAGE_DIR ?? path.join(stateDir, "webhooks"),
    webhookPublicBaseUrl: normalizeOptionalBaseUrl(process.env.WEBHOOK_PUBLIC_BASE_URL),
    webhookTrustLoopbackProxy: parseBoolean(process.env.WEBHOOK_TRUST_LOOPBACK_PROXY, false),
  };

  return configSchema.parse(raw);
}

function prepareDefaultStateDir(workspaceRoot: string, allowLegacyMigration: boolean): string {
  const rootHiddenDir = path.join(workspaceRoot, ".slack-workers");
  const preferred = path.join(rootHiddenDir, "bridge");
  const legacy = path.join(workspaceRoot, ".slack-codex-workers");
  if (
    allowLegacyMigration
    && !fs.existsSync(rootHiddenDir)
    && fs.existsSync(legacy)
  ) {
    fs.mkdirSync(rootHiddenDir, { recursive: true });
    fs.renameSync(legacy, preferred);
  }
  if (!fs.existsSync(preferred)) {
    fs.mkdirSync(preferred, { recursive: true });
  }
  return preferred;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNullableNumber(value: string | undefined, fallback: number | null): number | null {
  if (!value) return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "null" || trimmed === "none" || trimmed === "infinite" || trimmed === "off") {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseLaunchMode(value: string | undefined): "dev" | "prod" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "prod" ? "prod" : "dev";
}

function resolveConfiguredTimezone(value: string | undefined): string {
  const candidate = value?.trim() || defaultWorkspaceTimezone;
  return validateTimezone(candidate);
}

function resolveDefaultTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validateTimezone(timezone || "UTC");
}

function normalizeWebhookPath(value: string | undefined): string {
  const trimmed = value?.trim() || defaultWebhookPath;
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function parseOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("WEBHOOK_PUBLIC_BASE_URL must use http or https.");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Invalid WEBHOOK_PUBLIC_BASE_URL: ${trimmed}`);
  }
}

function validateTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

export const DEFAULT_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  model: DEFAULT_MODEL,
  effort: "medium",
};
export const EXIT_CODE_RESTART = 42;
