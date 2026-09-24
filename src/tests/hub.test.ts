import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHub, decideWakes, type HubConfig } from "../agents/hub.js";
import { AgentRegistry } from "../agents/registry.js";
import { RuleJudge, type JudgeInput, type Verdict, type WakeJudge } from "../agents/judge.js";
import { DEFAULT_DENY_TOOLS, type AgentRuntime, type AgentSpec, type RuntimeInput, type RuntimeOptions, type RuntimeState } from "../agents/types.js";
import type { AgentSlackClient, SlackInbound, SlackPersona, SlackReaction } from "../slack/agentSlack.js";

class FakeRuntime implements AgentRuntime {
  delivered: RuntimeInput[] = [];
  unconfirmed: string[] = [];
  interrupted = 0;
  // Holds stop() open until released, to widen the window while a seat is being replaced.
  stopGate: Promise<void> | null = null;
  private current: RuntimeState = "down";
  constructor(readonly options: RuntimeOptions) {}
  async start(): Promise<void> {
    if (this.current === "down") await this.set("idle");
  }
  async stop(): Promise<void> {
    await this.stopGate;
    await this.set("down");
  }
  async deliver(input: RuntimeInput): Promise<void> {
    await this.start();
    this.delivered.push(input);
    if (input.id) this.unconfirmed.push(input.id);
    await this.set("running");
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async compact(): Promise<void> {}
  state(): RuntimeState {
    return this.current;
  }
  sessionId(): string | null {
    return null;
  }
  async finishTurn(): Promise<void> {
    await this.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null, consumedInputIds: this.unconfirmed.splice(0), inputFault: false });
    await this.set("idle");
  }
  tool(name: string) {
    return this.options.tools.find((tool) => tool.name === name)!;
  }
  private async set(state: RuntimeState): Promise<void> {
    this.current = state;
    await this.options.events.onStateChanged(state);
  }
}

class FakeSlack {
  handler: ((message: SlackInbound) => Promise<void>) | null = null;
  stopHandler: ((where: { channelId: string | null; threadTs: string | null }) => Promise<void>) | null = null;
  reactionHandler: ((reaction: SlackReaction) => Promise<void>) | null = null;
  posted: Array<{ channelId: string; text: string; threadTs?: string | null; persona?: SlackPersona | null }> = [];
  statuses: Array<{ channelId: string; threadTs: string; status: string; persona?: string }> = [];
  history: Array<{ ts: string; threadTs: string | null; userId: string | null; botId: string | null; username: string | null; text: string; replyCount: number; fileNames: string[] }> = [];
  titles: Array<{ channelId: string; threadTs: string; title: string }> = [];
  searches: Array<{ query: string; actionToken: string }> = [];
  conversationLookups = 0;
  identity() {
    return { teamId: "T1", teamName: "Test", botUserId: "UAPP", botId: "BAPP", appId: null };
  }
  onMessage(handler: (message: SlackInbound) => Promise<void>) {
    this.handler = handler;
  }
  onReaction(handler: (reaction: SlackReaction) => Promise<void>) {
    this.reactionHandler = handler;
  }
  onStopRequested(handler: (where: { channelId: string | null; threadTs: string | null }) => Promise<void>) {
    this.stopHandler = handler;
  }
  titleHandler: ((change: { channelId: string; threadTs: string; title: string; userId: string | null }) => Promise<void>) | null = null;
  tabHandler: ((opened: { channelId: string; userId: string }) => Promise<void>) | null = null;
  prompts: Array<{ channelId: string; prompts: Array<{ title: string; message: string }> }> = [];
  onSessionTitleChanged(handler: (change: { channelId: string; threadTs: string; title: string; userId: string | null }) => Promise<void>) {
    this.titleHandler = handler;
  }
  onMessagesTabOpened(handler: (opened: { channelId: string; userId: string }) => Promise<void>) {
    this.tabHandler = handler;
  }
  async setSuggestedPrompts(channelId: string, prompts: Array<{ title: string; message: string }>) {
    this.prompts.push({ channelId, prompts });
  }
  async lookupMessage(_channelId: string, ts: string) {
    // What the agents posted through this fake is what a reaction can land on.
    const index = this.posted.findIndex((_post, i) => `17267000${String(90 + i + 1).padStart(2, "0")}.000900` === ts);
    const post = this.posted[index];
    if (!post) return null;
    return { ts, threadTs: post.threadTs ?? null, userId: null, botId: "BAPP", username: post.persona?.username ?? null, text: post.text, replyCount: 0, fileNames: [] };
  }
  async lookupFiles() {
    return [];
  }
  async renameSession(channelId: string, threadTs: string, title: string) {
    this.titles.push({ channelId, threadTs, title });
  }
  async searchContext(args: { query: string; actionToken: string }) {
    this.searches.push(args);
    return [{ kind: "message" as const, title: "#general", text: "the deploy key lives in 1password", permalink: null, channelId: "C1", ts: "1726600000.000100", authorId: "UHUMAN", authorName: "Konark" }];
  }
  async identify() {
    return this.identity();
  }
  async connect() {}
  async stop() {}
  async openDm(userId: string) {
    return `D-${userId}`;
  }
  async getPerson(id: string) {
    return { id, name: id === "UHUMAN" ? "Konark" : id, isBot: id.startsWith("UBOT"), title: null };
  }
  async getConversation(id: string) {
    this.conversationLookups += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id, name: "general", type: id.startsWith("D") ? ("im" as const) : ("channel" as const), isMember: true };
  }
  async readHistory() {
    return this.history;
  }
  async postMessage(args: { channelId: string; text: string; threadTs?: string | null; persona?: SlackPersona | null }) {
    this.posted.push(args);
    return { ts: `17267000${String(90 + this.posted.length).padStart(2, "0")}.000900`, permalink: null };
  }
  async setThreadStatus(channelId: string, threadTs: string, status: string, persona?: SlackPersona | null) {
    this.statuses.push({ channelId, threadTs, status, persona: persona?.username });
  }
  botTokenForDownloads() {
    return "xoxb-test";
  }
}

