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
  failNextDeliver = false;
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
    if (this.failNextDeliver) {
      this.failNextDeliver = false;
      throw new Error("runtime unavailable");
    }
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
  async failTurn(): Promise<void> {
    await this.options.events.onTurnCompleted({ status: "failed", finalText: "", error: "api error" });
    await this.set("idle");
  }
  async crash(): Promise<void> {
    await this.set("down");
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
    const texts = runtimes[0]!.delivered.map((input) => input.text);
    expect(texts[0]).toBe("first");
    expect(texts[1]).toContain("second");
    expect(texts[1]).toContain("arrived while you were working");
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

  it("counts input as delivered only once the turn that took it has finished", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    mind.noteVisibleAction();
    expect(store.getInboxItem(1)!.status).toBe("in_flight");
    await runtimes[0]!.finishTurn();
    expect(store.getInboxItem(1)!.status).toBe("delivered");
  });

  it("keeps input queued when the runtime cannot take it", async () => {
    const { mind, runtimes, store } = setup();
    await mind.start();
    runtimes[0]!.failNextDeliver = true;
    await expect(mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] })).rejects.toThrow("runtime unavailable");
    expect(store.listQueued("ada")).toHaveLength(1);
    await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "second", imagePaths: [] });
    expect(runtimes[0]!.delivered).toHaveLength(1);
    expect(runtimes[0]!.delivered[0]!.text).toContain("first");
    expect(runtimes[0]!.delivered[0]!.text).toContain("second");
    await mind.stop();
  });

  it("puts input back in the queue when the runtime dies mid-turn", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await runtimes[0]!.crash();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimes[0]!.delivered.map((input) => input.text)).toEqual(["first", "first"]);
    expect(store.getInboxItem(1)!.attempts).toBe(2);
    await mind.stop();
  });

  it("gives up on input after three failed turns and records why", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "poison", imagePaths: [] });
    await runtimes[0]!.failTurn();
    await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "kick 1", imagePaths: [] });
    await runtimes[0]!.failTurn();
    await mind.receive({ sourceKey: "c", wake: true, priority: "next", text: "kick 2", imagePaths: [] });
    await runtimes[0]!.failTurn();
    expect(store.getInboxItem(1)!.status).toBe("failed");
    expect(store.getAgentState("ada")!.lastError).toContain("Gave up on 1 input");
    await mind.stop();
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
