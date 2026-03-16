import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { Store } from "../db/store.js";
import type { ChannelRecord, WorkstreamRecord, WorkerRecord } from "../types.js";

const ROOT_WORKSTREAM_PATH = "";
const ROOT_WORKSTREAM_CHANNEL = "general";
const ITEM_METADATA_PREFIX = "<!-- slack-workers-item";
const ITEM_METADATA_SUFFIX = "-->";
const SLUG_REGEX = /^[a-z0-9][a-z0-9-_]{0,79}$/;

interface RequestItemSource {
  sourceKind: string;
  sourceSummary: string;
  sourceSlackChannelId?: string | null;
  sourceSlackMessageTs?: string | null;
}

interface RequestItemRef {
  id: string;
  filePath: string;
  title: string;
  body: string;
  source: RequestItemSource;
}

interface ItemMetadata {
  id: string;
  kind: "request" | "response";
  status: string;
  workstream: string;
  claimed_by: string | null;
  bridge_worker_key: string | null;
  app_thread_id: string | null;
  source_kind: string;
  source_summary: string;
  source_slack_channel_id: string | null;
  source_slack_message_ts: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkstreamManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {}

  async bootstrapRootWorkstream(teamId: string, channel: ChannelRecord): Promise<WorkstreamRecord> {
    await this.ensureRootLayout();
    const id = buildWorkstreamId(teamId, ROOT_WORKSTREAM_PATH);
    const current = this.store.getWorkstreamById(id);
    const record = this.store.upsertWorkstream({
      id,
      teamId,
      parentId: null,
      slug: "root",
      relativePath: ROOT_WORKSTREAM_PATH,
      channelId: channel.channelId,
      channelName: channel.name,
      description: current?.description ?? "Top-level generalist workstream.",
    });
    this.store.upsertChannels([channel]);
    return record;
  }

