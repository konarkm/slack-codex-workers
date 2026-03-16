import { App } from "@slack/bolt";
import type { AppConfig } from "../config.js";
import { logInfo } from "../logger.js";
import { normalizeSlackMrkdwn } from "./renderer.js";
import type { ChannelRecord, SlackFileRef, WorkerIdentity } from "../types.js";
import type { ValidatedSlackUploadFile } from "./uploads.js";

interface ConversationsListResponse {
  channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }>;
  response_metadata?: { next_cursor?: string };
}

interface ConversationsCreateResponse {
  channel?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean };
}

interface PostMessageResponse {
  ok?: boolean;
  ts?: string;
}

interface UserInfoResponse {
  user?: {
    profile?: {
      display_name?: string;
      real_name?: string;
    };
    name?: string;
  };
}

interface SlackApiErrorLike {
  data?: {
    error?: string;
  };
}

interface FilesUploadV2ResponseLike {
  files?: Array<{ id?: string; title?: string; name?: string; permalink?: string }>;
  file?: { id?: string; title?: string; name?: string; permalink?: string };
}

export interface SlackUploadedFile {
  id: string | null;
  name: string;
  title: string | null;
  permalink: string | null;
}

export class SlackGateway {
  readonly app: App;
  private readonly userNameCache = new Map<string, string>();
  private botUserId: string | null = null;
  private teamId: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      signingSecret: config.slackSigningSecret,
    });
  }

  async start(): Promise<void> {
    await this.app.start(this.config.appPort);
    const auth = await this.app.client.auth.test({ token: this.config.slackBotToken });
    this.botUserId = auth.user_id ?? null;
    this.teamId = auth.team_id ?? null;
    if (this.config.allowedTeamId && this.teamId && this.config.allowedTeamId !== this.teamId) {
      throw new Error(`Configured SLACK_ALLOWED_TEAM_ID=${this.config.allowedTeamId} but bot is installed in team ${this.teamId}`);
    }
    logInfo("Slack gateway started", { botUserId: this.botUserId });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  getTeamId(): string | null {
    return this.teamId;
  }

  async getUserDisplayName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    const response = await this.app.client.users.info({
      token: this.config.slackBotToken,
      user: userId,
    }) as UserInfoResponse;
    const name = response.user?.profile?.display_name?.trim()
      || response.user?.profile?.real_name?.trim()
      || response.user?.name?.trim()
      || userId;
    this.userNameCache.set(userId, name);
    return name;
  }

  async postThreadReply(channelId: string, threadTs: string, text: string, identity?: WorkerIdentity | null): Promise<string> {
    const normalized = normalizeSlackMrkdwn(text);
    const response = await this.app.client.chat.postMessage({
      token: this.config.slackBotToken,
      channel: channelId,
      thread_ts: threadTs,
      text: normalized,
      mrkdwn: true,
      username: identity?.username,
      icon_emoji: identity ? `:${identity.iconEmoji}:` : undefined,
    }) as PostMessageResponse;
    if (!response.ts) {
      throw new Error("Slack did not return a ts for thread reply");
    }
    return response.ts;
  }

  async updateMessage(channelId: string, slackTs: string, text: string): Promise<void> {
    const normalized = normalizeSlackMrkdwn(text);
    await this.app.client.chat.update({
      token: this.config.slackBotToken,
      channel: channelId,
      ts: slackTs,
      text: normalized,
    });
  }

  async postTopLevelMessage(channelId: string, text: string, identity?: WorkerIdentity | null): Promise<string> {
    const normalized = normalizeSlackMrkdwn(text);
    const response = await this.app.client.chat.postMessage({
      token: this.config.slackBotToken,
      channel: channelId,
      text: normalized,
      mrkdwn: true,
      username: identity?.username,
      icon_emoji: identity ? `:${identity.iconEmoji}:` : undefined,
    }) as PostMessageResponse;
    if (!response.ts) {
      throw new Error("Slack did not return a ts for top-level post");
    }
    return response.ts;
  }

  async postMessage(channelId: string, text: string, threadTs?: string | null, identity?: WorkerIdentity | null): Promise<string> {
    if (threadTs) {
      return this.postThreadReply(channelId, threadTs, text, identity);
    }
    return this.postTopLevelMessage(channelId, text, identity);
  }

  async setStatusReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    for (const candidate of ["eyes", "hourglass_flowing_sand", "white_check_mark", "x", "no_entry_sign"]) {
      if (candidate === emoji) continue;
      await this.removeReaction(channelId, messageTs, candidate);
    }
    await this.addReaction(channelId, messageTs, emoji);
  }

  async addRootReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    await this.addReaction(channelId, messageTs, emoji);
  }

  async uploadFilesToConversation(
    channelId: string,
    threadTs: string | null,
    files: ValidatedSlackUploadFile[],
    comment?: string,
  ): Promise<SlackUploadedFile[]> {
    const uploadPromise = (this.app.client.files.uploadV2 as unknown as (args: Record<string, unknown>) => Promise<FilesUploadV2ResponseLike>)({
      token: this.config.slackBotToken,
      channel_id: channelId,
      thread_ts: threadTs ?? undefined,
      initial_comment: comment?.trim() || undefined,
      file_uploads: files.map((file) => ({
        file: file.path,
        filename: file.filename,
        title: file.title,
      })),
    });
    const response = await promiseWithTimeout(
      uploadPromise,
      this.config.slackUploadTimeoutMs,
      "Slack file upload timed out.",
    );
    const uploaded = response.files ?? (response.file ? [response.file] : []);
    return uploaded.map((file, index) => ({
      id: typeof file.id === "string" ? file.id : null,
      name: typeof file.name === "string" ? file.name : files[index]?.filename ?? `file-${index + 1}`,
      title: typeof file.title === "string" ? file.title : files[index]?.title ?? null,
      permalink: typeof file.permalink === "string" ? file.permalink : null,
    }));
  }

  async listChannels(teamId: string, query?: string): Promise<ChannelRecord[]> {
    return this.listPublicChannels(teamId, { query, includeNonMembers: false });
  }

  async findPublicChannelByName(teamId: string, name: string): Promise<ChannelRecord | null> {
    const matches = await this.listPublicChannels(teamId, { query: name, includeNonMembers: true });
    return matches.find((channel) => channel.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }

  async ensurePublicChannel(teamId: string, name: string): Promise<ChannelRecord> {
    const normalized = name.trim().toLowerCase();
    const existing = await this.findPublicChannelByName(teamId, normalized);
    if (existing) {
      if (!existing.isMember) {
        await this.app.client.conversations.join({
          token: this.config.slackBotToken,
          channel: existing.channelId,
        });
        return {
          ...existing,
          isMember: true,
          updatedAt: new Date().toISOString(),
        };
      }
      return existing;
    }
    return this.createPublicChannel(teamId, normalized);
  }

  async createPublicChannel(teamId: string, name: string): Promise<ChannelRecord> {
    const response = await this.app.client.conversations.create({
      token: this.config.slackBotToken,
      name: name.trim().toLowerCase(),
      is_private: false,
    }) as ConversationsCreateResponse;
    const channelId = response.channel?.id?.trim();
    const channelName = response.channel?.name?.trim() ?? name.trim().toLowerCase();
    if (!channelId) {
      throw new Error(`Slack did not return a channel id for ${name}`);
    }
    return {
      teamId,
      channelId,
      name: channelName,
      isPrivate: Boolean(response.channel?.is_private),
      isMember: true,
      updatedAt: new Date().toISOString(),
    };
  }

  private async listPublicChannels(
    teamId: string,
    options: { query?: string; includeNonMembers: boolean },
  ): Promise<ChannelRecord[]> {
    const channels: ChannelRecord[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.app.client.conversations.list({
        token: this.config.slackBotToken,
        types: "public_channel,private_channel",
        limit: 200,
        cursor,
        exclude_archived: true,
      }) as ConversationsListResponse;

      for (const channel of response.channels ?? []) {
        const name = channel.name?.trim();
        const channelId = channel.id?.trim();
        if (!name || !channelId) continue;
        if (!options.includeNonMembers && !channel.is_member) continue;
        if (options.query && !name.toLowerCase().includes(options.query.toLowerCase())) continue;
        channels.push({
          teamId,
          channelId,
          name,
          isPrivate: Boolean(channel.is_private),
          isMember: Boolean(channel.is_member),
          updatedAt: new Date().toISOString(),
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveChannel(teamId: string, reference: string, fallbackChannelId?: string | null): Promise<ChannelRecord> {
    const trimmed = reference.trim();
    const channels = await this.listChannels(teamId);
    const normalized = trimmed.replace(/^#/, "").toLowerCase();
    const match = channels.find((channel) => channel.channelId === trimmed || channel.name.toLowerCase() === normalized);
    if (match && match.isMember) return match;
    if (!trimmed && fallbackChannelId) {
      const fallback = channels.find((channel) => channel.channelId === fallbackChannelId);
      if (fallback) return fallback;
    }
    throw new Error(`Unable to resolve Slack channel: ${reference}`);
  }

  extractFiles(event: Record<string, unknown>): SlackFileRef[] {
    const files = Array.isArray(event.files) ? event.files : [];
    return files.flatMap((file): SlackFileRef[] => {
      if (!file || typeof file !== "object") return [];
      const record = file as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : null;
      const name = typeof record.name === "string" ? record.name : null;
      const mimetype = typeof record.mimetype === "string" ? record.mimetype : null;
      const urlPrivateDownload = typeof record.url_private_download === "string" ? record.url_private_download : null;
      if (!id || !name || !mimetype || !urlPrivateDownload) return [];
      return [{ id, name, mimetype, urlPrivateDownload }];
    });
  }

  private async addReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.add({
        token: this.config.slackBotToken,
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      const slackError = (error as SlackApiErrorLike | undefined)?.data?.error;
      if (slackError === "already_reacted") return;
      throw error;
    }
  }

  private async removeReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.remove({
        token: this.config.slackBotToken,
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      const slackError = (error as SlackApiErrorLike | undefined)?.data?.error;
      if (slackError === "no_reaction") return;
      throw error;
    }
  }
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