// A judge the test scripts: whoever is named in `for` is the one the message is for.
class ScriptedJudge implements WakeJudge {
  inputs: JudgeInput[] = [];
  next: { for?: string[]; stop?: string[]; urgency?: Verdict["urgency"] } = {};
  // Holds the judgment open until released, to widen the window between routing and delivery.
  gate: Promise<void> | null = null;
  async judge(input: JudgeInput): Promise<Verdict> {
    this.inputs.push(input);
    const script = this.next;
    await this.gate;
    return {
      needs: new Map(input.agents.map((agent) => [agent.name, script.for?.includes(agent.name) ? 0.95 : 0.03])),
      stop: new Map(input.agents.filter((agent) => agent.working).map((agent) => [agent.name, script.stop?.includes(agent.name) ? 0.95 : 0.01])),
      urgency: script.urgency ?? "next",
      source: "jev",
    };
  }
}

function inbound(overrides: Partial<SlackInbound> = {}): SlackInbound {
  return { teamId: "T1", channelId: "C1", channelType: "channel", ts: "1726700000.000100", threadTs: null, userId: "UHUMAN", botId: null, botUserId: null, text: "hello", files: [], unavailableFiles: [], editedAt: null, ...overrides };
}

async function toolsListStatus(runtime: FakeRuntime): Promise<number> {
  const response = await fetch(runtime.options.toolAccess.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${runtime.options.toolAccess.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

let dir: string;
let hub: AgentHub;
let slack: FakeSlack;
let judge: ScriptedJudge;
let runtimes: Map<string, FakeRuntime>;

async function startHub(agents: unknown[], overrides: Partial<HubConfig> = {}): Promise<void> {
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ agents }));
  const config: HubConfig = {
    agentsFile: path.join(dir, "agents.json"),
    agentsRoot: path.join(dir, "homes"),
    databasePath: path.join(dir, "agents.sqlite"),
    timezone: "America/Los_Angeles",
    codexBin: "codex",
    slackUploadMaxFiles: 10,
    adminUserIds: ["UHUMAN"],
    agentWakeBudget: 2,
    threadContextLimit: 12,
    // Port 0: the OS picks a free one for each test hub.
    toolServer: { port: 0, bindHost: "127.0.0.1", publicUrl: null },
    webhooks: null,
    attachmentStorageDir: path.join(dir, "attachments"),
    attachmentMaxBytes: 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 1000,
    ...overrides,
  };
  hub = new AgentHub(
    config,
    judge,
    () => slack as unknown as AgentSlackClient,
    (options) => {
      const runtime = new FakeRuntime(options);
      runtimes.set(options.spec.name, runtime);
      return runtime;
    },
  );
  await hub.start();
}

// Waits for the hub to finish everything it has taken in, rather than sleeping and hoping, which failed on a busy machine.
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await (hub as unknown as { intake: Promise<void> }).intake;
  await new Promise((resolve) => setTimeout(resolve, 5));
};
const delivered = (name: string) => runtimes.get(name)?.delivered ?? [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  slack = new FakeSlack();
  judge = new ScriptedJudge();
  runtimes = new Map();
  process.env.SLACK_BOT_TOKEN = "xoxb-team";
  process.env.SLACK_APP_TOKEN = "xapp-team";
});

