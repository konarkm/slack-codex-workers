import { App } from "@slack/bolt";
import { logError, logInfo } from "../logger.js";
import type { SlackFileRef } from "../types.js";
import { normalizeSlackMrkdwn } from "./renderer.js";
import type { ValidatedSlackUploadFile } from "./uploads.js";

export type SlackChannelType = "channel" | "group" | "im" | "mpim";

// How one agent appears when it posts through the shared app.
export interface SlackPersona {
  username: string;
  // Emoji name (":brain:") or image URL.
  icon: string | null;
}

function personaFields(persona?: SlackPersona | null): Record<string, string> {
  if (!persona) return {};
  const fields: Record<string, string> = { username: persona.username };
  if (persona.icon && /^https?:\/\//.test(persona.icon)) fields.icon_url = persona.icon;
  else if (persona.icon) fields.icon_emoji = `:${persona.icon.replaceAll(":", "")}:`;
  return fields;
}

// A Slack message as the workspace app saw it.
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
  // Files Slack listed without a download link (external or still uploading); named so the agent knows they exist.
  unavailableFiles: string[];
  // Set when this is an edit of an earlier message; ts is then the edited message's ts.
  editedAt: string | null;
  // Set when one of this bridge's own agents wrote the message (the bridge relays it to the others itself).
  agentAuthor?: string | null;
  // Slack attaches this when the app is @-mentioned or DMed. It lets a bot-token search run as that person.
  actionToken?: string | null;
  // What the person had open when they sent a DM, most relevant first: a channel, a thread, a canvas, a list.
  viewing?: SlackViewedEntity[];
}

export interface SlackViewedEntity {
  // The kind, without Slack's "slack#/types/" prefix: channel_id, thread_ts, canvas_id, list_id.
  kind: string;
  value: string;
}

export type SlackSessionStatus = "processing" | "active" | "suspended" | "closed";

// Someone reacted to a message. Only reactions on messages the app posted are handed on.
export interface SlackReaction {
  channelId: string;
  // The message reacted to.
  itemTs: string;
  emoji: string;
  userId: string;
  eventTs: string;
}

export interface SlackSearchHit {
  kind: "message" | "file" | "channel" | "user";
  title: string;
  text: string;
  permalink: string | null;
  channelId: string | null;
  ts: string | null;
  authorId: string | null;
  authorName: string | null;
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
  // The name a bot message was posted under, which for the shared app is the agent that wrote it.
  username: string | null;
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
  username?: string;
  text?: string;
  team?: string;
  action_token?: string;
  app_context?: { entities?: Array<{ type?: string; value?: string }> };
  files?: Array<{ id?: string; name?: string; mimetype?: string; url_private_download?: string }>;
  attachments?: Array<{ fallback?: string; text?: string; pretext?: string; title?: string; author_name?: string; from_url?: string }>;
  blocks?: unknown[];
  // message_changed wraps the new version here.
  message?: RawMessageEvent & { edited?: { ts?: string } };
  previous_message?: RawMessageEvent;
}

// Shared and forwarded messages, and most app posts, carry their words in attachments or blocks rather than in text.
export function supplementaryText(raw: Pick<RawMessageEvent, "attachments" | "blocks">): string {
  const parts: string[] = [];
  for (const attachment of raw.attachments ?? []) {
    const body = [attachment.author_name, attachment.title, attachment.pretext, attachment.text ?? attachment.fallback].filter(Boolean).join(" · ");
    if (body) parts.push(`[shared] ${body}${attachment.from_url ? ` (${attachment.from_url})` : ""}`);
  }
  if (parts.length === 0) {
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (typeof record.text === "string" && record.type !== "emoji") texts.push(record.text);
        for (const key of ["text", "elements", "fields", "accessory"]) if (typeof record[key] === "object") walk(record[key]);
      }
    };
    walk(raw.blocks ?? []);
    if (texts.length > 0) parts.push(texts.join(" "));
  }
  return parts.join("\n");
}

const DELIVERABLE_SUBTYPES = new Set([undefined, "file_share", "bot_message", "thread_broadcast", "me_message", "message_changed"]);

