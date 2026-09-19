import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHub, type HubConfig } from "../agents/hub.js";
import type { AgentRuntime, AgentSpec, RuntimeInput, RuntimeOptions, RuntimeState } from "../agents/types.js";
import type { AgentSlackClient, SlackInbound } from "../slack/agentSlack.js";

class FakeRuntime implements AgentRuntime {
  delivered: RuntimeInput[] = [];
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
    await this.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null });
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
  stopHandler: (() => Promise<void>) | null = null;
  posted: Array<{ channelId: string; text: string; threadTs?: string | null }> = [];
  statuses: Array<{ channelId: string; threadTs: string; status: string }> = [];
  history: Array<{ ts: string; threadTs: string | null; userId: string | null; botId: string | null; text: string; replyCount: number; fileNames: string[] }> = [];
  constructor(readonly agentName: string, private readonly index: number) {}
  identity() {
    return { teamId: "T1", teamName: "Test", botUserId: `UBOT${this.index}`, botId: `BBOT${this.index}`, appId: null };
  }
  onMessage(handler: (message: SlackInbound) => Promise<void>) {
    this.handler = handler;
  }
  onStopRequested(handler: () => Promise<void>) {
    this.stopHandler = handler;
  }
  async start() {
    return this.identity();
  }
  async stop() {}
  async getPerson(id: string) {
    return { id, name: id === "UHUMAN" ? "Konark" : id, isBot: id.startsWith("UBOT"), title: null };
  }
  async getConversation(id: string) {
    return { id, name: "general", type: "channel" as const, isMember: true };
  }
  async readHistory() {
    return this.history;
  }
  async postMessage(args: { channelId: string; text: string; threadTs?: string | null }) {
    this.posted.push(args);
    return { ts: "1726700009.000900", permalink: null };
  }
  async setThreadStatus(channelId: string, threadTs: string, status: string) {
    this.statuses.push({ channelId, threadTs, status });
  }
  botTokenForDownloads() {
    return "xoxb-test";
  }
}

function inbound(overrides: Partial<SlackInbound> = {}): SlackInbound {
  return { teamId: "T1", channelId: "C1", channelType: "channel", ts: "1726700000.000100", threadTs: null, userId: "UHUMAN", botId: null, botUserId: null, text: "hello", files: [], ...overrides };
}

let dir: string;
let hub: AgentHub;
let slacks: FakeSlack[];
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
    (spec: AgentSpec) => {
      const slack = new FakeSlack(spec.name, slacks.length + 1);
      slacks.push(slack);
      return slack as unknown as AgentSlackClient;
    },
    (options) => {
      const runtime = new FakeRuntime(options);
      runtimes.set(options.spec.name, runtime);
      return runtime;
    },
  );
  await hub.start();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  slacks = [];
  runtimes = new Map();
  process.env.SLACK_BOT_TOKEN_ADA = "xoxb-ada";
  process.env.SLACK_APP_TOKEN_ADA = "xapp-ada";
  process.env.SLACK_BOT_TOKEN_CODY = "xoxb-cody";
  process.env.SLACK_APP_TOKEN_CODY = "xapp-cody";
});