  async createWorkstream(
    teamId: string,
    input: { slug: string; parentRelativePath?: string | null; description?: string | null },
    createChannel: () => Promise<ChannelRecord>,
  ): Promise<WorkstreamRecord> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_REGEX.test(slug)) {
      throw new Error("Invalid workstream slug. Use lowercase letters, numbers, hyphen, or underscore.");
    }

    const parent = input.parentRelativePath
      ? this.resolveParentWorkstream(teamId, input.parentRelativePath)
      : this.store.getWorkstreamById(buildWorkstreamId(teamId, ROOT_WORKSTREAM_PATH));
    if (!parent) {
      throw new Error("Parent workstream was not found.");
    }

    const relativePath = parent.relativePath ? path.posix.join(parent.relativePath, slug) : slug;
    if (this.store.getWorkstreamByRelativePath(teamId, relativePath)) {
      throw new Error(`Workstream already exists at ${relativePath}.`);
    }

    const dirPath = this.getWorkstreamDir(relativePath);
    if (await pathExists(dirPath)) {
      throw new Error(`Directory already exists at ${dirPath}.`);
    }

    let localCreated = false;
    try {
      await this.ensureChildWorkstreamLayout(relativePath, {
        slug,
        parentRelativePath: parent.relativePath,
        channelName: slug,
        description: input.description ?? null,
      });
      localCreated = true;
    } catch (error) {
      throw new Error(`Failed to create local workstream scaffold: ${error instanceof Error ? error.message : String(error)}`);
    }

    let channel: ChannelRecord;
    try {
      channel = await createChannel();
    } catch (error) {
      if (localCreated) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
      throw new Error(`Failed to create Slack channel: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const record = this.store.upsertWorkstream({
        id: buildWorkstreamId(teamId, relativePath),
        teamId,
        parentId: parent.id,
        slug,
        relativePath,
        channelId: channel.channelId,
        channelName: channel.name,
        description: input.description ?? null,
      });
      this.store.upsertChannels([channel]);
      return record;
    } catch (error) {
      if (localCreated) {
        // Past public exposure, keep the filesystem scaffold in place for repair instead of rolling it back.
      }
      throw error;
    }
  }

  resolveWorkstreamForChannel(teamId: string, channelId: string): WorkstreamRecord | null {
    return this.store.getWorkstreamByChannel(teamId, channelId);
  }

  async createRequestItem(
    workstream: WorkstreamRecord,
    input: {
      title: string;
      body: string;
      source: RequestItemSource;
    },
  ): Promise<RequestItemRef> {
    const id = `req-${timestampToken()}-${randomUUID().slice(0, 8)}`;
    const activeDir = this.getWorkstreamActiveDir(workstream.relativePath);
    await fs.mkdir(activeDir, { recursive: true });
    const filePath = path.join(activeDir, `${id}.md`);
    const metadata: ItemMetadata = {
      id,
      kind: "request",
      status: "active",
      workstream: formatWorkstreamAddress(workstream),
      claimed_by: null,
      bridge_worker_key: null,
      app_thread_id: null,
      source_kind: input.source.sourceKind,
      source_summary: input.source.sourceSummary,
      source_slack_channel_id: input.source.sourceSlackChannelId ?? null,
      source_slack_message_ts: input.source.sourceSlackMessageTs ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(filePath, renderItemDocument(metadata, input.title, input.body));
    return {
      id,
      filePath,
      title: input.title,
      body: input.body,
      source: input.source,
    };
  }

  async bindRequestItemToWorker(
    workstream: WorkstreamRecord,
    item: RequestItemRef,
    worker: WorkerRecord,
  ): Promise<void> {
    const metadata: ItemMetadata = {
      id: item.id,
      kind: "request",
      status: "active",
      workstream: formatWorkstreamAddress(workstream),
      claimed_by: formatWorkerAddress(workstream, worker.key),
      bridge_worker_key: worker.key,
      app_thread_id: worker.appThreadId,
      source_kind: item.source.sourceKind,
      source_summary: item.source.sourceSummary,
      source_slack_channel_id: item.source.sourceSlackChannelId ?? null,
      source_slack_message_ts: item.source.sourceSlackMessageTs ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(item.filePath, renderItemDocument(metadata, item.title, item.body));
  }

  async appendResponseItem(
    workstream: WorkstreamRecord,
    worker: WorkerRecord,
    input: {
      status: string;
      body: string;
      requestItemId?: string | null;
    },
  ): Promise<string> {
    const id = `res-${timestampToken()}-${randomUUID().slice(0, 8)}`;
    const activeDir = this.getWorkstreamActiveDir(workstream.relativePath);
    await fs.mkdir(activeDir, { recursive: true });
    const filePath = path.join(activeDir, `${id}.md`);
    const createdAt = new Date().toISOString();
    const requestSummary = input.requestItemId ? `response for ${input.requestItemId}` : "worker response";
    const metadata: ItemMetadata = {
      id,
      kind: "response",
      status: input.status,
      workstream: formatWorkstreamAddress(workstream),
      claimed_by: formatWorkerAddress(workstream, worker.key),
      bridge_worker_key: worker.key,
      app_thread_id: worker.appThreadId,
      source_kind: "worker-response",
      source_summary: requestSummary,
      source_slack_channel_id: worker.channelId,
      source_slack_message_ts: worker.rootTs,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const title = input.requestItemId ? `Response to ${input.requestItemId}` : `Worker response (${input.status})`;
    await fs.writeFile(filePath, renderItemDocument(metadata, title, input.body.trim() || "(empty response)"));
    return filePath;
  }

  getWorkstreamDir(relativePath: string): string {
    return relativePath ? path.join(this.config.workspaceRoot, ...relativePath.split("/")) : this.config.workspaceRoot;
  }

  private resolveParentWorkstream(teamId: string, rawParent: string): WorkstreamRecord | null {
    const normalized = normalizeWorkstreamPath(rawParent);
    if (normalized === ROOT_WORKSTREAM_PATH) {
      return this.store.getWorkstreamById(buildWorkstreamId(teamId, ROOT_WORKSTREAM_PATH));
    }
    return this.store.getWorkstreamByRelativePath(teamId, normalized);
  }

  private async ensureRootLayout(): Promise<void> {
    await fs.mkdir(this.getBridgeStateDir(), { recursive: true });
    await this.migrateLegacyRootItemBuckets();
    await fs.mkdir(this.getWorkstreamActiveDir(ROOT_WORKSTREAM_PATH), { recursive: true });
    await fs.mkdir(this.getWorkstreamArchiveDir(ROOT_WORKSTREAM_PATH), { recursive: true });
    await writeFileIfMissing(
      path.join(this.config.workspaceRoot, "WORKSTREAM.md"),
      renderRootWorkstreamScaffold(),
    );
    await writeFileIfMissing(
      path.join(this.config.workspaceRoot, "AGENTS.md"),
      renderAgentsScaffold("root"),
    );
  }

  private async ensureChildWorkstreamLayout(
    relativePath: string,
    input: { slug: string; parentRelativePath: string; channelName: string; description: string | null },
  ): Promise<void> {
    const dirPath = this.getWorkstreamDir(relativePath);
    await fs.mkdir(path.join(dirPath, ".slack-workers", "active"), { recursive: true });
    await fs.mkdir(path.join(dirPath, ".slack-workers", "archive"), { recursive: true });
    await writeFileIfMissing(
      path.join(dirPath, "WORKSTREAM.md"),
      renderChildWorkstreamScaffold(relativePath, input),
    );
    await writeFileIfMissing(
      path.join(dirPath, "AGENTS.md"),
      renderAgentsScaffold(relativePath),
    );
  }

  private getBridgeStateDir(): string {
    return path.join(this.config.workspaceRoot, ".slack-workers");
  }

  private getWorkstreamActiveDir(relativePath: string): string {
    if (!relativePath) {
      return path.join(this.getBridgeStateDir(), "root", "active");
    }
    return path.join(this.getWorkstreamDir(relativePath), ".slack-workers", "active");
  }

  private getWorkstreamArchiveDir(relativePath: string): string {
    if (!relativePath) {
      return path.join(this.getBridgeStateDir(), "root", "archive");
    }
    return path.join(this.getWorkstreamDir(relativePath), ".slack-workers", "archive");
  }

  private async migrateLegacyRootItemBuckets(): Promise<void> {
    const stateDir = this.getBridgeStateDir();
    const legacyToNext: Array<[string, string]> = [
      [path.join(stateDir, "root-active"), this.getWorkstreamActiveDir(ROOT_WORKSTREAM_PATH)],
      [path.join(stateDir, "root-archive"), this.getWorkstreamArchiveDir(ROOT_WORKSTREAM_PATH)],
    ];
    for (const [legacyPath, nextPath] of legacyToNext) {
      if (!(await pathExists(legacyPath)) || await pathExists(nextPath)) continue;
      await fs.mkdir(path.dirname(nextPath), { recursive: true });
      await fs.rename(legacyPath, nextPath);
    }
  }
}

export function buildRequestTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Workstream request";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function buildWorkstreamId(teamId: string, relativePath: string): string {
  return relativePath ? `${teamId}:${relativePath}` : `${teamId}:root`;
}

export function formatWorkstreamAddress(workstream: WorkstreamRecord): string {
  return workstream.relativePath || "root";
}

export function formatWorkerAddress(workstream: WorkstreamRecord, workerKey: string): string {
  return `${formatWorkstreamAddress(workstream)}/${workerKey}`;
}

function normalizeWorkstreamPath(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === "root") return ROOT_WORKSTREAM_PATH;
  return trimmed;
}

function renderRootWorkstreamScaffold(): string {
  return [
    "# Root Workstream",
    "",
    "Purpose: top-level generalist workstream for requests that do not belong in a more specialized child workstream yet.",
    "",
    "Slack surface: #general",
    "",
    "Notification policy: visible in-thread, with the final settled response mentioning the root request owner.",
    "",
    "Continuity: use local workstream files, external systems, and prior Codex thread history as needed.",
    "",
    "Child workstream map: discover child workstreams from nested directories under this workspace root.",
  ].join("\n");
}

function renderChildWorkstreamScaffold(
  relativePath: string,
  input: { slug: string; parentRelativePath: string; channelName: string; description: string | null },
): string {
  return [
    `# ${input.slug} Workstream`,
    "",
    `Purpose: ${input.description ?? "Fill in the purpose of this workstream."}`,
    "",
    `Slack surface: #${input.channelName}`,
    "",
    `Parent workstream: ${input.parentRelativePath || "root"}`,
    "",
    "Notification policy: visible in-thread, with the final settled response mentioning the request owner unless the worker decides otherwise for that turn.",
    "",
    "Continuity: keep durable context in local files and external systems instead of relying on one Slack thread.",
    "",
    `Child workstream map: add nested directories under ${relativePath} as this scope grows.`,
  ].join("\n");
}

function renderAgentsScaffold(relativePath: string): string {
  return [
    `# Agents (${relativePath || "root"})`,
    "",
    "Consult WORKSTREAM.md first for scope and routing.",
    "",
    "Add work norms, quality bars, local skills, and domain-specific constraints here.",
  ].join("\n");
}

function renderItemDocument(metadata: ItemMetadata, title: string, body: string): string {
  return [
    ITEM_METADATA_PREFIX,
    JSON.stringify(metadata, null, 2),
    ITEM_METADATA_SUFFIX,
    "",
    `# ${title}`,
    "",
    body.trim() || "(empty)",
    "",
  ].join("\n");
}

async function writeFileIfMissing(filePath: string, contents: string): Promise<void> {
  if (await pathExists(filePath)) return;
  await fs.writeFile(filePath, contents);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function timestampToken(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}
