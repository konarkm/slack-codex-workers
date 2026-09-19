import path from "node:path";
import process from "node:process";
import type { HubConfig } from "./hub.js";

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadHubConfig(): HubConfig {
  const stateRoot = path.resolve(process.env.AGENTS_STATE_ROOT ?? path.join(process.cwd(), ".slack-agents"));
  return {
    agentsFile: path.resolve(process.env.AGENTS_FILE ?? path.join(stateRoot, "agents.json")),
    agentsRoot: path.resolve(process.env.AGENTS_ROOT ?? path.join(stateRoot, "homes")),
    databasePath: path.resolve(process.env.AGENTS_DATABASE_PATH ?? path.join(stateRoot, "agents.sqlite")),
    timezone: process.env.WORKSPACE_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    codexBin: process.env.CODEX_BIN ?? "codex",
    adminUserIds: (process.env.SLACK_ADMIN_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    agentWakeBudget: numberFromEnv("AGENT_WAKE_BUDGET", 8),
    threadContextLimit: numberFromEnv("THREAD_CONTEXT_LIMIT", 12),
    slackUploadMaxFiles: numberFromEnv("SLACK_UPLOAD_MAX_FILES", 10),
    attachmentStorageDir: path.resolve(process.env.ATTACHMENT_STORAGE_DIR ?? path.join(stateRoot, "attachments")),
    attachmentMaxBytes: numberFromEnv("ATTACHMENT_MAX_BYTES", 1024 * 1024 * 1024),
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: numberFromEnv("ATTACHMENT_DOWNLOAD_TIMEOUT_MS", 600_000),
  };
}
