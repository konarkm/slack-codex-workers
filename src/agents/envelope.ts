import type { SlackChannelType, SlackHistoryMessage, SlackInbound, SlackReaction } from "../slack/agentSlack.js";
import type { WakePolicy } from "./types.js";

export type WakeReason = "addressed" | "default" | "none";

export interface WakeDecision {
  wake: boolean;
  // addressed: judged to be for this agent. default: a person's message was for nobody in particular, and this agent is the one who answers those.
  reason: WakeReason;
  // How sure the judgment was that the message is for this agent.
  probability: number | null;
  source: "jev" | "rules";
  // Set when the message would have woken the agent but the agent-to-agent budget for this conversation is spent.
  budgetExhausted?: boolean;
}

export interface EnvelopeAuthor {
  id: string;
  name: string;
  kind: "human" | "agent" | "app";
}

export interface ThreadContext {
  // Earlier messages in the thread, oldest first.
  messages: Array<{ author: string; ts: string; text: string }>;
  total: number;
}

export interface EnvelopeInput {
  message: SlackInbound;
  channelName: string | null;
  author: EnvelopeAuthor;
  decision: WakeDecision;
  // The shared app's bot user id; a literal @ of it means "the agents".
  appUserId: string;
  // Display names for user ids mentioned in the text.
  names: Map<string, string>;
  fileNotes: string[];
  imageCount: number;
  timezone: string;
  threadContext: ThreadContext | null;
}

const MAX_BODY_CHARS = 16_000;

export function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
}

export function replyTarget(message: SlackInbound): { channel: string; threadTs: string | null } {
  // In a DM, answer in the flow unless the person chose a thread. Elsewhere, stay flat under the thread root.
  if (message.channelType === "im") return { channel: message.channelId, threadTs: message.threadTs };
  return { channel: message.channelId, threadTs: message.threadTs ?? message.ts };
}

function describeWhere(channelType: SlackChannelType, channelName: string | null, channelId: string, threadTs: string | null): string {
  const place =
    channelType === "im" ? `direct message (${channelId})` : channelType === "mpim" ? `group DM (${channelId})` : `#${sanitizeHeader(channelName ?? "unknown")} (${channelId})`;
  return threadTs ? `${place}, in thread ${threadTs}` : `${place}, top level`;
}

export function formatTime(ts: string, timezone: string): string {
  const date = new Date(Number(ts.split(".")[0]) * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
  return parts.replace(",", "");
}

// Slack sends text with &, <, > already entity-escaped; angle brackets only ever delimit its own references.
// Resolve those references into plain words, then escape whatever brackets remain so content cannot forge a section boundary.
export function renderSlackText(text: string, ownUserId: string, names: Map<string, string>): string {
  const resolved = text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_match, id: string) => (id === ownUserId ? `@agents (${id})` : `@${names.get(id) ?? "unknown"} (${id})`))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => `#${name || "channel"} (${id})`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_match, word: string) => `@${word}`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => `${name || "@group"} (${id})`)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => `${label} (${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_match, url: string) => url);
  return resolved.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Header values come from Slack profiles, channel names, and file names, all of which people control.
// Without brackets or line breaks they cannot start a header line or a section of their own.
export function sanitizeHeader(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\r\n]+/g, " ");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[truncated by the bridge; read the full message with read_history]` : text;
}

function renderThreadContext(context: ThreadContext): string {
  const included = context.messages.length;
  const lines = context.messages.map((item, index) => `[${index + 1}] ${sanitizeHeader(item.author)} (ts ${item.ts}): ${item.text.replace(/[\r\n]+/g, " ⏎ ")}`);
  return [
    `<thread-context included="${included}" total="${context.total}" truncated="${included < context.total}">`,
    ...lines,
    "</thread-context>",
  ].join("\n");
}

