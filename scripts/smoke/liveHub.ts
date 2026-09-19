// Live check against a real Slack workspace: real socket, real agents, real posts, real Jev judgments.
// Only the human's message is simulated (the bridge cannot post as a person). Agents run isolated from the operator's setup.
// Usage: tsx scripts/smoke/liveHub.ts <channel-id> <human-user-id> "<what the human says>" [seconds-to-wait]
import { WebClient } from "@slack/web-api";
import { config as loadDotEnv } from "dotenv";
import { AgentHub } from "../../src/agents/hub.js";
import { loadHubConfig } from "../../src/agents/hubConfig.js";
import { JevJudge, RuleJudge } from "../../src/agents/judge.js";

loadDotEnv({ quiet: true });
const [channelId, humanUserId, text = "ada, which channel is this? One sentence.", waitSeconds = "75"] = process.argv.slice(2);
if (!channelId || !humanUserId) throw new Error('usage: liveHub.ts <channel-id> <human-user-id> "<text>" [seconds]');

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const hub = new AgentHub(loadHubConfig(), apiKey ? new JevJudge({ apiKey }) : new RuleJudge());
await hub.start();

const web = new WebClient(process.env.SLACK_BOT_TOKEN);
const anchor = await web.chat.postMessage({ channel: channelId, text: `_bridge test_: simulating this from a person → "${text}"` });
await hub.handleInbound({
  teamId: "",
  channelId,
  channelType: "channel",
  ts: anchor.ts!,
  threadTs: null,
  userId: humanUserId,
  botId: null,
  botUserId: null,
  text,
  files: [],
  unavailableFiles: [],
  editedAt: null,
});

await new Promise((resolve) => setTimeout(resolve, Number(waitSeconds) * 1000));
const replies = await web.conversations.replies({ channel: channelId, ts: anchor.ts! });
for (const message of replies.messages ?? []) console.log("THREAD>", (message as { username?: string }).username ?? (message.bot_id ? "app" : message.user), ":", message.text);
await hub.stop();
process.exit(0);