afterEach(async () => {
  await hub?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TEAM = [{ name: "ada", runtime: "claude", title: "manager", icon: ":brain:" }, { name: "cody", runtime: "codex", title: "builder" }];

describe("AgentHub", () => {
  it("gives a message only to the agent it is said to; another agent catches up on what it missed when it is brought in", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "can you fix the deploy script" }));
    expect(delivered("cody")).toHaveLength(1);
    expect(delivered("cody")[0]!.text).toContain('wake="addressed"');
    expect(delivered("ada")).toHaveLength(0);
    // Nothing went into ada's context. Brought in, she is handed what the channel said since she last looked.
    const said = (ts: string, text: string) => ({ ts, threadTs: null, userId: "UHUMAN", botId: null, username: null, text, replyCount: 0, fileNames: [] });
    slack.history = [said("1726700000.000100", "can you fix the deploy script")];
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "ada what do you make of that" }));
    expect(delivered("ada")).toHaveLength(1);
    const text = delivered("ada")[0]!.text;
    expect(text).toContain('<channel-context included="1" total="1" truncated="false">');
    expect(text).toContain("can you fix the deploy script");
    expect(text).toContain("what do you make of that");
    // She is not handed the same catch-up twice.
    await runtimes.get("ada")!.finishTurn();
    slack.history.push(said("1726700001.000100", "ada what do you make of that"));
    await slack.handler!(inbound({ ts: "1726700002.000100", text: "ada and now?" }));
    expect(delivered("ada").at(-1)!.text).not.toContain("-context");
  });

  it("tells each agent who else the same message woke, so they can settle who takes it", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada", "cody"] };
    await slack.handler!(inbound({ text: "can someone look at the failing build" }));
    expect(delivered("ada")[0]!.text).toContain("Also woken by this message: cody");
    expect(delivered("cody")[0]!.text).toContain("Also woken by this message: ada");
  });

  it("tells the judge who is in the room, what they do, and what was just said", async () => {
    await startHub(TEAM);
    await slack.handler!(inbound({ text: "the deploy is failing again" }));
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "can someone look" }));
    const input = judge.inputs.at(-1)!;
    expect(input.agents.map((agent) => `${agent.name}:${agent.role}`)).toEqual(["ada:manager", "cody:builder"]);
    expect(input.recent).toEqual([{ from: "Konark (human)", text: "the deploy is failing again" }]);
    expect(input.message).toEqual({ from: "Konark (human)", text: "can someone look" });
    expect(input.conversation).toMatchObject({ kind: "channel", name: "general", inThread: false });
  });

  it("routes a channel message and a DM into the same mind", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada what is the plan?" }));
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700001.000100", text: "and in private?" }));
    expect(runtimes.size).toBe(2);
    expect(delivered("ada")).toHaveLength(2);
    expect(delivered("ada")[0]!.text).toContain("Where: #general (C1), top level");
    expect(delivered("ada")[1]!.text).toContain("Where: direct message (D1)");
    expect(delivered("ada")[1]!.text).toContain("arrived while you were working");
  });

  it("never leaves a person's DM with nobody listening: the default agent picks it up", async () => {
    await startHub(TEAM);
    judge.next = { for: [] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: "hm, thinking out loud here" }));
    expect(delivered("ada")).toHaveLength(1);
    expect(delivered("ada")[0]!.text).toContain('wake="default"');
    expect(delivered("cody")).toHaveLength(0);
  });

  it("posts under each agent's own name and icon through the one app", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada hi" }));
    await runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: "on it", thread_ts: "1726700000.000100" } as never);
    expect(slack.posted[0]).toMatchObject({ channelId: "C1", threadTs: "1726700000.000100", persona: { username: "ada", icon: ":brain:" } });
    expect(slack.statuses[0]).toMatchObject({ status: "processing", persona: "ada" });
  });

  it("lets agents hear each other: what one says reaches the others, attributed, and can wake them", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada get cody to fix the deploy" }));
    judge.next = { for: ["cody"] };
    await runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: "cody, can you fix the deploy script?", thread_ts: "1726700000.000100" } as never);
    await flush();
    expect(delivered("cody")).toHaveLength(1);
    const text = delivered("cody")[0]!.text;
    expect(text).toContain("From: ada (ada, agent)");
    expect(text).toContain("can you fix the deploy script?");
    // ada does not receive her own message back.
    expect(delivered("ada")).toHaveLength(1);
    expect(judge.inputs.at(-1)!.agents.map((agent) => agent.name)).toEqual(["cody"]);
  });

  it("leaves it to the agent, never the judge, whether an acknowledgement needs anything", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada hi" }));
    judge.next = { for: ["cody"] };
    await runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: "thanks cody", thread_ts: "1726700000.000100" } as never);
    await flush();
    expect(delivered("cody")).toHaveLength(1);
  });

  it("stops agents waking each other after the budget, until a person speaks", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada and cody, sort this out" }));
    judge.next = { for: ["cody"] };
    const say = (n: number) => runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: `cody, round ${n}`, thread_ts: "1726700000.000100" } as never);
    await say(1);
    await say(2);
    await say(3);
    await flush();
    expect(delivered("cody")).toHaveLength(2);
    // Round 3 stayed in Slack. When a person brings cody back in, it arrives as something he missed.
    slack.history = [{ ts: "1726700093.000900", threadTs: "1726700000.000100", userId: null, botId: "BAPP", username: "ada", text: "cody, round 3", replyCount: 0, fileNames: [] }];
    await slack.handler!(inbound({ ts: "1726700099.000100", threadTs: "1726700000.000100", text: "cody carry on" }));
    const last = delivered("cody").at(-1)!.text;
    expect(last).toContain("<thread-context");
    expect(last).toContain("ada (agent)");
    expect(last).toContain("round 3");
    await say(4);
    await flush();
    expect(delivered("cody")).toHaveLength(4);
  });

  it("never makes an agent deaf to an outside app", async () => {
    await startHub(TEAM, { agentWakeBudget: 1 });
    judge.next = { for: ["cody"] };
    for (const n of [1, 2, 3]) {
      await slack.handler!(inbound({ userId: null, botId: "BCI", ts: `1726700040.00000${n}`, threadTs: "1726700040.000000", text: `cody build ${n} failed` }));
    }
    expect(delivered("cody")).toHaveLength(3);
  });

  it("stops a working agent when a person tells it to in plain words, and still delivers the message", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody rebuild everything" }));
    judge.next = { for: ["cody"], stop: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700002.000100", text: "wait cody stop, wrong branch" }));
    expect(runtimes.get("cody")!.interrupted).toBe(1);
    expect(delivered("cody")).toHaveLength(2);
    expect(runtimes.get("ada")?.interrupted ?? 0).toBe(0);
  });

  it("handles Slack's concurrent double delivery of one message once, in order", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    const mention = inbound({ text: "ada hi" });
    await Promise.all([slack.handler!(mention), slack.handler!({ ...mention, teamId: "TOTHER" })]);
    expect(delivered("ada")).toHaveLength(1);
    expect(judge.inputs).toHaveLength(1);
  });

  it("hears an edit as its own input", async () => {
    await startHub(TEAM);
    judge.next = { for: [] };
    await slack.handler!(inbound({ ts: "1726700050.000100", text: "can someone check the deploy" }));
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700050.000100", editedAt: "1726700055.000000", text: "cody can you check the deploy" }));
    expect(delivered("cody")[0]!.text).toContain("this is an edit");
  });

  it("backfills a thread an agent has not seen, once, naming which agent said what", async () => {
    await startHub(TEAM);
    slack.history = [
      { ts: "1726600000.000001", threadTs: "1726600000.000001", userId: "UHUMAN", botId: null, username: null, text: "root question", replyCount: 2, fileNames: [] },
      { ts: "1726600000.000002", threadTs: "1726600000.000001", userId: null, botId: "BAPP", username: "cody", text: "my take", replyCount: 0, fileNames: [] },
    ];
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ ts: "1726600000.000003", threadTs: "1726600000.000001", text: "ada can you weigh in?" }));
    const text = delivered("ada")[0]!.text;
    expect(text).toContain('<thread-context included="2" total="2" truncated="false">');
    expect(text).toContain("cody (agent)");
    await runtimes.get("ada")!.finishTurn();
    await slack.handler!(inbound({ ts: "1726600000.000004", threadTs: "1726600000.000001", text: "ada and now?" }));
    expect(delivered("ada").at(-1)!.text).not.toContain("<thread-context");
  });

  it("lets an agent create a new agent with no clicks, reachable at once and after a restart", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada we need someone watching releases" }));
    const result = await runtimes.get("ada")!.tool("create_agent").handler({ name: "scout", title: "release watcher", runtime: "claude", icon: ":satellite:", instructions: "You watch releases." } as never);
    expect(result).toContain("created scout");
    judge.next = { for: ["scout"] };
    await slack.handler!(inbound({ ts: "1726700003.000100", text: "scout are you there?" }));
    expect(delivered("scout")).toHaveLength(1);
    expect(runtimes.get("scout")!.options.instructions).toContain("You watch releases.");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")) as { agents: Array<{ name: string; createdBy?: string }> };
    expect(saved.agents.find((agent) => agent.name === "scout")).toMatchObject({ createdBy: "ada" });
    await expect(runtimes.get("ada")!.tool("create_agent").handler({ name: "scout", title: "x", runtime: "claude", instructions: "x" } as never)).rejects.toThrow(/already exists/);
    expect(await runtimes.get("ada")!.tool("list_agents").handler({} as never)).toContain("scout · release watcher");
  });

  it("routes Slack's stop button to the agent shown working in that thread", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody long task" }));
    await slack.stopHandler!({ channelId: "C1", threadTs: "1726700000.000100" });
    expect(runtimes.get("cody")!.interrupted).toBe(1);
    expect(runtimes.get("ada")?.interrupted ?? 0).toBe(0);
  });

  it("answers operator commands from admins in the DM, once, without waking anyone", async () => {
    await startHub(TEAM);
    const command = inbound({ channelId: "D1", channelType: "im", text: ".status" });
    await Promise.all([slack.handler!(command), slack.handler!(command)]);
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]!.text).toContain("_bridge_");
    expect(slack.posted[0]!.text).toContain("*ada*");
    expect(slack.posted[0]!.persona ?? null).toBeNull();
    expect(delivered("ada")).toHaveLength(0);
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700009.000100", text: ".reset" }));
    expect(slack.posted[1]!.text).toContain("Which agent?");
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ channelId: "D2", channelType: "im", ts: "1726700004.000100", userId: "USOMEONE", text: ".status" }));
    expect(delivered("ada")).toHaveLength(1);
  });

  it("always brings a reaction on an agent's own message to that agent, once", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada is the deploy done" }));
    await runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: "yes, deployed at noon", thread_ts: "1726700000.000100" } as never);
    await runtimes.get("ada")!.finishTurn();
    await flush();
    const posted = "1726700091.000900";
    const asked = judge.inputs.length;
    // Even a thumbs-up: what it means is for ada, who knows what she said, to decide.
    await slack.reactionHandler!({ channelId: "C1", itemTs: posted, emoji: "+1", userId: "UHUMAN", eventTs: "1726700010.000100" });
    expect(delivered("ada")).toHaveLength(2);
    const text = delivered("ada")[1]!.text;
    expect(text).toContain('<slack-reaction wake="addressed"');
    expect(text).toContain("Reaction: :+1:");
    expect(text).toContain("On your message (ts 1726700091.000900): yes, deployed at noon");
    expect(text).toContain("Reply target: channel=C1 thread_ts=1726700000.000100");
    // Nobody is asked who a reaction is for; it is for whoever wrote the message.
    expect(judge.inputs).toHaveLength(asked);
    expect(delivered("cody")).toHaveLength(0);
    // The same reaction, delivered twice by Slack, is heard once; a reaction on a person's message is ignored.
    await slack.reactionHandler!({ channelId: "C1", itemTs: posted, emoji: "+1", userId: "UHUMAN", eventTs: "1726700010.000100" });
    await slack.reactionHandler!({ channelId: "C1", itemTs: "1726700000.000100", emoji: "x", userId: "UHUMAN", eventTs: "1726700012.000100" });
    expect(delivered("ada")).toHaveLength(2);
  });

  it("lets an agent title a thread, and search as the person who last addressed the app", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: "ada where is the deploy key" }));
    const ada = runtimes.get("ada")!;
    await ada.tool("name_thread").handler({ channel: "D1", thread_ts: "1726700000.000100", title: "Deploy key" } as never);
    // The bridge names a new DM session after its agent at once; the agent's own title keeps that prefix.
    expect(slack.titles).toEqual([
      { channelId: "D1", threadTs: "1726700000.000100", title: "ada" },
      { channelId: "D1", threadTs: "1726700000.000100", title: "ada · Deploy key" },
    ]);
    // No token yet: Slack only attaches one to @-mentions and DMs the app saw as such.
    expect(await ada.tool("search_workspace").handler({ query: "deploy key" } as never)).toContain("no search token");
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700001.000100", text: "<@UAPP> where is the deploy key", actionToken: "tok-1" }));
    const result = await ada.tool("search_workspace").handler({ query: "deploy key" } as never);
    expect(slack.searches).toEqual([{ query: "deploy key", actionToken: "tok-1", channelId: null, order: "relevance", includeFiles: false, limit: 10 }]);
    expect(result).toContain("Konark: the deploy key lives in 1password");
  });

  it("gives each DM thread to one agent: only it hears the thread, whoever is named, and no other agent can read or write there", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: "cody can you look at the build" }));
    expect(delivered("cody")).toHaveLength(1);
    expect(delivered("cody")[0]!.text).toContain("Reply target: channel=D1 thread_ts=1726700000.000100");
    // Naming ada inside cody's session does not bring her in.
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700001.000100", threadTs: "1726700000.000100", text: "ada what do you think" }));
    expect(delivered("ada")).toHaveLength(0);
    expect(delivered("cody")).toHaveLength(2);
    const ada = runtimes.get("ada") ?? (await (async () => { judge.next = { for: ["ada"] }; await slack.handler!(inbound({ ts: "1726700002.000100", text: "ada hi" })); return runtimes.get("ada")!; })());
    expect(await ada.tool("read_history").handler({ channel: "D1", thread_ts: "1726700000.000100" } as never)).toContain("cody's session");
    expect(await ada.tool("send_message").handler({ channel: "D1", thread_ts: "1726700000.000100", text: "hello" } as never)).toContain("cody's session");
    expect(slack.posted).toHaveLength(0);
    // A new top-level DM for nobody in particular opens a separate session with the default agent.
    judge.next = {};
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700005.000100", text: "what's on today" }));
    expect(delivered("ada").at(-1)!.text).toContain("what's on today");
    expect(delivered("ada").at(-1)!.text).not.toContain("-context");
    expect(await ada.tool("read_history").handler({ channel: "D1" } as never)).toContain("1726700005.000100");
    expect(await ada.tool("read_history").handler({ channel: "D1" } as never)).not.toContain("1726700000.000100");
  });

  it("shows an agent what is new elsewhere as counts, like unread badges, and clears them when asked", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody fix the deploy" }));
    await slack.handler!(inbound({ ts: "1726700001.000100", threadTs: "1726700000.000100", text: "and the tests" }));
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700002.000100", text: "cody, privately: the key is in 1password" }));
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ channelId: "C2", ts: "1726700003.000100", text: "ada hi" }));
    const ada = runtimes.get("ada")!;
    const first = await ada.tool("whats_new").handler({} as never);
    expect(first).toContain("channel=C1, main line): 1 new");
    expect(first).toContain("channel=C1 thread_ts=1726700000.000100): 1 new");
    expect(first).toContain("from Konark");
    // Where she was just woken is not news to her, and another agent's DM session is none of her business.
    expect(first).not.toContain("C2");
    expect(first).not.toContain("D1");
    expect(await ada.tool("whats_new").handler({} as never)).toBe("nothing new since you last looked");
  });

  it("catches an agent up on a channel only from the last day", async () => {
    await startHub(TEAM);
    const said = (ts: string, text: string) => ({ ts, threadTs: null, userId: "UHUMAN", botId: null, username: null, text, replyCount: 0, fileNames: [] });
    slack.history = [said("1726500000.000100", "last week's argument"), said("1726699000.000100", "the deploy is red again")];
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada can you look" }));
    const text = delivered("ada")[0]!.text;
    expect(text).toContain("the deploy is red again");
    expect(text).not.toContain("last week's argument");
  });

  it("gives agents the runtime's default model, and lets an agent set another's model and effort", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada hi" }));
    const ada = runtimes.get("ada")!;
    expect(ada.options.spec.model).toBe("claude-opus-5-5");
    expect(runtimes.get("cody")!.options.spec.model).toBe("gpt-6-sol");
    // Effort is checked against what the agent's harness accepts.
    expect(await ada.tool("update_agent").handler({ name: "ada", effort: "ultra" } as never)).toContain('claude agents take effort low, medium, high, xhigh, max, or "default"');
    expect(await ada.tool("update_agent").handler({ name: "cody", model: "gpt-6-astra", effort: "ultra" } as never)).toContain("running with the change");
    expect(runtimes.get("cody")!.options.spec).toMatchObject({ model: "gpt-6-astra", effort: "ultra" });
    expect(await ada.tool("list_agents").handler({} as never)).toContain("cody · builder · gpt-6-astra (ultra effort)");
    // "default" hands both back to the runtime's default.
    await ada.tool("update_agent").handler({ name: "cody", model: "default", effort: "default" } as never);
    expect(runtimes.get("cody")!.options.spec).toMatchObject({ model: "gpt-6-sol", effort: null });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")).agents.find((entry: { name: string }) => entry.name === "cody")).not.toHaveProperty("model");
    expect(await ada.tool("create_agent").handler({ name: "scout", title: "researcher", runtime: "claude", effort: "high", instructions: "You research." } as never)).toContain("created scout");
    expect(runtimes.get("scout")!.options.spec).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  });

  it("lets an agent repurpose, retire, revive, and delete agents, and keeps a retired one from hearing anything", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada hi" }));
    const ada = runtimes.get("ada")!;
    // Repurpose cody: new role and instructions, same name; he restarts with them.
    expect(await ada.tool("update_agent").handler({ name: "cody", title: "release manager", instructions: "You ship releases." } as never)).toContain("running with the change");
    expect(await ada.tool("list_agents").handler({} as never)).toContain("cody · release manager");
    expect(runtimes.get("cody")!.options.instructions).toContain("You ship releases.");
    expect(fs.readFileSync(path.join(dir, "homes", "cody", "AGENT.md"), "utf8")).toContain("You ship releases.");
    // Retire cody: nothing reaches him, and the roster says so.
    expect(await ada.tool("retire_agent").handler({ name: "cody", reason: "release done" } as never)).toContain("retired cody");
    const codyRuntime = runtimes.get("cody")!;
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "cody are you there" }));
    expect(codyRuntime.delivered).toHaveLength(0);
    expect(await ada.tool("list_agents").handler({} as never)).toContain("cody · release manager · gpt-6-sol · retired");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")).agents.find((entry: { name: string }) => entry.name === "cody")).toMatchObject({ retired: true, retiredReason: "release done" });
    // The last agent listening cannot retire.
    expect(await ada.tool("retire_agent").handler({ name: "ada", reason: "bored" } as never)).toContain("only agent listening");
    // Revive cody: he hears again, and his message arrives with the current instructions.
    expect(await ada.tool("revive_agent").handler({ name: "cody" } as never)).toContain("revived cody");
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700002.000100", text: "cody welcome back" }));
    expect(runtimes.get("cody")!.delivered).toHaveLength(1);
    // Delete: gone from the roster and the bridge's records; an agent cannot delete itself.
    expect(await ada.tool("delete_agent").handler({ name: "ada", reason: "x", confirm: true } as never)).toContain("cannot delete yourself");
    expect(await ada.tool("delete_agent").handler({ name: "cody", reason: "never needed again", confirm: true } as never)).toBe("deleted cody.");
    expect(fs.existsSync(path.join(dir, "homes", "cody"))).toBe(false);
    expect(await ada.tool("list_agents").handler({} as never)).not.toContain("cody");
    await slack.handler!(inbound({ ts: "1726700003.000100", text: "cody?" }));
    expect(runtimes.get("cody")!.delivered).toHaveLength(1);
  });

  it("lets an agent retire itself, taking effect when its turn ends", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody wrap up" }));
    const cody = runtimes.get("cody")!;
    expect(await cody.tool("retire_agent").handler({ name: "cody", reason: "job done" } as never)).toContain("end of this turn");
    // Still able to speak during the turn.
    await cody.tool("send_message").handler({ channel: "C1", text: "signing off", thread_ts: "1726700000.000100" } as never);
    expect(slack.posted).toHaveLength(1);
    await cody.finishTurn();
    await flush();
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "cody one more thing" }));
    expect(cody.delivered).toHaveLength(1);
  });

  it("keeps an agent that retired itself running when it is revived before its turn ends, with working tool access", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody wrap up" }));
    const cody = runtimes.get("cody")!;
    await cody.tool("retire_agent").handler({ name: "cody", reason: "job done" } as never);
    const ada = runtimes.get("ada")!;
    expect(await ada.tool("revive_agent").handler({ name: "cody" } as never)).toContain("revived cody");
    // Same mind, still mid-turn, and its tools still answer.
    expect(runtimes.get("cody")).toBe(cody);
    expect(await toolsListStatus(cody)).toBe(200);
    await cody.finishTurn();
    await flush();
    // The turn's end restarts it with the revived spec; the old seat's token is gone and the new one works.
    const restarted = runtimes.get("cody")!;
    expect(restarted).not.toBe(cody);
    expect(await toolsListStatus(cody)).toBe(401);
    expect(await toolsListStatus(restarted)).toBe(200);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "cody still there?" }));
    expect(restarted.delivered).toHaveLength(1);
  });

  it("leaves one running seat with valid tool access when updates to the same agent overlap", async () => {
    await startHub(TEAM);
    const ada = runtimes.get("ada")!;
    const before = runtimes.get("cody")!;
    await Promise.all([
      ada.tool("update_agent").handler({ name: "cody", title: "release manager" } as never),
      ada.tool("update_agent").handler({ name: "cody", title: "release captain" } as never),
    ]);
    const after = runtimes.get("cody")!;
    expect(await toolsListStatus(before)).toBe(401);
    expect(await toolsListStatus(after)).toBe(200);
    expect(await ada.tool("list_agents").handler({} as never)).toContain("cody · release captain");
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "cody, new role?" }));
    expect(after.delivered).toHaveLength(1);
  });

  it("keeps the owner's name on a DM session the person renamed, offers starters from the live roster, and lets an agent mark a session waiting or done", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: "cody look at the build" }));
    await slack.titleHandler!({ channelId: "D1", threadTs: "1726700000.000100", title: "Build fix", userId: "UHUMAN" });
    expect(slack.titles.at(-1)).toEqual({ channelId: "D1", threadTs: "1726700000.000100", title: "cody · Build fix" });
    await slack.titleHandler!({ channelId: "D1", threadTs: "1726700000.000100", title: "cody · Build fix", userId: "UHUMAN" });
    expect(slack.titles.filter((title) => title.title === "cody · Build fix")).toHaveLength(1);

    await slack.tabHandler!({ channelId: "D1", userId: "UHUMAN" });
    expect(slack.prompts[0]!.prompts.map((prompt) => prompt.title)).toEqual(["Who is around?", "Talk to ada", "Talk to cody"]);

    const cody = runtimes.get("cody")!;
    await cody.tool("mark_session").handler({ channel: "D1", thread_ts: "1726700000.000100", state: "waiting" } as never);
    expect(slack.statuses.at(-1)).toMatchObject({ status: "suspended", persona: "cody" });
    await cody.finishTurn();
    await flush();
    // The end of the turn does not overwrite what the agent said about the session.
    expect(slack.statuses.at(-1)).toMatchObject({ status: "suspended" });
  });

  it("tells an agent what the person had open when they wrote a DM", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: "what's going on here", viewing: [{ kind: "channel_id", value: "C1" }, { kind: "thread_ts", value: "1726600000.000001" }] }));
    expect(delivered("ada")[0]!.text).toContain("Viewing: #general (C1), thread 1726600000.000001");
  });

  it("tells the operators, as the bridge, when it gives up on someone's message", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada poison" }));
    const runtime = runtimes.get("ada")!;
    for (let round = 0; round < 3; round += 1) {
      await runtime.options.events.onTurnCompleted({ status: "failed", finalText: "", error: "image rejected", consumedInputIds: runtime.unconfirmed.splice(0), inputFault: true });
      if (round < 2) {
        // Skip the retry wait rather than sleeping through it.
        const mind = (hub as unknown as { seats: Map<string, { mind: { pump(): Promise<void>; holdUntil: number } }> }).seats.get("ada")!.mind;
        mind.holdUntil = 0;
        await mind.pump();
      }
    }
    expect(slack.posted.some((post) => post.channelId === "D-UHUMAN" && post.text.includes("_bridge (ada)_") && post.text.includes("stopped trying"))).toBe(true);
  });

  it("clears an agent's icon when it is updated to an empty one, and the roster still loads after", async () => {
    await startHub(TEAM);
    expect(await runtimes.get("cody")!.tool("update_agent").handler({ name: "ada", icon: "" } as never)).toContain("updated ada");
    expect(new AgentRegistry(path.join(dir, "agents.json"), path.join(dir, "homes")).spec("ada")!.icon).toBeNull();
  });

  it("starts the other agents, and tells the operators, when one agent's seat cannot be built", async () => {
    // An ssh agent with no tool-server address cannot be given its tools.
    await startHub([...TEAM, { name: "remote", runtime: "codex", title: "builder", host: "ssh:grok-bot", cwd: "/home/x/agent" }]);
    expect(runtimes.has("ada")).toBe(true);
    expect(runtimes.has("cody")).toBe(true);
    expect(slack.posted.some((post) => post.channelId === "D-UHUMAN" && post.text.includes("remote did not start"))).toBe(true);
  });

  it("deletes only the home the bridge made for an agent, never a directory another agent works in", async () => {
    const adaHome = path.join(dir, "homes", "ada");
    await startHub([
      { name: "ada", runtime: "claude", cwd: adaHome },
      { name: "cody", runtime: "codex", cwd: adaHome },
      { name: "scout", runtime: "claude" },
      { name: "rex", runtime: "claude", cwd: path.join(dir, "homes", "scout", "rex") },
    ]);
    fs.writeFileSync(path.join(adaHome, "notes.md"), "ada's notes");
    expect(await runtimes.get("ada")!.tool("delete_agent").handler({ name: "cody", reason: "x", confirm: true } as never)).toBe("deleted cody.");
    expect(fs.existsSync(path.join(adaHome, "notes.md"))).toBe(true);
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: ".delete scout" }));
    expect(slack.posted.at(-1)!.text).toContain("deleted scout");
    expect(fs.existsSync(path.join(dir, "homes", "scout", "rex"))).toBe(true);
  });

  it("hands a message routed while its agent's seat is replaced to the seat that is live, at once", async () => {
    await startHub(TEAM);
    const ada = runtimes.get("ada")!;
    // Replaced while the judgment is out.
    let judged!: () => void;
    judge.gate = new Promise((resolve) => (judged = resolve));
    judge.next = { for: ["cody"] };
    const routed = slack.handler!(inbound({ text: "cody, please look at the build" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ada.tool("update_agent").handler({ name: "cody", title: "release manager" } as never);
    const replaced = runtimes.get("cody")!;
    judge.gate = null;
    judged();
    await routed;
    expect(replaced.delivered).toHaveLength(1);
    // Arriving while the old seat is still stopping.
    let stopped!: () => void;
    replaced.stopGate = new Promise((resolve) => (stopped = resolve));
    const updating = ada.tool("update_agent").handler({ name: "cody", title: "release captain" } as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "cody, and the tests?" }));
    stopped();
    await updating;
    await flush();
    const latest = runtimes.get("cody")!;
    expect(latest).not.toBe(replaced);
    expect(latest.delivered.map((input) => input.text).join("\n")).toContain("and the tests?");
  });

  it("does not queue scheduled wakes for a retired agent", async () => {
    await startHub(TEAM);
    await runtimes.get("cody")!.tool("schedule_wake").handler({ every_minutes: 5, note: "check the build" } as never);
    await runtimes.get("ada")!.tool("retire_agent").handler({ name: "cody", reason: "done" } as never);
    const internals = hub as unknown as { scheduler: { tick(now: Date): Promise<number> }; store: { listQueued(agent: string): unknown[] } };
    await internals.scheduler.tick(new Date(Date.now() + 10 * 60_000));
    expect(internals.store.listQueued("cody")).toHaveLength(0);
  });

  it("acts on the only running agent only when an operator command names nobody", async () => {
    await startHub([TEAM[0], { ...TEAM[1], retired: true }]);
    const command = (ts: string, text: string) => slack.handler!(inbound({ channelId: "D1", channelType: "im", ts, text }));
    await command("1726700010.000100", ".retire cody");
    expect(slack.posted.at(-1)!.text).toContain("cody is not running");
    await command("1726700011.000100", ".reset typo");
    expect(slack.posted.at(-1)!.text).toContain("no agent named typo");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")).agents.find((entry: { name: string }) => entry.name === "ada")).not.toHaveProperty("retired");
    await command("1726700012.000100", ".stop");
    expect(runtimes.get("ada")!.interrupted).toBe(1);
  });

  it("will not let an operator retire or delete the last agent listening", async () => {
    await startHub(TEAM);
    const command = (ts: string, text: string) => slack.handler!(inbound({ channelId: "D1", channelType: "im", ts, text }));
    await command("1726700010.000100", ".retire all");
    expect(slack.posted.at(-1)!.text).toContain("nobody would hear anyone");
    await command("1726700011.000100", ".retire ada");
    expect(slack.posted.at(-1)!.text).toContain("retired ada");
    await command("1726700012.000100", ".retire cody");
    expect(slack.posted.at(-1)!.text).toContain("nobody would hear anyone");
    await command("1726700013.000100", ".delete cody");
    expect(slack.posted.at(-1)!.text).toContain("only agent listening");
    expect((hub as unknown as { seats: Map<string, unknown> }).seats.has("cody")).toBe(true);
  });
});

