// Live check against a real Slack workspace: real socket, real outbound posts, one simulated human mention.
// Usage: tsx scripts/smoke/liveHub.ts <channel-id> <human-user-id>
import { WebClient } from "@slack/web-api";
import { AgentHub } from "../../src/agents/hub.js";
import { config as loadDotEnv } from "dotenv";
import { loadHubConfig } from "../../src/agents/hubConfig.js";

loadDotEnv({ quiet: true });

const [channelId, humanUserId, question = "quick check: which channel is this, and what are you? One sentence."] = process.argv.slice(2);
if (!channelId || !humanUserId) throw new Error("usage: liveHub.ts <channel-id> <human-user-id>");

const hub = new AgentHub(loadHubConfig());
await hub.start();
const seat = [...(hub as unknown as { seats: Map<string, { slack: { identity(): { botUserId: string; teamId: string } } }> }).seats.values()][0]!;
const identity = seat.slack.identity();

const web = new WebClient(process.env.SLACK_BOT_TOKEN);
const anchor = await web.chat.postMessage({ channel: channelId, text: "_bridge test_: simulated human mention follows in this thread." });
console.log("anchor ts", anchor.ts);

await (hub as unknown as { handleInbound(seat: unknown, message: unknown): Promise<void> }).handleInbound(seat, {
  teamId: identity.teamId,
  channelId,
  channelType: "channel",
  ts: anchor.ts,
  threadTs: null,
  userId: humanUserId,
  botId: null,
  botUserId: null,
  text: `<@${identity.botUserId}> ${question}`,
  files: [],
});

await new Promise((resolve) => setTimeout(resolve, 60_000));
const replies = await web.conversations.replies({ channel: channelId, ts: anchor.ts! });
for (const message of replies.messages ?? []) console.log("THREAD>", message.bot_id ? "bot" : message.user, ":", message.text);
await hub.stop();
process.exit(0);
