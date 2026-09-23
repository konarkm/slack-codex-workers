import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agentStore.js";
import { AgentMind, type MindObserver } from "../agents/mind.js";
import { DEFAULT_WAKE_POLICY, type AgentRuntime, type AgentSpec, type RuntimeInput, type RuntimeOptions, type RuntimeState } from "../agents/types.js";

const ACCESS = { url: "http://127.0.0.1:0/mcp", token: "t" };

const spec: AgentSpec = {
  name: "ada",
  title: null,
  runtime: "claude",
  model: null,
  effort: null,
  host: { kind: "local" },
  cwd: "/tmp",
  wake: DEFAULT_WAKE_POLICY,
  icon: null,
  instructionsPath: null,
  inheritUserConfig: false,
  denyTools: [],
  retired: false,
};

class FakeRuntime implements AgentRuntime {
  delivered: RuntimeInput[] = [];
  unconfirmed: string[] = [];
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
    if (input.id) this.unconfirmed.push(input.id);
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
    await this.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null, consumedInputIds: this.unconfirmed.splice(0), inputFault: false });
    await this.set("idle");
  }
  async failTurn(inputFault = false): Promise<void> {
    await this.options.events.onTurnCompleted({ status: "failed", finalText: "", error: "api error", consumedInputIds: this.unconfirmed.splice(0), inputFault });
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

function setup(observer: MindObserver = {}) {
  const store = new AgentStore(":memory:");
  const runtimes: FakeRuntime[] = [];
  const mind = new AgentMind(spec, store, (options) => {
    const runtime = new FakeRuntime(options);
    runtimes.push(runtime);
    return runtime;
  }, "instructions", [], ACCESS, observer);
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

  it("keeps input queued when the runtime cannot take it, and waits before trying again", async () => {
    vi.useFakeTimers();
    try {
      const { mind, runtimes, store } = setup();
      await mind.start();
      runtimes[0]!.failNextDeliver = true;
      await expect(mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] })).rejects.toThrow("runtime unavailable");
      expect(store.listQueued("ada")).toHaveLength(1);
      expect(store.getInboxItem(1)!.attempts).toBe(0);
      await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "second", imagePaths: [] });
      expect(runtimes[0]!.delivered).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runtimes[0]!.delivered).toHaveLength(1);
      expect(runtimes[0]!.delivered[0]!.text).toContain("first");
      expect(runtimes[0]!.delivered[0]!.text).toContain("second");
      expect(runtimes[0]!.delivered[0]!.text).not.toContain("delivered to you before");
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts input back in the queue when the runtime dies mid-turn, and says it is a redelivery", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await runtimes[0]!.crash();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimes[0]!.delivered).toHaveLength(2);
    expect(runtimes[0]!.delivered[1]!.text).toContain("delivered to you before");
    expect(runtimes[0]!.delivered[1]!.text).toContain("first");
    expect(store.getInboxItem(1)!.attempts).toBe(2);
    await mind.stop();
  });

  it("rides out provider failures without giving up on anything, backing off and telling the operators", async () => {
    vi.useFakeTimers();
    try {
      const troubles: string[] = [];
      const abandoned: string[] = [];
      const { mind, runtimes, store } = setup({ onTrouble: (_agent, message) => void troubles.push(message), onAbandoned: (_agent, items) => void abandoned.push(...items.map((item) => item.sourceKey)) });
      await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "asked during an outage", imagePaths: [] });
      const delays = [5_000, 10_000, 20_000, 40_000];
      for (const delay of delays) {
        await runtimes[0]!.failTurn();
        await vi.advanceTimersByTimeAsync(delay - 1);
        const before = runtimes[0]!.delivered.length;
        await vi.advanceTimersByTimeAsync(1);
        expect(runtimes[0]!.delivered.length).toBe(before + 1);
      }
      expect(store.getInboxItem(1)!.status).toBe("in_flight");
      expect(store.getInboxItem(1)!.faults).toBe(0);
      expect(abandoned).toEqual([]);
      expect(troubles).toHaveLength(1);
      mind.noteVisibleAction();
      await runtimes[0]!.finishTurn();
      expect(store.getInboxItem(1)!.status).toBe("delivered");
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on an input that makes three turns fail by itself, and tells the operators", async () => {
    vi.useFakeTimers();
    try {
      const abandoned: string[] = [];
      const { mind, runtimes, store } = setup({ onAbandoned: (_agent, items) => void abandoned.push(...items.map((item) => item.sourceKey)) });
      await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "poison", imagePaths: [] });
      for (let round = 0; round < 3; round += 1) {
        await runtimes[0]!.failTurn(true);
        await vi.advanceTimersByTimeAsync(300_000);
      }
      expect(store.getInboxItem(1)!.status).toBe("failed");
      expect(abandoned).toEqual(["a"]);
      expect(runtimes[0]!.delivered).toHaveLength(3);
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms only the input a finished turn took, not one pushed while the result was arriving", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "second", imagePaths: [] });
    mind.noteVisibleAction();
    const [firstInput] = runtimes[0]!.unconfirmed.splice(0, 1);
    await runtimes[0]!.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null, consumedInputIds: [firstInput!], inputFault: false });
    expect(store.getInboxItem(1)!.status).toBe("delivered");
    expect(store.getInboxItem(2)!.status).toBe("in_flight");
    await runtimes[0]!.crash();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimes[0]!.delivered.at(-1)!.text).toContain("second");
    expect(runtimes[0]!.delivered.at(-1)!.text).not.toContain("first");
    await mind.stop();
  });

  it("does not deliver again what an operator's stop interrupted", async () => {
    const { mind, runtimes, store } = setup();
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "long task", imagePaths: [] });
    await runtimes[0]!.options.events.onTurnCompleted({ status: "interrupted", finalText: "", error: null, consumedInputIds: runtimes[0]!.unconfirmed.splice(0), inputFault: false });
    expect(store.getInboxItem(1)!.status).toBe("delivered");
    expect(runtimes[0]!.delivered).toHaveLength(1);
    await mind.stop();
  });

  it("resets mid-turn into a new runtime and a new session, and never restarts the old one", async () => {
    const store = new AgentStore(":memory:");
    store.setAgentSession("ada", "old-session");
    const runtimes: FakeRuntime[] = [];
    const mind = new AgentMind(spec, store, (options) => {
      const runtime = new FakeRuntime(options);
      runtimes.push(runtime);
      return runtime;
    }, "instructions", [], ACCESS);
    await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "wedging input", imagePaths: [] });
    await mind.resetSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimes[0]!.delivered).toHaveLength(1);
    expect(runtimes[0]!.state()).toBe("down");
    expect(store.getAgentState("ada")!.sessionId).toBeNull();
    await mind.receive({ sourceKey: "b", wake: true, priority: "next", text: "after reset", imagePaths: [] });
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]!.options.sessionId).toBeNull();
    expect(runtimes[1]!.delivered[0]!.text).toContain("wedging input");
    // A late event from the old runtime changes nothing.
    await runtimes[0]!.options.events.onTurnCompleted({ status: "completed", finalText: "", error: null, consumedInputIds: [], inputFault: false });
    expect(store.getInboxItem(1)!.status).toBe("in_flight");
    await mind.stop();
    expect(runtimes[1]!.state()).toBe("down");
    expect(runtimes).toHaveLength(2);
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
    }, "instructions", [], ACCESS);
    await mind.start();
    expect(runtimes[0]!.options.sessionId).toBe("session-1");
    expect(runtimes[0]!.delivered).toHaveLength(1);
    expect(runtimes[0]!.delivered[0]!.text).toContain("queued before crash");
    expect(store.listQueued("ada")).toHaveLength(0);
  });

  it("hands a running session its standing instructions once when they have changed, since its system prompt is a snapshot", async () => {
    const store = new AgentStore(":memory:");
    store.setAgentSession("ada", "session-1");
    const make = (instructions: string, runtimes: FakeRuntime[]) =>
      new AgentMind(spec, store, (options) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime;
      }, instructions, [], ACCESS);
    const first: FakeRuntime[] = [];
    const before = make("old rules", first);
    await before.start();
    await before.receive({ sourceKey: "a", wake: true, priority: "next", text: "one", imagePaths: [] });
    await first[0]!.finishTurn();
    await before.receive({ sourceKey: "b", wake: true, priority: "next", text: "two", imagePaths: [] });
    // The first input carries them (the bridge had no record of what the session knew); the second does not.
    expect(first[0]!.delivered[0]!.text).toContain("old rules");
    expect(first[0]!.delivered.at(-1)!.text).toBe("two");
    await first[0]!.finishTurn();
    await before.stop();

    const second: FakeRuntime[] = [];
    const after = make("new rules", second);
    await after.start();
    await after.receive({ sourceKey: "c", wake: true, priority: "next", text: "three", imagePaths: [] });
    expect(second[0]!.delivered[0]!.text).toContain("Your standing instructions have changed");
    expect(second[0]!.delivered[0]!.text).toContain("new rules");
    expect(second[0]!.delivered[0]!.text).toContain("three");
  });
});
