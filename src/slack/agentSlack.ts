import { App } from "@slack/bolt";
import { logError, logInfo } from "../logger.js";
import type { SlackFileRef } from "../types.js";
import { normalizeSlackMrkdwn } from "./renderer.js";
import type { ValidatedSlackUploadFile } from "./uploads.js";

export type SlackChannelType = "channel" | "group" | "im" | "mpim";

// A Slack message as one agent's app saw it.
export interface SlackInbound {
  teamId: string;
  channelId: string;
  channelType: SlackChannelType;
  ts: string;
  threadTs: string | null;
  // Exactly one of userId / botId identifies the author.
  userId: string | null;
  botId: string | null;
  // The authoring app's own bot user, when the author is a bot we could resolve.
  botUserId: string | null;
  text: string;
  files: SlackFileRef[];
}

export interface SlackIdentity {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  botId: string;
  appId: string | null;
}

export interface SlackHistoryMessage {
  ts: string;
  threadTs: string | null;
  userId: string | null;
  botId: string | null;
  text: string;
  replyCount: number;
  fileNames: string[];
}

export interface SlackConversationInfo {
  id: string;
  name: string | null;
  type: SlackChannelType;
  isMember: boolean;
}

export interface SlackPerson {
  id: string;
  name: string;
  isBot: boolean;
  title: string | null;
}

interface RawMessageEvent {
  type?: string;
  subtype?: string;
  hidden?: boolean;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  team?: string;
  files?: Array<{ id?: string; name?: string; mimetype?: string; url_private_download?: string }>;
}

const DELIVERABLE_SUBTYPES = new Set([undefined, "file_share", "bot_message", "thread_broadcast", "me_message"]);

// One named agent's presence in Slack: its own app, its own bot user, its own socket.
export class AgentSlackClient {
  private readonly app: App;
  private identityValue: SlackIdentity | null = null;
  private readonly people = new Map<string, SlackPerson>();
  private readonly botUsers = new Map<string, string | null>();
  private readonly conversations = new Map<string, SlackConversationInfo>();

  constructor(
    readonly agentName: string,
    private readonly botToken: string,
    appToken: string,
  ) {
    this.app = new App({ token: botToken, appToken, socketMode: true });
    this.app.error(async (error) => {
      logError("slack app error", { agent: agentName, error: error.message });
    });
  }

  identity(): SlackIdentity {
    if (!this.identityValue) throw new Error(`Slack client for ${this.agentName} is not started`);
    return this.identityValue;
  }

  onMessage(handler: (message: SlackInbound) => Promise<void>): void {
    const handle = async (raw: RawMessageEvent): Promise<void> => {
      const message = await this.normalize(raw);
      if (message) await handler(message);
    };
    this.app.event("message", async ({ event }) => handle(event as RawMessageEvent));
    // Fires even where the app is not yet a member (the mention that invites it). Members get the same message twice; the inbox dedupes by source key.
    this.app.event("app_mention", async ({ event }) => handle({ ...(event as RawMessageEvent), channel_type: "channel" }));
  }

  onStopRequested(handler: () => Promise<void>): void {
    (this.app.event as (name: string, listener: () => Promise<void>) => void)("agent_session_stopped", handler);
  }

