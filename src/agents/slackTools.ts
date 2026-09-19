import { z } from "zod";
import type { AgentSlackClient, SlackHistoryMessage, SlackPersona } from "../slack/agentSlack.js";
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
        const result = await slack.postMessage({ channelId: args.channel, text: args.text, threadTs: args.thread_ts ?? null, broadcast: args.broadcast, persona: ctx.persona });
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
      handler: async (args) =>
        renderHistory(slack, ctx.persona.username, await slack.readHistory({ channelId: args.channel, threadTs: args.thread_ts ?? null, limit: args.limit ?? 30, before: args.before ?? null })),
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
