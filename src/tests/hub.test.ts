import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHub, decideWakes, type HubConfig } from "../agents/hub.js";
import { RuleJudge, type JudgeInput, type Verdict, type WakeJudge } from "../agents/judge.js";
import { DEFAULT_DENY_TOOLS, type AgentRuntime, type AgentSpec, type RuntimeInput, type RuntimeOptions, type RuntimeState } from "../agents/types.js";
import type { AgentSlackClient, SlackInbound, SlackPersona } from "../slack/agentSlack.js";

class FakeRuntime implements AgentRuntime {
  delivered: RuntimeInput[] = [];
  unconfirmed: string[] = [];
  interrupted = 0;
  private current: RuntimeState = "down";
  constructor(readonly options: RuntimeOptions) {}
  async start(): Promise<void> {
    if (this.current === "down") await this.set("idle");
  }
  async stop(): Promise<void> {
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
  posted: Array<{ channelId: string; text: string; threadTs?: string | null; persona?: SlackPersona | null }> = [];
  statuses: Array<{ channelId: string; threadTs: string; status: string; persona?: string }> = [];
  history: Array<{ ts: string; threadTs: string | null; userId: string | null; botId: string | null; username: string | null; text: string; replyCount: number; fileNames: string[] }> = [];
  conversationLookups = 0;
  identity() {
    return { teamId: "T1", teamName: "Test", botUserId: "UAPP", botId: "BAPP", appId: null };
  }
  onMessage(handler: (message: SlackInbound) => Promise<void>) {
    this.handler = handler;
  }
  onStopRequested(handler: (where: { channelId: string | null; threadTs: string | null }) => Promise<void>) {
    this.stopHandler = handler;
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
    return { id, name: "general", type: "channel" as const, isMember: true };
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
  next: { for?: string[]; stop?: string[]; bareAck?: number; urgency?: Verdict["urgency"] } = {};
  async judge(input: JudgeInput): Promise<Verdict> {
    this.inputs.push(input);
    const script = this.next;
    return {
      needs: new Map(input.agents.map((agent) => [agent.name, script.for?.includes(agent.name) ? 0.95 : 0.03])),
      stop: new Map(input.agents.filter((agent) => agent.working).map((agent) => [agent.name, script.stop?.includes(agent.name) ? 0.95 : 0.01])),
      bareAck: script.bareAck ?? 0.02,
      urgency: script.urgency ?? "next",
      source: "jev",
    };
  }
}

function inbound(overrides: Partial<SlackInbound> = {}): SlackInbound {
  return { teamId: "T1", channelId: "C1", channelType: "channel", ts: "1726700000.000100", threadTs: null, userId: "UHUMAN", botId: null, botUserId: null, text: "hello", files: [], unavailableFiles: [], editedAt: null, ...overrides };
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
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
  it("wakes the agent a plainly worded message is for, and gives the others the same message as background", async () => {
    await startHub(TEAM);
    judge.next = { for: ["cody"] };
    await slack.handler!(inbound({ text: "can you fix the deploy script" }));
    expect(delivered("cody")).toHaveLength(1);
    expect(delivered("cody")[0]!.text).toContain('wake="addressed"');
    expect(delivered("ada")).toHaveLength(0);
    // ada hears about it the next time something wakes her.
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ ts: "1726700001.000100", text: "ada what do you make of that" }));
    const text = delivered("ada")[0]!.text;
    expect(text).toContain("can you fix the deploy script");
    expect(text).toContain('wake="none"');
    expect(text).toContain("what do you make of that");
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

  it("wakes nobody for a bare acknowledgement between agents", async () => {
    await startHub(TEAM);
    judge.next = { for: ["ada"] };
    await slack.handler!(inbound({ text: "ada hi" }));
    judge.next = { for: ["cody"], bareAck: 0.95 };
    await runtimes.get("ada")!.tool("send_message").handler({ channel: "C1", text: "thanks cody", thread_ts: "1726700000.000100" } as never);
    await flush();
    expect(delivered("cody")).toHaveLength(0);
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
    await slack.handler!(inbound({ ts: "1726700005.000100", threadTs: "1726700000.000100", text: "cody carry on" }));
    const last = delivered("cody").at(-1)!.text;
    expect(last).toContain("round 3");
    expect(last).toContain("did not wake you");
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
});

describe("decideWakes", () => {
  const spec = (name: string, wake: Partial<AgentSpec["wake"]> = {}): AgentSpec => ({
    name, title: null, icon: null, runtime: "claude", model: null, effort: null, host: { kind: "local" }, cwd: "/tmp",
    wake: { natural: true, threshold: 0.5, ...wake }, instructionsPath: null, inheritUserConfig: false, denyTools: DEFAULT_DENY_TOOLS,
  });
  const verdict = (needs: Record<string, number>, source: Verdict["source"] = "jev"): Verdict => ({ needs: new Map(Object.entries(needs)), stop: new Map(), bareAck: 0, urgency: "next", source });
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