describe("decideWakes", () => {
  const spec = (name: string, wake: Partial<AgentSpec["wake"]> = {}): AgentSpec => ({
    name, title: null, icon: null, runtime: "claude", model: null, effort: null, host: { kind: "local" }, cwd: "/tmp",
    wake: { natural: true, threshold: 0.5, ...wake }, instructionsPath: null, inheritUserConfig: false, denyTools: DEFAULT_DENY_TOOLS, retired: false,
  });
  const verdict = (needs: Record<string, number>, source: Verdict["source"] = "jev"): Verdict => ({ needs: new Map(Object.entries(needs)), stop: new Map(), urgency: "next", source });
  const context = { authorKind: "human" as const, authorAgent: null, isDirectMessage: false, appMentioned: false, defaultAgent: "ada" };

  it("uses each agent's own threshold", () => {
    const decisions = decideWakes(verdict({ ada: 0.45, cody: 0.45 }), verdict({}, "rules"), [spec("ada", { threshold: 0.4 }), spec("cody", { threshold: 0.6 })], context);
    expect(decisions.get("ada")).toMatchObject({ wake: true, reason: "addressed", probability: 0.45 });
    expect(decisions.get("cody")).toMatchObject({ wake: false });
  });

  it("uses plain rules for an agent with natural wakes off", () => {
    const decisions = decideWakes(verdict({ ada: 0.95 }), verdict({ ada: 0.05 }, "rules"), [spec("ada", { natural: false })], context);
    expect(decisions.get("ada")).toMatchObject({ wake: false, source: "rules" });
  });

  it("wakes nobody by default for channel chatter that is for no one", () => {
    const decisions = decideWakes(verdict({ ada: 0.1, cody: 0.1 }), verdict({}, "rules"), [spec("ada"), spec("cody")], context);
    expect([...decisions.values()].some((decision) => decision.wake)).toBe(false);
  });
});