export function renderEnvelope(input: EnvelopeInput): string {
  const { message, decision, author } = input;
  const target = replyTarget(message);
  const wakeAttribute = decision.wake ? decision.reason : "none";
  const fields = [
    `From: ${sanitizeHeader(author.name)} (${author.id}, ${author.kind})`,
    `Where: ${describeWhere(message.channelType, input.channelName, message.channelId, message.threadTs)}`,
    `Time: ${formatTime(message.ts, input.timezone)}`,
    `Message ts: ${message.ts}${message.editedAt ? " (this is an edit of a message you may have seen; the content below is the new version)" : ""}`,
    `Reply target: channel=${target.channel}${target.threadTs ? ` thread_ts=${target.threadTs}` : ""}`,
  ];
  if (decision.wake && decision.reason === "default") fields.push("Note: this was not clearly for any one agent; you are the one who picks those up.");
  if (decision.budgetExhausted) {
    fields.push("Note: this did not wake you. Agents have been waking each other here without a person; a person's message, or half an hour of quiet, resets that.");
  }
  const attachments = [...input.fileNotes.map(sanitizeHeader), ...(input.imageCount > 0 ? [`${input.imageCount} image${input.imageCount === 1 ? "" : "s"} attached to this input`] : [])];
  if (attachments.length > 0) fields.push(`Files: ${attachments.join("; ")}`);
  const sections: string[] = [];
  if (input.threadContext && input.threadContext.messages.length > 0) sections.push(renderThreadContext(input.threadContext));
  sections.push(
    [
      `<slack-message wake="${escapeAttribute(wakeAttribute)}">`,
      ...fields,
      "Content:",
      clip(renderSlackText(message.text, input.appUserId, input.names)) || "(no text)",
      "</slack-message>",
    ].join("\n"),
  );
  return sections.join("\n\n");
}

export interface ReactionEnvelopeInput {
  reaction: SlackReaction;
  channelType: SlackChannelType;
  channelName: string | null;
  author: EnvelopeAuthor;
  wake: boolean;
  // The agent's own message that was reacted to.
  target: { threadTs: string | null; text: string };
  appUserId: string;
  timezone: string;
}

// A reaction on one of the agent's own messages. Short: the emoji, who, and what it was on.
export function renderReactionEnvelope(input: ReactionEnvelopeInput): string {
  const { reaction, author } = input;
  const threadTs = input.target.threadTs ?? (input.channelType === "im" ? null : reaction.itemTs);
  const excerpt = renderSlackText(input.target.text, input.appUserId, new Map()).replace(/[\r\n]+/g, " ⏎ ");
  return [
    `<slack-reaction wake="${input.wake ? "addressed" : "none"}">`,
    `From: ${sanitizeHeader(author.name)} (${author.id}, ${author.kind})`,
    `Where: ${describeWhere(input.channelType, input.channelName, reaction.channelId, input.target.threadTs)}`,
    `Time: ${formatTime(reaction.eventTs, input.timezone)}`,
    `Reaction: :${sanitizeHeader(reaction.emoji)}:`,
    `On your message (ts ${reaction.itemTs}): ${excerpt.length > 300 ? `${excerpt.slice(0, 300)}…` : excerpt || "(no text)"}`,
    `Reply target: channel=${reaction.channelId}${threadTs ? ` thread_ts=${threadTs}` : ""}`,
    "</slack-reaction>",
  ].join("\n");
}

export function buildThreadContext(
  history: SlackHistoryMessage[],
  triggerTs: string,
  limit: number,
  describeAuthor: (message: SlackHistoryMessage) => string,
  renderText: (text: string) => string,
): ThreadContext {
  const earlier = history.filter((item) => item.ts < triggerTs);
  return {
    total: earlier.length,
    messages: earlier.slice(-limit).map((item) => ({ author: describeAuthor(item), ts: item.ts, text: renderText(item.text) })),
  };
}

// Channel and ts identify a message. The team id is left out: the two event types Slack sends for one mention disagree on it.
// An edit is its own input, so a corrected ask or a late @mention is heard.
export function sourceKey(message: SlackInbound): string {
  return `slack:${message.channelId}:${message.ts}${message.editedAt ? `:edited:${message.editedAt}` : ""}`;
}
