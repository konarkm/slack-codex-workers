import { z } from "zod";
import type { AgentSlackClient, SlackHistoryMessage, SlackPersona } from "../slack/agentSlack.js";
import type { SlackFileRef } from "../types.js";
import { validateSlackUploadFiles } from "../slack/uploads.js";
import { renderSlackText, sanitizeHeader } from "./envelope.js";
import type { AgentTool } from "./types.js";

export interface SlackToolContext {
  slack: AgentSlackClient;
  // The name and icon this agent posts under; all agents share one Slack app.
  persona: SlackPersona;
  // Called after the agent posts, so the bridge can let the other agents hear it.
  afterSend(sent: { channelId: string; threadTs: string | null; ts: string; text: string }): void;
  // The agent did something people can see (or explicitly chose not to).
  noteVisibleAction(): void;
  recordThreadParticipation(channelId: string, threadTs: string): void;
  uploadConfig: Parameters<typeof validateSlackUploadFiles>[1];
  timezone: string;
  // False when the agent's files live on another machine than the bridge.
  canUploadLocalFiles: boolean;
  // In the app's direct message a thread is one agent's session. These answer for this agent.
  dm: {
    ownerOf(channelId: string, threadTs: string): string | null;
    claim(channelId: string, threadTs: string): void;
    sessions(channelId: string): string[];
  };
  // The agent says where a session stands: waiting on the person, or finished.
  markSession(channelId: string, threadTs: string, state: "waiting" | "done"): Promise<void>;
  // Downloads a message's files to the bridge's disk and says where they are.
  fetchFiles(key: string, files: SlackFileRef[]): Promise<{ imagePaths: string[]; fileNotes: string[] }>;
  // The agent read a conversation up to this message, so a later wake there does not hand it the same messages again.
  noteRead(channelId: string, threadKey: string, ts: string): void;
  // The latest search token Slack has given the app. Null when there is none.
  latestActionToken(): string | null;
}

function defineTool<Shape extends z.ZodRawShape>(tool: AgentTool<Shape>): AgentTool {
  return tool as unknown as AgentTool;
}

const channel = z.string().min(1).describe("Conversation id (C…, G…, or D…), as given in an envelope's reply target.");
const messageTs = z.string().min(1).describe("A message ts, e.g. 1726700000.000100.");