  async start(): Promise<SlackIdentity> {
    await this.app.start();
    const auth = await this.app.client.auth.test({ token: this.botToken });
    if (!auth.team_id || !auth.user_id || !auth.bot_id) throw new Error(`Slack auth.test for ${this.agentName} returned no bot identity`);
    this.identityValue = { teamId: auth.team_id, teamName: auth.team ?? null, botUserId: auth.user_id, botId: auth.bot_id, appId: (auth as { app_id?: string }).app_id ?? null };
    logInfo("slack agent connected", { agent: this.agentName, botUserId: auth.user_id, team: auth.team });
    return this.identityValue;
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private async normalize(raw: RawMessageEvent): Promise<SlackInbound | null> {
    if (raw.hidden || !DELIVERABLE_SUBTYPES.has(raw.subtype)) return null;
    if (!raw.channel || !raw.ts) return null;
    const identity = this.identity();
    if (raw.bot_id === identity.botId || raw.user === identity.botUserId) return null;
    const channelType = raw.channel_type;
    if (channelType !== "channel" && channelType !== "group" && channelType !== "im" && channelType !== "mpim") return null;
    const files = (raw.files ?? [])
      .filter((file) => file.id && file.url_private_download)
      .map((file) => ({ id: file.id!, name: file.name ?? file.id!, mimetype: file.mimetype ?? "application/octet-stream", urlPrivateDownload: file.url_private_download! }));
    const text = raw.text ?? "";
    if (!text.trim() && files.length === 0) return null;
    const botId = raw.bot_id ?? null;
    return {
      teamId: raw.team ?? identity.teamId,
      channelId: raw.channel,
      channelType,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      userId: botId ? null : (raw.user ?? null),
      botId,
      botUserId: botId ? await this.resolveBotUser(botId) : null,
      text,
      files,
    };
  }

  private async resolveBotUser(botId: string): Promise<string | null> {
    if (this.botUsers.has(botId)) return this.botUsers.get(botId)!;
    let userId: string | null = null;
    try {
      const response = await this.app.client.bots.info({ token: this.botToken, bot: botId });
      userId = response.bot?.user_id ?? null;
    } catch {
      userId = null;
    }
    this.botUsers.set(botId, userId);
    return userId;
  }

  async getPerson(userId: string): Promise<SlackPerson> {
    const cached = this.people.get(userId);
    if (cached) return cached;
    let person: SlackPerson = { id: userId, name: userId, isBot: false, title: null };
    try {
      const response = await this.app.client.users.info({ token: this.botToken, user: userId });
      const user = response.user;
      person = {
        id: userId,
        name: user?.profile?.display_name?.trim() || user?.profile?.real_name?.trim() || user?.name?.trim() || userId,
        isBot: Boolean(user?.is_bot),
        title: user?.profile?.title?.trim() || null,
      };
    } catch (error) {
      logError("slack users.info failed", { agent: this.agentName, userId, error: error instanceof Error ? error.message : String(error) });
    }
    this.people.set(userId, person);
    return person;
  }

  async getConversation(channelId: string): Promise<SlackConversationInfo> {
    const cached = this.conversations.get(channelId);
    if (cached) return cached;
    const response = await this.app.client.conversations.info({ token: this.botToken, channel: channelId });
    const channel = response.channel;
    const info: SlackConversationInfo = {
      id: channelId,
      name: channel?.name ?? null,
      type: channel?.is_im ? "im" : channel?.is_mpim ? "mpim" : channel?.is_private ? "group" : "channel",
      isMember: Boolean(channel?.is_member) || Boolean(channel?.is_im),
    };
    this.conversations.set(channelId, info);
    return info;
  }

  async postMessage(args: { channelId: string; text: string; threadTs?: string | null; broadcast?: boolean }): Promise<{ ts: string; permalink: string | null }> {
    const base = { token: this.botToken, channel: args.channelId, text: normalizeSlackMrkdwn(args.text), mrkdwn: true };
    const response = await this.app.client.chat.postMessage(
      args.threadTs ? { ...base, thread_ts: args.threadTs, reply_broadcast: Boolean(args.broadcast) } : base,
    );
    if (!response.ts) throw new Error("Slack did not return a ts for the message");
    return { ts: response.ts, permalink: await this.getPermalink(args.channelId, response.ts).catch(() => null) };
  }

  async updateMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.app.client.chat.update({ token: this.botToken, channel: channelId, ts, text: normalizeSlackMrkdwn(text) });
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    await this.app.client.chat.delete({ token: this.botToken, channel: channelId, ts });
  }

