import path from "node:path";
import process from "node:process";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import type { ReasoningEffort } from "./types.js";

loadDotEnv();

const configSchema = z.object({
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().min(1),
  slackSigningSecret: z.string().min(1).default("unused-for-socket-mode"),
  codexBin: z.string().min(1).default("codex"),
  codexCwd: z.string().min(1).default(process.cwd()),
  databasePath: z.string().min(1).default(path.join(process.cwd(), "slack-codex-workers.db")),
  adminUserIds: z.array(z.string().min(1)).default([]),
  allowedTeamId: z.string().min(1).nullable().default(null),
  messageEditThrottleMs: z.number().int().positive().default(1200),
  appPort: z.number().int().positive().default(3013),
  supervisorRestartEnabled: z.boolean().default(false),
  attachmentStorageDir: z.string().min(1).default(path.join(process.cwd(), "storage", "attachments")),
  attachmentMaxBytes: z.number().int().positive().default(1024 * 1024 * 1024),
  attachmentTotalMaxBytes: z.number().int().positive().nullable().default(null),
  attachmentDownloadTimeoutMs: z.number().int().positive().default(600_000),
  attachmentRetentionMs: z.number().int().positive().nullable().default(null),
  slackUploadTimeoutMs: z.number().int().positive().default(600_000),
  slackUploadMaxFiles: z.number().int().positive().default(10),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const raw = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "unused-for-socket-mode",
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexCwd: process.env.CODEX_CWD ?? process.cwd(),
    databasePath: process.env.DATABASE_PATH ?? path.join(process.cwd(), "slack-codex-workers.db"),
    adminUserIds: splitCsv(process.env.SLACK_ADMIN_USER_IDS),
    allowedTeamId: process.env.SLACK_ALLOWED_TEAM_ID ?? null,
    messageEditThrottleMs: parseNumber(process.env.MESSAGE_EDIT_THROTTLE_MS, 1200),
    appPort: parseNumber(process.env.PORT, 3013),
    supervisorRestartEnabled: parseBoolean(process.env.SUPERVISOR_RESTART_ENABLED, false),
    attachmentStorageDir: process.env.ATTACHMENT_STORAGE_DIR ?? path.join(process.cwd(), "storage", "attachments"),
    attachmentMaxBytes: parseNumber(process.env.ATTACHMENT_MAX_BYTES, 1024 * 1024 * 1024),
    attachmentTotalMaxBytes: parseNullableNumber(process.env.ATTACHMENT_TOTAL_MAX_BYTES, null),
    attachmentDownloadTimeoutMs: parseNumber(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS, 600_000),
    attachmentRetentionMs: parseNullableNumber(process.env.ATTACHMENT_RETENTION_MS, null),
    slackUploadTimeoutMs: parseNumber(process.env.SLACK_UPLOAD_TIMEOUT_MS, 600_000),
    slackUploadMaxFiles: parseNumber(process.env.SLACK_UPLOAD_MAX_FILES, 10),
  };

  return configSchema.parse(raw);
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

export const DEFAULT_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
export const EXIT_CODE_RESTART = 42;
