import type { SlackChannelType, SlackHistoryMessage, SlackInbound } from "../slack/agentSlack.js";
import type { WakePolicy } from "./types.js";

export type WakeReason = "direct_message" | "mention" | "thread_reply" | "ambient";

export interface WakeDecision {
  reason: WakeReason;
  wake: boolean;
  // Set when the message would have woken the agent but the agent-to-agent budget for this thread is spent.
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
  ownUserId: string;
  // Display names for user ids mentioned in the text.
  names: Map<string, string>;
  fileNotes: string[];
  imageCount: number;
  timezone: string;
  threadContext: ThreadContext | null;
}

const MAX_BODY_CHARS = 16_000;

const WAKE_REASON_TEXT: Record<WakeReason, string> = {
  direct_message: "direct-message",
  mention: "mention",
  thread_reply: "thread-reply",
  ambient: "channel-message",
};

export function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
}

// Decides whether a message wakes the agent or only adds to what it knows. Nothing is dropped either way.
export function decideWake(message: SlackInbound, ownUserId: string, policy: WakePolicy, isThreadParticipant: boolean): WakeDecision {
  const mentioned = mentionsUser(message.text, ownUserId);
  // Other bots wake an agent only by naming it, so ambient chatter between agents cannot wake anyone.
  if (message.botId) return { reason: mentioned ? "mention" : "ambient", wake: mentioned && policy.mentions };
  if (message.channelType === "im") return { reason: "direct_message", wake: policy.directMessages };
  if (mentioned) return { reason: "mention", wake: policy.mentions };
  if (message.threadTs && isThreadParticipant) return { reason: "thread_reply", wake: policy.participatingThreads || policy.ambient };
  return { reason: "ambient", wake: policy.ambient };
}

export function replyTarget(message: SlackInbound): { channel: string; threadTs: string | null } {
  // In a DM, answer in the flow unless the person chose a thread. Elsewhere, stay flat under the thread root.
  if (message.channelType === "im") return { channel: message.channelId, threadTs: message.threadTs };
  return { channel: message.channelId, threadTs: message.threadTs ?? message.ts };
}

function describeWhere(channelType: SlackChannelType, channelName: string | null, channelId: string, threadTs: string | null): string {
  const place =
    channelType === "im" ? `direct message (${channelId})` : channelType === "mpim" ? `group DM (${channelId})` : `#${channelName ?? "unknown"} (${channelId})`;
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
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_match, id: string) => (id === ownUserId ? `@you (${id})` : `@${names.get(id) ?? "unknown"} (${id})`))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => `#${name || "channel"} (${id})`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_match, word: string) => `@${word}`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => `${name || "@group"} (${id})`)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => `${label} (${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_match, url: string) => url);
  return resolved.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[truncated by the bridge; read the full message with read_history]` : text;
}

function renderThreadContext(context: ThreadContext): string {
  const included = context.messages.length;
  const lines = context.messages.map((item, index) => `[${index + 1}] ${item.author} (ts ${item.ts}): ${item.text}`);
  return [
    `<thread-context included="${included}" total="${context.total}" truncated="${included < context.total}">`,
    ...lines,
    "</thread-context>",
  ].join("\n");
}

export function renderEnvelope(input: EnvelopeInput): string {
  const { message, decision, author } = input;
  const target = replyTarget(message);
  const wakeAttribute = decision.wake ? WAKE_REASON_TEXT[decision.reason] : "none";
  const fields = [
    `From: ${author.name} (${author.id}, ${author.kind})`,
    `Where: ${describeWhere(message.channelType, input.channelName, message.channelId, message.threadTs)}`,
    `Time: ${formatTime(message.ts, input.timezone)}`,
    `Message ts: ${message.ts}`,
    `Reply target: channel=${target.channel}${target.threadTs ? ` thread_ts=${target.threadTs}` : ""}`,
  ];
  if (decision.budgetExhausted) {
    fields.push("Note: this mention did not wake you. Agents have been waking each other in this thread without a human; a human message resets that.");
  }
  const attachments = [...input.fileNotes, ...(input.imageCount > 0 ? [`${input.imageCount} image${input.imageCount === 1 ? "" : "s"} attached to this input`] : [])];
  if (attachments.length > 0) fields.push(`Files: ${attachments.join("; ")}`);
  const sections: string[] = [];
  if (input.threadContext && input.threadContext.messages.length > 0) sections.push(renderThreadContext(input.threadContext));
  sections.push(
    [
      `<slack-message wake="${escapeAttribute(wakeAttribute)}">`,
      ...fields,
      "Content:",
      clip(renderSlackText(message.text, input.ownUserId, input.names)) || "(no text)",
      "</slack-message>",
    ].join("\n"),
  );
  return sections.join("\n\n");
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

export function sourceKey(message: SlackInbound): string {
  return `slack:${message.teamId}:${message.channelId}:${message.ts}`;
}