async function renderHistory(slack: AgentSlackClient, ownName: string, messages: SlackHistoryMessage[]): Promise<string> {
  const own = slack.identity();
  const lines: string[] = [];
  for (const message of messages) {
    const names = new Map<string, string>();
    for (const match of message.text.matchAll(/<@([A-Z0-9]+)/g)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
    const author =
      message.botId === own.botId
        ? message.username === ownName ? "you" : sanitizeHeader(`${message.username ?? "the bridge"} (agent)`)
        : message.userId ? sanitizeHeader((await slack.getPerson(message.userId)).name) : `app ${message.botId ?? "unknown"}`;
    const extras = [message.replyCount > 0 ? `${message.replyCount} replies` : null, message.fileNames.length > 0 ? `files: ${message.fileNames.map(sanitizeHeader).join(", ")}` : null].filter(Boolean);
    lines.push(`[ts ${message.ts}] ${author}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}: ${renderSlackText(message.text, own.botUserId, names)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no messages)";
}

// The agent's hands in Slack. Everything a person sees from the agent goes through these.
export function buildSlackTools(ctx: SlackToolContext): AgentTool[] {
  const { slack } = ctx;
  const me = ctx.persona.username;
  const isDm = async (channelId: string): Promise<boolean> => (await slack.getConversation(channelId).catch(() => null))?.type === "im";
  // Null when this agent may read or write in that DM thread; otherwise the reason it may not.
  const dmRefusal = async (channelId: string, threadRoot: string): Promise<string | null> => {
    if (!(await isDm(channelId))) return null;
    const owner = ctx.dm.ownerOf(channelId, threadRoot);
    return owner && owner !== me ? `that direct-message thread is ${owner}'s session with the person, not yours. If you need something from it, ask ${owner} in a channel.` : null;
  };
  return [
    defineTool({
      name: "send_message",
      description:
        "Send a Slack message as yourself. This is the only way anyone sees what you say; your turn output is not shown to anyone. Pass thread_ts to reply inside a thread (the envelope's reply target gives the right values). To get another agent's attention, say its name. To notify a person, mention them with <@USERID>.",
      shape: {
        channel,
        text: z.string().min(1).describe("Slack mrkdwn or plain text."),
        thread_ts: z.string().optional().describe("Thread to reply in. Omit to post at the top level of the conversation."),
        broadcast: z.boolean().optional().describe("Also show a threaded reply in the channel. Use sparingly."),
      },
      handler: async (args) => {
        const refusal = args.thread_ts ? await dmRefusal(args.channel, args.thread_ts) : null;
        if (refusal) return refusal;
        const result = await slack.postMessage({ channelId: args.channel, text: args.text, threadTs: args.thread_ts ?? null, broadcast: args.broadcast, persona: ctx.persona });
        if (await isDm(args.channel)) ctx.dm.claim(args.channel, args.thread_ts ?? result.ts);
        ctx.noteVisibleAction();
        ctx.recordThreadParticipation(args.channel, args.thread_ts ?? result.ts);
        ctx.afterSend({ channelId: args.channel, threadTs: args.thread_ts ?? null, ts: result.ts, text: args.text });
        return `sent. ts=${result.ts}${result.permalink ? ` permalink=${result.permalink}` : ""}`;
      },
    }),
    defineTool({
      name: "react",
      description: "Add an emoji reaction to a message as yourself. A reaction is a complete, visible acknowledgement when no words are needed.",
      shape: { channel, ts: messageTs, emoji: z.string().min(1).describe("Emoji name without colons, e.g. eyes, white_check_mark, +1.") },
      handler: async (args) => {
        await slack.addReaction(args.channel, args.ts, args.emoji);
        ctx.noteVisibleAction();
        return "reacted";
      },
    }),
    defineTool({
      name: "remove_reaction",
      description: "Remove one of your own emoji reactions from a message.",
      shape: { channel, ts: messageTs, emoji: z.string().min(1) },
      handler: async (args) => {
        await slack.removeReaction(args.channel, args.ts, args.emoji);
        return "removed";
      },
    }),
    defineTool({
      name: "dismiss",
      description:
        "Record that you were woken and deliberately chose not to reply or react, with a short reason (for example: mentioned but not addressed to me). Use this instead of ending a turn silently. Nothing is posted to Slack.",
      shape: { reason: z.string().min(1) },
      handler: async () => {
        ctx.noteVisibleAction();
        return "dismissed";
      },
    }),
    defineTool({
      name: "mark_session",
      description:
        "Mark where a thread's work stands in Slack's session list: `waiting` when you have asked the person something and cannot go on until they answer; `done` when the work in that thread is finished. The bridge shows working and idle by itself; use this only for those two states.",
      shape: { channel, thread_ts: messageTs.describe("The thread's root ts."), state: z.enum(["waiting", "done"]) },
      handler: async (args) => {
        const refusal = await dmRefusal(args.channel, args.thread_ts);
        if (refusal) return refusal;
        await ctx.markSession(args.channel, args.thread_ts, args.state);
        return `marked ${args.state}`;
      },
    }),
    defineTool({
      name: "get_message",
      description: "Read one message in full by its ts, for instance one that arrived cut short in a catch-up section.",
      shape: { channel, ts: messageTs },
      handler: async (args) => {
        const message = await slack.lookupMessage(args.channel, args.ts);
        if (!message) return "no such message";
        const refusal = await dmRefusal(args.channel, message.threadTs ?? message.ts);
        return refusal ?? renderHistory(slack, me, [message]);
      },
    }),
    defineTool({
      name: "get_file",
      description:
        "Download the files attached to a message you were not woken by (files on the message that woke you arrive by themselves). Returns where each file is on disk; open it from there. Find the message's ts with read_history, which lists file names.",
      shape: { channel, ts: messageTs, name: z.string().optional().describe("Only the file with this name. Omit for all of the message's files.") },
      handler: async (args) => {
        if (!ctx.canUploadLocalFiles) return "not available on your machine yet: files are downloaded to the bridge's disk, which you do not share.";
        const message = await slack.lookupMessage(args.channel, args.ts);
        if (!message) return "no such message";
        const refusal = await dmRefusal(args.channel, message.threadTs ?? message.ts);
        if (refusal) return refusal;
        const files = (await slack.lookupFiles(args.channel, args.ts)).filter((file) => !args.name || file.name === args.name);
        if (files.length === 0) return args.name ? `that message has no downloadable file named ${args.name}` : "that message has no downloadable files";
        const fetched = await ctx.fetchFiles(`slack:${args.channel}:${args.ts}`, files);
        return [...fetched.imagePaths.map((imagePath) => `image at ${imagePath}`), ...fetched.fileNotes].join("\n");
      },
    }),
    defineTool({
      name: "name_thread",
      description:
        "Give a thread a title. In the app's direct message with a person, titled threads appear in their sidebar as named sessions, so title the thread when you start a piece of work there. Works in channels too.",
      shape: { channel, thread_ts: messageTs.describe("The thread's root ts."), title: z.string().min(1).max(200) },
      handler: async (args) => {
        const refusal = await dmRefusal(args.channel, args.thread_ts);
        if (refusal) return refusal;
        // In the DM the title is how the person tells their sessions with different agents apart.
        const title = (await isDm(args.channel)) && !args.title.toLowerCase().startsWith(`${me} ·`) ? `${me} · ${args.title}`.slice(0, 200) : args.title;
        await slack.renameSession(args.channel, args.thread_ts, title);
        return `titled "${title}"`;
      },
    }),
    defineTool({
      name: "search_workspace",
      description:
        "Search messages in the workspace's public channels, and files, as the person who last addressed the app. Slack allows this for a while after someone @-mentions the app or DMs it; when no such token is at hand, the result says so and you should ask the person to @-mention the app in their next message.",
      shape: {
        query: z.string().min(1).describe("What to look for, in plain words or keywords."),
        channel: z.string().optional().describe("Keep only results from this conversation."),
        order: z.enum(["relevance", "newest", "oldest"]).optional().describe("Default relevance. Use newest for questions like \"the last time someone mentioned X\"."),
        include_files: z.boolean().optional().describe("Also search files. Default false."),
        limit: z.number().int().min(1).max(20).optional().describe("Results to return, at most 20."),
      },
      handler: async (args) => {
        const actionToken = ctx.latestActionToken();
        if (!actionToken) return "no search token: Slack grants one only when someone @-mentions the app or DMs it. Ask the person to @-mention the app in their next message, then search again.";
        let hits;
        try {
          hits = await slack.searchContext({ query: args.query, actionToken, channelId: args.channel ?? null, order: args.order ?? "relevance", includeFiles: Boolean(args.include_files), limit: args.limit ?? 10 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("invalid_action_token") || message.includes("action_token")) return "the search token has expired. Ask the person to @-mention the app in their next message, then search again.";
          throw error;
        }
        // Slack treats the conversation as a hint for ranking, not a filter, so the filtering is done here.
        if (args.channel) hits = hits.filter((hit) => hit.channelId === args.channel).slice(0, args.limit ?? 10);
        if (hits.length === 0) return "no results";
        const own = slack.identity();
        const names = new Map<string, string>();
        for (const hit of hits) {
          for (const match of hit.text.matchAll(/<@([A-Z0-9]+)/g)) if (!names.has(match[1]!)) names.set(match[1]!, (await slack.getPerson(match[1]!)).name);
        }
        const lines: string[] = [];
        for (const hit of hits) {
          const author = sanitizeHeader(hit.authorName ?? (hit.authorId ? (await slack.getPerson(hit.authorId)).name : "unknown"));
          const where = [hit.kind, sanitizeHeader(hit.title), hit.channelId ? `channel=${hit.channelId}` : null, hit.ts ? `ts=${hit.ts}` : null].filter(Boolean).join(" ");
          lines.push(`[${where}] ${author}: ${renderSlackText(hit.text, own.botUserId, names).replace(/[\r\n]+/g, " ⏎ ").slice(0, 600)}${hit.permalink ? ` (${hit.permalink})` : ""}`);
        }
        return lines.join("\n");
      },
    }),
    defineTool({
      name: "edit_message",
      description: "Edit a message you sent earlier.",
      shape: { channel, ts: messageTs, text: z.string().min(1) },
      handler: async (args) => {
        await slack.updateMessage(args.channel, args.ts, args.text);
        ctx.noteVisibleAction();
        return "edited";
      },
    }),
    defineTool({
      name: "delete_message",
      description: "Delete a message you sent earlier.",
      shape: { channel, ts: messageTs },
      handler: async (args) => {
        await slack.deleteMessage(args.channel, args.ts);
        return "deleted";
      },
    }),
    defineTool({
      name: "read_history",
      description:
        "Read messages from a conversation you are in, oldest first. Pass thread_ts to read one thread. You only receive messages that arrive while you are a member, so use this to catch up on a thread or channel before acting on it.",
      shape: {
        channel,
        thread_ts: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
        before: z.string().optional().describe("Only messages older than this ts."),
      },
      handler: async (args) => {
        if (await isDm(args.channel)) {
          if (!args.thread_ts) {
            const own = ctx.dm.sessions(args.channel);
            return own.length > 0 ? `In the direct message you can read your own sessions. Pass one as thread_ts: ${own.join(", ")}` : "You have no sessions in this direct message yet.";
          }
          const refusal = await dmRefusal(args.channel, args.thread_ts);
          if (refusal) return refusal;
        }
        const messages = await slack.readHistory({ channelId: args.channel, threadTs: args.thread_ts ?? null, limit: args.limit ?? 30, before: args.before ?? null });
        const newest = messages.at(-1);
        // Reading the latest page is catching up.
        if (newest && !args.before) ctx.noteRead(args.channel, args.thread_ts ?? "top", newest.ts);
        return renderHistory(slack, ctx.persona.username, messages);
      },
    }),
    defineTool({
      name: "list_channels",
      description: "List channels in the workspace with their ids and whether you are a member.",
      shape: { query: z.string().optional().describe("Substring of the channel name.") },
      handler: async (args) => {
        const channels = await slack.listConversations(args.query);
        return channels.length > 0 ? channels.map((item) => `#${item.name ?? "?"} (${item.id})${item.isMember ? " · member" : ""}`).join("\n") : "(no channels)";
      },
    }),
    defineTool({
      name: "list_people",
      description: "List the people and apps in the Slack workspace with their user ids, so you can mention or DM them. Your fellow agents are listed by list_agents, not here.",
      shape: {},
      handler: async () => {
        const own = slack.identity();
        const people = await slack.listPeople();
        return people
          .map((person) => `${person.name} (${person.id}) · ${person.id === own.botUserId ? "the app you and the other agents post through" : person.isBot ? "app" : "human"}${person.title ? ` · ${person.title}` : ""}`)
          .join("\n");
      },
    }),
    defineTool({
      name: "join_channel",
      description: "Join a public channel so you can read and post in it.",
      shape: { channel },
      handler: async (args) => {
        await slack.joinChannel(args.channel);
        return "joined";
      },
    }),
    defineTool({
      name: "open_dm",
      description: "Open (or find) your direct message conversation with a person and get its conversation id.",
      shape: { user: z.string().min(1).describe("User id, e.g. U0123.") },
      handler: async (args) => `channel=${await slack.openDm(args.user)}`,
    }),
    defineTool({
      name: "upload_files",
      description: "Upload local files into a conversation as yourself.",
      shape: {
        channel,
        thread_ts: z.string().optional(),
        paths: z.array(z.string().min(1)).min(1),
        comment: z.string().optional(),
      },
      handler: async (args) => {
        if (!ctx.canUploadLocalFiles) throw new Error("File upload is not available: your files are on a different machine than the Slack bridge.");
        const files = await validateSlackUploadFiles(args.paths.map((path) => ({ path })), ctx.uploadConfig);
        await slack.uploadFiles(args.channel, args.thread_ts ?? null, files, args.comment);
        ctx.noteVisibleAction();
        if (args.thread_ts) ctx.recordThreadParticipation(args.channel, args.thread_ts);
        return `uploaded ${files.length} file${files.length === 1 ? "" : "s"}`;
      },
    }),
    defineTool({
      name: "get_message_link",
      description: "Get a permalink to a Slack message.",
      shape: { channel, ts: messageTs },
      handler: async (args) => slack.getPermalink(args.channel, args.ts),
    }),
    defineTool({
      name: "get_current_time",
      description: "Get the current date and time in the workspace timezone.",
      shape: {},
      handler: async () =>
        `${new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, dateStyle: "full", timeStyle: "long" }).format(new Date())} (${ctx.timezone})`,
    }),
  ];
}
