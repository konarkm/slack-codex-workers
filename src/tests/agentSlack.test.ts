import { describe, expect, it } from "vitest";
import { AgentSlackClient } from "../slack/agentSlack.js";

// The real constructor starts a Bolt app, which calls Slack. These tests only need the client's methods over a fake API.
function clientWith(api: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>>): AgentSlackClient {
  const client = Object.create(AgentSlackClient.prototype) as AgentSlackClient;
  Object.assign(client, { agentName: "test", botToken: "xoxb-test", app: { client: api }, people: new Map(), botUsers: new Map(), conversations: new Map() });
  return client;
}

// A thread of 260 replies, served the way Slack does: oldest first, a page at a time, bounded by latest.
function longThread() {
  const all = Array.from({ length: 260 }, (_, index) => ({ ts: `1726600000.${String(index).padStart(6, "0")}`, thread_ts: "1726600000.000000", user: "U2", text: `m${index}` }));
  const calls: Array<Record<string, unknown>> = [];
  const replies = async (args: Record<string, unknown>) => {
    calls.push(args);
    const limit = args.limit as number;
    const latest = args.latest as string | undefined;
    const matching = all.filter((message) => !latest || message.ts < latest);
    const start = args.cursor ? Number(args.cursor) : 0;
    const page = matching.slice(start, start + limit);
    const next = start + limit < matching.length ? String(start + limit) : "";
    return { messages: page, has_more: Boolean(next), response_metadata: { next_cursor: next } };
  };
  return { replies, calls };
}

describe("AgentSlackClient.readHistory in a thread", () => {
  it("returns the newest replies of a long thread, and pages back from them with before", async () => {
    const thread = longThread();
    const client = clientWith({ conversations: { replies: thread.replies } });
    const newest = await client.readHistory({ channelId: "C1", threadTs: "1726600000.000000", limit: 30 });
    expect(newest.map((message) => message.text)).toEqual(Array.from({ length: 30 }, (_, index) => `m${230 + index}`));
    const earlier = await client.readHistory({ channelId: "C1", threadTs: "1726600000.000000", limit: 30, before: newest[0]!.ts });
    expect(earlier.map((message) => message.text)).toEqual(Array.from({ length: 30 }, (_, index) => `m${200 + index}`));
  });
});
