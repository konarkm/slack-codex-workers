import { describe, expect, it } from "vitest";
import { AgentStore } from "../agents/agentStore.js";
import { AgentMind } from "../agents/mind.js";
import { DEFAULT_WAKE_POLICY, type AgentRuntime, type AgentSpec, type RuntimeInput, type RuntimeOptions, type RuntimeState } from "../agents/types.js";

const spec: AgentSpec = {
  name: "ada",
  title: null,
  runtime: "claude",
  model: null,
  effort: null,
  host: { kind: "local" },
  cwd: "/tmp",
  wake: DEFAULT_WAKE_POLICY,
  slackBotTokenEnv: "",
  slackAppTokenEnv: "",
  instructionsPath: null,
  inheritUserConfig: false,
};

class FakeRuntime implements AgentRuntime {
  delivered: RuntimeInput[] = [];
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
  async interrupt(): Promise<void> {}
  async compact(): Promise<void> {}
  state(): RuntimeState {
    return this.current;
  }
  sessionId(): string | null {
    return this.options.sessionId;
  }
  async finishTurn(): Promise<void> {
    await this.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null });
    await this.set("idle");
  }
  private async set(state: RuntimeState): Promise<void> {
    this.current = state;
    await this.options.events.onStateChanged(state);
  }
}

function setup() {
  const store = new AgentStore(":memory:");
  const runtimes: FakeRuntime[] = [];
  const mind = new AgentMind(spec, store, (options) => {
    const runtime = new FakeRuntime(options);
    runtimes.push(runtime);
    return runtime;
  }, "instructions", []);
  return { store, mind, runtimes };
}

describe("AgentMind", () => {
  it("holds context-only input until something wakes the agent, then delivers both together", async () => {
    const { mind, runtimes } = setup();
    await mind.receive({ sourceKey: "a", wake: false, priority: "later", text: "ambient one", imagePaths: [] });
    expect(runtimes.length === 0 || runtimes[0]!.delivered.length === 0).toBe(true);

    await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "mention two", imagePaths: ["/tmp/x.png"] });
    expect(runtimes[0]!.delivered).toHaveLength(1);
    const input = runtimes[0]!.delivered[0]!;
    expect(input.text).toContain("ambient one");
    expect(input.text).toContain("mention two");
    expect(input.text.indexOf("ambient one")).toBeLessThan(input.text.indexOf("mention two"));
    expect(input.priority).toBe("next");
    expect(input.imagePaths).toEqual(["/tmp/x.png"]);
  });

  it("stores a redelivered source event once", async () => {
    const { mind, runtimes } = setup();
    expect(await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "hello", imagePaths: [] })).toBe(true);
    expect(await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "hello", imagePaths: [] })).toBe(false);
    expect(runtimes[0]!.delivered).toHaveLength(1);
  });

  it("delivers a wake that arrives while a turn is running", async () => {
    const { mind, runtimes } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await mind.receive({ sourceKey: "b", wake: true, priority: "now", text: "second", imagePaths: [] });
    expect(runtimes[0]!.delivered.map((input) => input.text)).toEqual(["first", "second"]);
  });

  it("tells the agent once when a woken turn ends with no visible action", async () => {
    const { mind, runtimes } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(2);
    expect(runtimes[0]!.delivered[1]!.text).toContain("without any visible action");
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(2);
  });

  it("sends no notice when the agent acted visibly", async () => {
    const { mind, runtimes } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    mind.noteVisibleAction();
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(1);
  });

  it("resumes the persisted session and redelivers queued input after a restart", async () => {
    const store = new AgentStore(":memory:");
    store.setAgentSession("ada", "session-1");
    store.enqueue({ agent: "ada", sourceKey: "a", wake: true, priority: "next", text: "queued before crash", imagePaths: [] });
    const runtimes: FakeRuntime[] = [];
    const mind = new AgentMind(spec, store, (options) => {
      const runtime = new FakeRuntime(options);
      runtimes.push(runtime);
      return runtime;
    }, "instructions", []);
    await mind.start();
    expect(runtimes[0]!.options.sessionId).toBe("session-1");
    expect(runtimes[0]!.delivered.map((input) => input.text)).toEqual(["queued before crash"]);
    expect(store.listQueued("ada")).toHaveLength(0);
  });
});