describe("RuleJudge", () => {
  const base: JudgeInput = {
    conversation: { kind: "channel", name: "general", inThread: false },
    agents: [{ name: "ada", role: null, inThisConversation: false, working: true }, { name: "cody", role: null, inThisConversation: true, working: false }],
    recent: [],
    message: { from: "Konark (human)", text: "" },
    authorKind: "human",
  };

  it("hears a name as a word, not as part of another word", async () => {
    const judge = new RuleJudge();
    expect((await judge.judge({ ...base, message: { from: "k", text: "Ada, thoughts?" } })).needs.get("ada")).toBeGreaterThan(0.5);
    expect((await judge.judge({ ...base, message: { from: "k", text: "the adapter is broken" } })).needs.get("ada")).toBeLessThan(0.5);
  });

  it("treats a reply in a thread an agent is in as for that agent, and a named stop as a stop", async () => {
    const judge = new RuleJudge();
    const threaded = await judge.judge({ ...base, conversation: { ...base.conversation, inThread: true }, message: { from: "k", text: "and the tests?" } });
    expect(threaded.needs.get("cody")).toBeGreaterThan(0.5);
    const stop = await judge.judge({ ...base, message: { from: "k", text: "ada stop" } });
    expect(stop.stop.get("ada")).toBeGreaterThan(0.8);
  });
});