afterEach(async () => {
  await hub?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentHub", () => {
  it("routes a channel mention and a DM into the same mind", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ text: "<@UBOT1> what is the plan?" }));
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700001.000100", text: "and in private?" }));
    const runtime = runtimes.get("ada")!;
    expect(runtimes.size).toBe(1);
    expect(runtime.delivered).toHaveLength(2);
    expect(runtime.delivered[0]!.text).toContain("Where: #general (C1), top level");
    expect(runtime.delivered[1]!.text).toContain("Where: direct message (D1)");
    expect(runtime.delivered[1]!.text).toContain("arrived while you were working");
  });

  it("holds ambient messages as context until the agent is woken", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ text: "deploy codeword is marmalade" }));
    expect(runtimes.get("ada")?.delivered ?? []).toHaveLength(0);
    await slack.handler!(inbound({ ts: "1726700002.000100", text: "<@UBOT1> codeword?" }));
    const text = runtimes.get("ada")!.delivered[0]!.text;
    expect(text).toContain("marmalade");
    expect(text).toContain('wake="none"');
    expect(text).toContain('wake="mention"');
  });

  it("delivers the same Slack event once even when it arrives twice", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ text: "<@UBOT1> hi" }));
    await slack.handler!(inbound({ text: "<@UBOT1> hi" }));
    expect(runtimes.get("ada")!.delivered).toHaveLength(1);
  });

  it("gives each agent its own mind and wakes only the one that was named", async () => {
    await startHub([{ name: "ada", runtime: "claude" }, { name: "cody", runtime: "codex" }]);
    const message = inbound({ text: "<@UBOT2> take this one" });
    await slacks[0]!.handler!(message);
    await slacks[1]!.handler!(message);
    expect(runtimes.get("ada")?.delivered ?? []).toHaveLength(0);
    expect(runtimes.get("cody")!.delivered).toHaveLength(1);
  });

  it("backfills a thread the agent has not seen, once", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    slack.history = [
      { ts: "1726600000.000001", threadTs: "1726600000.000001", userId: "UHUMAN", botId: null, text: "root question", replyCount: 2, fileNames: [] },
      { ts: "1726600000.000002", threadTs: "1726600000.000001", userId: "UHUMAN", botId: null, text: "more detail", replyCount: 0, fileNames: [] },
    ];
    await slack.handler!(inbound({ ts: "1726600000.000003", threadTs: "1726600000.000001", text: "<@UBOT1> can you weigh in?" }));
    const runtime = runtimes.get("ada")!;
    expect(runtime.delivered[0]!.text).toContain('<thread-context included="2" total="2" truncated="false">');
    expect(runtime.delivered[0]!.text).toContain("root question");
    await runtime.finishTurn();
    await slack.handler!(inbound({ ts: "1726600000.000004", threadTs: "1726600000.000001", text: "<@UBOT1> and now?" }));
    expect(runtime.delivered.at(-1)!.text).not.toContain("<thread-context");
  });

  it("stops agents waking each other after the budget, until a human speaks", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    const fromAgent = (n: number) => inbound({ userId: null, botId: "BOTHER", ts: `1726700010.00000${n}`, threadTs: "1726700010.000000", text: "<@UBOT1> ping" });
    await slack.handler!(fromAgent(1));
    await slack.handler!(fromAgent(2));
    await slack.handler!(fromAgent(3));
    const runtime = runtimes.get("ada")!;
    expect(runtime.delivered).toHaveLength(2);
    await slack.handler!(inbound({ ts: "1726700010.000004", threadTs: "1726700010.000000", text: "<@UBOT1> carry on" }));
    const last = runtime.delivered.at(-1)!.text;
    expect(last).toContain("did not wake you");
    expect(last).toContain("carry on");
    await slack.handler!(fromAgent(5));
    expect(runtime.delivered).toHaveLength(4);
  });

  it("records thread participation when the agent sends, so follow-ups can wake it", async () => {
    await startHub([{ name: "ada", runtime: "claude", wake: { participatingThreads: true } }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ text: "<@UBOT1> hi" }));
    const runtime = runtimes.get("ada")!;
    await runtime.tool("send_message").handler({ channel: "C1", text: "on it", thread_ts: "1726700000.000100" } as never);
    await runtime.finishTurn();
    expect(slack.posted[0]).toMatchObject({ channelId: "C1", threadTs: "1726700000.000100" });
    await slack.handler!(inbound({ ts: "1726700003.000100", threadTs: "1726700000.000100", text: "thanks, one more thing" }));
    expect(runtime.delivered).toHaveLength(2);
    expect(runtime.delivered[1]!.text).toContain('wake="thread-reply"');
  });

  it("shows the agent as working in the thread and clears it when the turn ends", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ text: "<@UBOT1> hi" }));
    expect(slack.statuses).toEqual([{ channelId: "C1", threadTs: "1726700000.000100", status: "processing" }]);
    runtimes.get("ada")!.tool("dismiss");
    await runtimes.get("ada")!.tool("dismiss").handler({ reason: "test" } as never);
    await runtimes.get("ada")!.finishTurn();
    expect(slack.statuses.at(-1)).toEqual({ channelId: "C1", threadTs: "1726700000.000100", status: "active" });
  });

  it("answers operator commands from admins in a DM without waking the agent", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    const slack = slacks[0]!;
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", text: ".status" }));
    expect(runtimes.get("ada")?.delivered ?? []).toHaveLength(0);
    expect(slack.posted[0]!.text).toContain("_bridge (ada)_");
    await slack.handler!(inbound({ channelId: "D1", channelType: "im", ts: "1726700004.000100", userId: "USOMEONE", text: ".status" }));
    expect(runtimes.get("ada")!.delivered).toHaveLength(1);
  });

  it("interrupts the mind when Slack's stop button is pressed", async () => {
    await startHub([{ name: "ada", runtime: "claude" }]);
    await slacks[0]!.handler!(inbound({ text: "<@UBOT1> long task" }));
    await slacks[0]!.stopHandler!();
    expect(runtimes.get("ada")!.interrupted).toBe(1);
  });

  it("keeps running the agents that start when another is missing credentials", async () => {
    delete process.env.SLACK_BOT_TOKEN_CODY;
    await startHub([{ name: "ada", runtime: "claude" }, { name: "cody", runtime: "codex" }]);
    expect(slacks.map((slack) => slack.agentName)).toEqual(["ada"]);
  });
});
