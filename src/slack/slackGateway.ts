import { App } from "@slack/bolt";
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { AppConfig } from "../config.js";
import { logInfo } from "../logger.js";
import type { ChannelRecord, SlackFileRef } from "../types.js";

interface ConversationsListResponse {
  channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }>;
  response_metadata?: { next_cursor?: string };
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

  async postThreadReply(channelId: string, threadTs: string, text: string): Promise<string> {
    const response = await this.app.client.chat.postMessage({
      token: this.config.slackBotToken,
      channel: channelId,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    }) as PostMessageResponse;
    if (!response.ts) {
      throw new Error("Slack did not return a ts for thread reply");
    }
    return response.ts;
  }

  async updateMessage(channelId: string, slackTs: string, text: string): Promise<void> {
    await this.app.client.chat.update({
      token: this.config.slackBotToken,
      channel: channelId,
      ts: slackTs,
      text,
    });
  }

  async postTopLevelMessage(channelId: string, text: string): Promise<string> {
    const response = await this.app.client.chat.postMessage({
      token: this.config.slackBotToken,
      channel: channelId,
      text,
      mrkdwn: true,
    }) as PostMessageResponse;
    if (!response.ts) {
      throw new Error("Slack did not return a ts for top-level post");
    }
    return response.ts;
  }

  async postMessage(channelId: string, text: string, threadTs?: string | null): Promise<string> {
    if (threadTs) {
      return this.postThreadReply(channelId, threadTs, text);
    }
    return this.postTopLevelMessage(channelId, text);
  }

  async listChannels(teamId: string, query?: string): Promise<ChannelRecord[]> {
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
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
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
    if (match) return match;
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
}