// The workspace's one Slack app. Every agent hears through it and speaks through it under its own name and icon.
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
    this.app.event("app_mention", async ({ event }) => handle(event as RawMessageEvent));
  }

  // A reaction on a message. Reactions by the app itself, and on anything but messages, are not passed on.
  onReaction(handler: (reaction: SlackReaction) => Promise<void>): void {
    this.app.event("reaction_added", async ({ event }) => {
      if (event.item.type !== "message" || !event.item.channel || !event.item.ts) return;
      if (event.user === this.identity().botUserId) return;
      await handler({ channelId: event.item.channel, itemTs: event.item.ts, emoji: event.reaction, userId: event.user, eventTs: event.event_ts });
    });
  }

  // A person renamed a session in Slack.
  onSessionTitleChanged(handler: (change: { channelId: string; threadTs: string; title: string; userId: string | null }) => Promise<void>): void {
    (this.app.event as (name: string, listener: (args: { event: { channel?: string; thread_ts?: string; title?: string; user?: string } }) => Promise<void>) => void)(
      "agent_session_title_changed",
      async ({ event }) => {
        if (event.channel && event.thread_ts && typeof event.title === "string") await handler({ channelId: event.channel, threadTs: event.thread_ts, title: event.title, userId: event.user ?? null });
      },
    );
  }

  // A person opened the app's Messages tab.
  onMessagesTabOpened(handler: (opened: { channelId: string; userId: string }) => Promise<void>): void {
    (this.app.event as (name: string, listener: (args: { event: { tab?: string; channel?: string; user?: string } }) => Promise<void>) => void)("app_home_opened", async ({ event }) => {
      if (event.tab === "messages" && event.channel && event.user) await handler({ channelId: event.channel, userId: event.user });
    });
  }

  // Slack's stop button on a working indicator. The event names the thread, which tells the bridge which agent to stop.
  onStopRequested(handler: (where: { channelId: string | null; threadTs: string | null }) => Promise<void>): void {
    (this.app.event as (name: string, listener: (args: { event: { channel?: string; channel_id?: string; thread_ts?: string } }) => Promise<void>) => void)(
      "agent_session_stopped",
      async ({ event }) => handler({ channelId: event.channel ?? event.channel_id ?? null, threadTs: event.thread_ts ?? null }),
    );
  }

  // Who this app is. Called before connect(), so everything that handles events exists before events can arrive.
  async identify(): Promise<SlackIdentity> {
    const auth = await this.app.client.auth.test({ token: this.botToken });
    if (!auth.team_id || !auth.user_id || !auth.bot_id) throw new Error(`Slack auth.test for ${this.agentName} returned no bot identity`);
    this.identityValue = { teamId: auth.team_id, teamName: auth.team ?? null, botUserId: auth.user_id, botId: auth.bot_id, appId: (auth as { app_id?: string }).app_id ?? null };
    return this.identityValue;
  }

  async connect(): Promise<void> {
    await this.app.start();
    logInfo("slack agent connected", { agent: this.agentName, botUserId: this.identity().botUserId, team: this.identity().teamName });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private async normalize(event: RawMessageEvent): Promise<SlackInbound | null> {
    if (!DELIVERABLE_SUBTYPES.has(event.subtype)) return null;
    // An edit arrives wrapped; unwrap it, and ignore the "edits" Slack makes itself (unfurls, thread counters).
    let raw = event;
    let editedAt: string | null = null;
    if (event.subtype === "message_changed") {
      const changed = event.message;
      if (!changed || !changed.edited?.ts || changed.text === event.previous_message?.text) return null;
      raw = { ...changed, channel: event.channel, channel_type: event.channel_type };
      editedAt = changed.edited.ts;
    } else if (event.hidden) {
      return null;
    }
    if (!raw.channel || !raw.ts) return null;
    const identity = this.identity();
    if (raw.bot_id === identity.botId || raw.user === identity.botUserId) return null;
    // app_mention events carry no channel type; ask Slack rather than guess, so a DM is never treated as a channel.
    const channelType = raw.channel_type ?? (await this.getConversation(raw.channel).then((info) => info.type).catch(() => undefined));
    if (channelType !== "channel" && channelType !== "group" && channelType !== "im" && channelType !== "mpim") return null;
    const files = (raw.files ?? [])
      .filter((file) => file.id && file.url_private_download)
      .map((file) => ({ id: file.id!, name: file.name ?? file.id!, mimetype: file.mimetype ?? "application/octet-stream", urlPrivateDownload: file.url_private_download! }));
    const unavailableFiles = (raw.files ?? []).filter((file) => !(file.id && file.url_private_download)).map((file) => file.name ?? file.id ?? "unnamed file");
    const own = raw.text ?? "";
    const extra = supplementaryText(raw);
    const text = extra && !own.includes(extra) ? [own, extra].filter((part) => part.trim()).join("\n") : own;
    if (!text.trim() && files.length === 0 && unavailableFiles.length === 0) return null;
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
      unavailableFiles,
      editedAt,
      actionToken: raw.action_token ?? event.action_token ?? null,
      viewing: (raw.app_context?.entities ?? event.app_context?.entities ?? [])
        .filter((entity): entity is { type: string; value: string } => Boolean(entity.type && entity.value))
        .map((entity) => ({ kind: entity.type.replace(/^slack#\/types\//, ""), value: entity.value })),
    };
  }

  // One message by its coordinates, whether it is a top-level message or a reply. Null when Slack has no such message.
  async lookupMessage(channelId: string, ts: string): Promise<SlackHistoryMessage | null> {
    const response = await this.app.client.conversations.replies({ token: this.botToken, channel: channelId, ts, limit: 1, inclusive: true });
    const found = ((response.messages ?? []) as RawMessageEvent[]).find((message) => message.ts === ts);
    if (!found) return null;
    return {
      ts,
      threadTs: found.thread_ts ?? null,
      userId: found.bot_id ? null : (found.user ?? null),
      botId: found.bot_id ?? null,
      username: found.username ?? null,
      text: found.text ?? "",
      replyCount: 0,
      fileNames: (found.files ?? []).map((file) => file.name ?? file.id ?? "file"),
    };
  }

  // The downloadable files on one message.
  async lookupFiles(channelId: string, ts: string): Promise<SlackFileRef[]> {
    const response = await this.app.client.conversations.replies({ token: this.botToken, channel: channelId, ts, limit: 1, inclusive: true });
    const found = ((response.messages ?? []) as RawMessageEvent[]).find((message) => message.ts === ts);
    return (found?.files ?? [])
      .filter((file) => file.id && file.url_private_download)
      .map((file) => ({ id: file.id!, name: file.name ?? file.id!, mimetype: file.mimetype ?? "application/octet-stream", urlPrivateDownload: file.url_private_download! }));
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
    try {
      const response = await this.app.client.users.info({ token: this.botToken, user: userId });
      const user = response.user;
      const person = {
        id: userId,
        name: user?.profile?.display_name?.trim() || user?.profile?.real_name?.trim() || user?.name?.trim() || userId,
        isBot: Boolean(user?.is_bot),
        title: user?.profile?.title?.trim() || null,
      };
      this.people.set(userId, person);
      return person;
    } catch (error) {
      logError("slack users.info failed", { agent: this.agentName, userId, error: error instanceof Error ? error.message : String(error) });
      // Not remembered: the next lookup asks again, so a bot is not taken for a human for good.
      return { id: userId, name: userId, isBot: false, title: null };
    }
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

  async postMessage(args: { channelId: string; text: string; threadTs?: string | null; broadcast?: boolean; persona?: SlackPersona | null }): Promise<{ ts: string; permalink: string | null }> {
    const base = { token: this.botToken, channel: args.channelId, text: normalizeSlackMrkdwn(args.text), mrkdwn: true, ...personaFields(args.persona) };
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

  // In a thread the opening message is put in front of the newest ones unless keepRoot is false, since it says what the
  // thread is about. Leave it out when paging with before, where it would read as the oldest message on every page.
  async readHistory(args: { channelId: string; threadTs?: string | null; limit: number; before?: string | null; keepRoot?: boolean }): Promise<SlackHistoryMessage[]> {
    const common = { token: this.botToken, channel: args.channelId, limit: args.limit, latest: args.before ?? undefined, inclusive: false };
    type Raw = RawMessageEvent & { reply_count?: number };
    let messages: Raw[];
    if (args.threadTs) {
      // Replies come oldest-first a page at a time, so the newest are on the last page. Page to it, keeping only the tail.
      messages = [];
      let root: Raw | undefined;
      let cursor: string | undefined;
      do {
        const response = await this.app.client.conversations.replies({ ...common, ts: args.threadTs, limit: 200, cursor });
        const page = (response.messages ?? []) as Raw[];
        if (!cursor && page[0]?.ts === args.threadTs) root = page[0];
        messages = [...messages, ...page].slice(-args.limit);
        cursor = response.response_metadata?.next_cursor || undefined;
      } while (cursor);
      if (root && args.keepRoot !== false && !messages.includes(root)) messages = [root, ...messages];
    } else {
      messages = ((await this.app.client.conversations.history(common)).messages ?? []) as Raw[];
    }
    const mapped = messages.map((message) => ({
      ts: message.ts ?? "",
      threadTs: message.thread_ts ?? null,
      userId: message.bot_id ? null : (message.user ?? null),
      botId: message.bot_id ?? null,
      username: message.username ?? null,
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

  // The ts is the message the upload became, when Slack has shared it by the time the upload completes; often it has not.
  async uploadFiles(channelId: string, threadTs: string | null, files: ValidatedSlackUploadFile[], comment?: string): Promise<{ ts: string | null }> {
    type Share = { ts?: string };
    type Completed = { files?: Array<{ files?: Array<{ shares?: { public?: Record<string, Share[]>; private?: Record<string, Share[]> } }> }> };
    const response = await (this.app.client.files.uploadV2 as unknown as (args: Record<string, unknown>) => Promise<Completed>)({
      token: this.botToken,
      channel_id: channelId,
      thread_ts: threadTs ?? undefined,
      initial_comment: comment?.trim() || undefined,
      file_uploads: files.map((file) => ({ file: file.path, filename: file.filename, title: file.title })),
    });
    const shares = (response.files ?? []).flatMap((completed) => completed.files ?? []).flatMap((file) => [...(file.shares?.public?.[channelId] ?? []), ...(file.shares?.private?.[channelId] ?? [])]);
    return { ts: shares.find((share) => share.ts)?.ts ?? null };
  }

  // Up to four starters shown at the top of the app's Messages tab. Best effort.
  async setSuggestedPrompts(channelId: string, prompts: Array<{ title: string; message: string }>, title?: string): Promise<void> {
    try {
      await this.app.client.apiCall("assistant.threads.setSuggestedPrompts", { token: this.botToken, channel_id: channelId, prompts: prompts.slice(0, 4), title });
    } catch (error) {
      logError("could not set suggested prompts", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Presence, not speech: shows the agent as working, waiting on the person, or done in a thread. Best effort; apps without
  // the agent surface reject it.
  async setThreadStatus(channelId: string, threadTs: string, status: SlackSessionStatus, persona?: SlackPersona | null): Promise<void> {
    try {
      await this.app.client.apiCall("agents.sessions.setStatus", { token: this.botToken, channel_id: channelId, thread_ts: threadTs, status, ...personaFields(persona) });
    } catch {
      // The app may not be declared as an agent; presence is optional.
    }
  }

  // Titles a thread. In the app's DM, a titled thread shows as a named session in the person's sidebar.
  async renameSession(channelId: string, threadTs: string, title: string): Promise<void> {
    await this.app.client.apiCall("agents.sessions.rename", { token: this.botToken, channel_id: channelId, thread_ts: threadTs, title });
  }

  // Searches the workspace as the person whose message carried the action token, so it sees only what they can see.
  async searchContext(args: { query: string; actionToken: string; channelId?: string | null; order: "relevance" | "newest" | "oldest"; includeFiles: boolean; limit: number }): Promise<SlackSearchHit[]> {
    const response = (await this.app.client.apiCall("assistant.search.context", {
      token: this.botToken,
      query: args.query,
      action_token: args.actionToken,
      // A bot token can be granted search over public channels only.
      channel_types: "public_channel",
      content_types: args.includeFiles ? "messages,files" : "messages",
      context_channel_id: args.channelId ?? undefined,
      sort: args.order === "relevance" ? "score" : "timestamp",
      sort_dir: args.order === "oldest" ? "asc" : "desc",
      // A conversation filter is applied after the fact, so ask for a full page when one is set.
      limit: args.channelId ? 20 : args.limit,
    })) as {
      results?: {
        messages?: Array<{ channel_id?: string; message_ts?: string; author_user_id?: string; author_name?: string; content?: string; permalink?: string; channel_name?: string }>;
        files?: Array<{ title?: string; name?: string; permalink?: string; channel_id?: string; author_user_id?: string; author_name?: string; content?: string }>;
      };
    };
    const hits: SlackSearchHit[] = [];
    for (const item of response.results?.messages ?? []) {
      hits.push({ kind: "message", title: item.channel_name ? `#${item.channel_name}` : (item.channel_id ?? "message"), text: item.content ?? "", permalink: item.permalink ?? null, channelId: item.channel_id ?? null, ts: item.message_ts ?? null, authorId: item.author_user_id ?? null, authorName: item.author_name ?? null });
    }
    for (const item of response.results?.files ?? []) {
      hits.push({ kind: "file", title: item.title ?? item.name ?? "file", text: item.content ?? "", permalink: item.permalink ?? null, channelId: item.channel_id ?? null, ts: null, authorId: item.author_user_id ?? null, authorName: item.author_name ?? null });
    }
    return hits;
  }

  botTokenForDownloads(): string {
    return this.botToken;
  }
}