  async getPermalink(channelId: string, ts: string): Promise<string> {
    const response = await this.app.client.chat.getPermalink({ token: this.botToken, channel: channelId, message_ts: ts });
    if (!response.permalink) throw new Error("Slack did not return a permalink");
    return response.permalink;
  }

  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    await this.app.client.reactions.add({ token: this.botToken, channel: channelId, timestamp: ts, name: emoji.replaceAll(":", "") });
  }

  async removeReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    await this.app.client.reactions.remove({ token: this.botToken, channel: channelId, timestamp: ts, name: emoji.replaceAll(":", "") });
  }

  async readHistory(args: { channelId: string; threadTs?: string | null; limit: number; before?: string | null }): Promise<SlackHistoryMessage[]> {
    const common = { token: this.botToken, channel: args.channelId, limit: args.limit, latest: args.before ?? undefined, inclusive: false };
    const response = args.threadTs
      ? await this.app.client.conversations.replies({ ...common, ts: args.threadTs })
      : await this.app.client.conversations.history(common);
    const messages = (response.messages ?? []) as Array<RawMessageEvent & { reply_count?: number }>;
    const mapped = messages.map((message) => ({
      ts: message.ts ?? "",
      threadTs: message.thread_ts ?? null,
      userId: message.bot_id ? null : (message.user ?? null),
      botId: message.bot_id ?? null,
      text: message.text ?? "",
      replyCount: message.reply_count ?? 0,
      fileNames: (message.files ?? []).map((file) => file.name ?? file.id ?? "file"),
    }));
    // conversations.history is newest-first; replies is oldest-first. Hand back oldest-first either way.
    return args.threadTs ? mapped : mapped.reverse();
  }

  async listConversations(query?: string): Promise<SlackConversationInfo[]> {
    const results: SlackConversationInfo[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.app.client.conversations.list({ token: this.botToken, types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
      for (const channel of response.channels ?? []) {
        if (!channel.id) continue;
        if (query && !channel.name?.toLowerCase().includes(query.toLowerCase())) continue;
        results.push({ id: channel.id, name: channel.name ?? null, type: channel.is_private ? "group" : "channel", isMember: Boolean(channel.is_member) });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return results;
  }

  async listPeople(): Promise<SlackPerson[]> {
    const results: SlackPerson[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.app.client.users.list({ token: this.botToken, limit: 200, cursor });
      for (const user of response.members ?? []) {
        if (!user.id || user.deleted || user.id === "USLACKBOT") continue;
        const person: SlackPerson = {
          id: user.id,
          name: user.profile?.display_name?.trim() || user.profile?.real_name?.trim() || user.name?.trim() || user.id,
          isBot: Boolean(user.is_bot),
          title: user.profile?.title?.trim() || null,
        };
        this.people.set(user.id, person);
        results.push(person);
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return results;
  }

  async joinChannel(channelId: string): Promise<void> {
    await this.app.client.conversations.join({ token: this.botToken, channel: channelId });
    this.conversations.delete(channelId);
  }

  async openDm(userId: string): Promise<string> {
    const response = await this.app.client.conversations.open({ token: this.botToken, users: userId });
    if (!response.channel?.id) throw new Error(`Slack did not return a DM channel for ${userId}`);
    return response.channel.id;
  }

  async uploadFiles(channelId: string, threadTs: string | null, files: ValidatedSlackUploadFile[], comment?: string): Promise<void> {
    await (this.app.client.files.uploadV2 as unknown as (args: Record<string, unknown>) => Promise<unknown>)({
      token: this.botToken,
      channel_id: channelId,
      thread_ts: threadTs ?? undefined,
      initial_comment: comment?.trim() || undefined,
      file_uploads: files.map((file) => ({ file: file.path, filename: file.filename, title: file.title })),
    });
  }

  // Presence, not speech: shows the agent as working in a thread. Best effort; apps without the agent surface reject it.
  async setThreadStatus(channelId: string, threadTs: string, status: "processing" | "active"): Promise<void> {
    try {
      await this.app.client.apiCall("agents.sessions.setStatus", { token: this.botToken, channel_id: channelId, thread_ts: threadTs, status });
    } catch {
      // The app may not be declared as an agent; presence is optional.
    }
  }

  botTokenForDownloads(): string {
    return this.botToken;
  }
}
