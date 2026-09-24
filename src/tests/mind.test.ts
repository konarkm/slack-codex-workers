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
  failDeliveries = 0;
  // A hand-off that takes a while, like a Codex app-server starting.
  gate: Promise<void> | null = null;
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
    await this.gate;
    if (this.failNextDeliver || this.failDeliveries > 0) {
      this.failNextDeliver = false;
      this.failDeliveries = Math.max(this.failDeliveries - 1, 0);
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// receive() returns once the input is stored; this also waits for the hand-off to the runtime.
async function receive(mind: AgentMind, item: Parameters<AgentMind["receive"]>[0]): Promise<boolean> {
  const stored = await mind.receive(item);
  await (mind as unknown as { pumping: Promise<void> | null }).pumping;
  return stored;
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
    await receive(mind, { sourceKey: "a", wake: false, priority: "later", text: "ambient one", imagePaths: [] });
    expect(runtimes.length === 0 || runtimes[0]!.delivered.length === 0).toBe(true);

    await receive(mind, { sourceKey: "b", wake: true, priority: "next", text: "mention two", imagePaths: ["/tmp/x.png"] });
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
    expect(await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "hello", imagePaths: [] })).toBe(true);
    expect(await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "hello", imagePaths: [] })).toBe(false);
    expect(runtimes[0]!.delivered).toHaveLength(1);
  });

  it("delivers a wake that arrives while a turn is running", async () => {
    const { mind, runtimes } = setup();
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await receive(mind, { sourceKey: "b", wake: true, priority: "now", text: "second", imagePaths: [] });
    const texts = runtimes[0]!.delivered.map((input) => input.text);
    expect(texts[0]).toBe("first");
    expect(texts[1]).toContain("second");
    expect(texts[1]).toContain("arrived while you were working");
  });

  it("tells the agent once when a woken turn ends with no visible action", async () => {
    const { mind, runtimes } = setup();
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(2);
    expect(runtimes[0]!.delivered[1]!.text).toContain("without any visible action");
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(2);
  });

  it("sends no notice when the agent acted visibly", async () => {
    const { mind, runtimes } = setup();
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    mind.noteVisibleAction();
    await runtimes[0]!.finishTurn();
    expect(runtimes[0]!.delivered).toHaveLength(1);
  });

  it("counts input as delivered only once the turn that took it has finished", async () => {
    const { mind, runtimes, store } = setup();
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
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
      await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.listQueued("ada")).toHaveLength(1);
      expect(store.getInboxItem(1)!.attempts).toBe(0);
      await receive(mind, { sourceKey: "b", wake: true, priority: "next", text: "second", imagePaths: [] });
      await vi.advanceTimersByTimeAsync(0);
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
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
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
      await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "asked during an outage", imagePaths: [] });
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
      await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "poison", imagePaths: [] });
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
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await receive(mind, { sourceKey: "b", wake: true, priority: "next", text: "second", imagePaths: [] });
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
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "long task", imagePaths: [] });
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
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "wedging input", imagePaths: [] });
    await mind.resetSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimes[0]!.delivered).toHaveLength(1);
    expect(runtimes[0]!.state()).toBe("down");
    expect(store.getAgentState("ada")!.sessionId).toBeNull();
    await receive(mind, { sourceKey: "b", wake: true, priority: "next", text: "after reset", imagePaths: [] });
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
    await receive(before, { sourceKey: "a", wake: true, priority: "next", text: "one", imagePaths: [] });
    await first[0]!.finishTurn();
    await receive(before, { sourceKey: "b", wake: true, priority: "next", text: "two", imagePaths: [] });
    // The first input carries them (the bridge had no record of what the session knew); the second does not.
    expect(first[0]!.delivered[0]!.text).toContain("old rules");
    expect(first[0]!.delivered.at(-1)!.text).toBe("two");
    await first[0]!.finishTurn();
    await before.stop();

    const second: FakeRuntime[] = [];
    const after = make("new rules", second);
    await after.start();
    await receive(after, { sourceKey: "c", wake: true, priority: "next", text: "three", imagePaths: [] });
    expect(second[0]!.delivered[0]!.text).toContain("Your standing instructions have changed");
    expect(second[0]!.delivered[0]!.text).toContain("new rules");
    expect(second[0]!.delivered[0]!.text).toContain("three");
  });
  it("takes input as soon as it is stored, without waiting for the runtime to take it", async () => {
    const { mind, runtimes, store } = setup();
    await mind.start();
    let release!: () => void;
    runtimes[0]!.gate = new Promise<void>((resolve) => (release = resolve));
    expect(await mind.receive({ sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] })).toBe(true);
    expect(store.getInboxItem(1)!.status).toBe("in_flight");
    expect(runtimes[0]!.delivered).toHaveLength(0);
    release();
    await flush();
    expect(runtimes[0]!.delivered).toHaveLength(1);
    await mind.stop();
  });

  it("tells the operators when the runtime keeps failing to take input, as it does when turns keep failing", async () => {
    vi.useFakeTimers();
    try {
      const troubles: string[] = [];
      const { mind, runtimes } = setup({ onTrouble: (_agent, message) => void troubles.push(message) });
      await mind.start();
      runtimes[0]!.failDeliveries = 5;
      await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
      await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000);
      expect(troubles).toHaveLength(1);
      expect(troubles[0]).toContain("runtime unavailable");
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the operators about a problem the runtime reports, and keeps it as the last error after a good turn", async () => {
    const troubles: string[] = [];
    const { mind, runtimes, store } = setup({ onTrouble: (_agent, message) => void troubles.push(message) });
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "first", imagePaths: [] });
    await flush();
    await runtimes[0]!.options.events.onProblem("bridge tools are unavailable");
    mind.noteVisibleAction();
    await runtimes[0]!.finishTurn();
    expect(troubles).toEqual(["bridge tools are unavailable"]);
    expect(store.getAgentState("ada")!.lastError).toBe("bridge tools are unavailable");
    await mind.stop();
  });

  it("hands over changed instructions again when the input carrying them did not get through", async () => {
    vi.useFakeTimers();
    try {
      const store = new AgentStore(":memory:");
      store.setAgentSession("ada", "session-1");
      store.setInstructionsHash("ada", "stale");
      const runtimes: FakeRuntime[] = [];
      const mind = new AgentMind(spec, store, (options) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime;
      }, "new rules", [], ACCESS);
      await mind.start();
      runtimes[0]!.failNextDeliver = true;
      await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "one", imagePaths: [] });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runtimes[0]!.delivered[0]!.text).toContain("new rules");
      // The turn that carried them failed, so the retry carries them again.
      await runtimes[0]!.failTurn();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtimes[0]!.delivered[1]!.text).toContain("new rules");
      mind.noteVisibleAction();
      await runtimes[0]!.finishTurn();
      await receive(mind, { sourceKey: "b", wake: true, priority: "next", text: "two", imagePaths: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimes[0]!.delivered.at(-1)!.text).toBe("two");
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges an input fault in a batch only to the row that causes it, by sending the batch's rows one at a time", async () => {
    vi.useFakeTimers();
    try {
      const abandoned: string[] = [];
      const { mind, runtimes, store } = setup({ onAbandoned: (_agent, items) => void abandoned.push(...items.map((item) => item.sourceKey)) });
      store.enqueue({ agent: "ada", sourceKey: "fine", wake: true, priority: "next", text: "a plain question", imagePaths: [] });
      store.enqueue({ agent: "ada", sourceKey: "bad", wake: true, priority: "next", text: "a rejected image", imagePaths: ["/tmp/bad.png"] });
      await mind.start();
      const runtime = runtimes[0]!;
      expect(runtime.delivered[0]!.text).toContain("a plain question");
      expect(runtime.delivered[0]!.text).toContain("a rejected image");
      await runtime.failTurn(true);
      expect(store.getInboxItem(1)!.faults).toBe(0);
      expect(store.getInboxItem(2)!.faults).toBe(0);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(runtime.delivered[1]!.text).toContain("a plain question");
      expect(runtime.delivered[1]!.text).not.toContain("a rejected image");
      mind.noteVisibleAction();
      await runtime.finishTurn();
      await vi.advanceTimersByTimeAsync(0);
      for (let round = 0; round < 3; round += 1) {
        expect(runtime.delivered.at(-1)!.text).toContain("a rejected image");
        expect(runtime.delivered.at(-1)!.text).not.toContain("a plain question");
        await runtime.failTurn(true);
        await vi.advanceTimersByTimeAsync(300_000);
      }
      expect(store.getInboxItem(1)!.status).toBe("delivered");
      expect(store.getInboxItem(2)!.status).toBe("failed");
      expect(abandoned).toEqual(["bad"]);
      await mind.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers what a reset put back in the queue to the new session right away", async () => {
    const { mind, runtimes } = setup();
    await receive(mind, { sourceKey: "a", wake: true, priority: "next", text: "stuck input", imagePaths: [] });
    await flush();
    await mind.resetSession();
    await flush();
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]!.delivered[0]!.text).toContain("stuck input");
    await mind.stop();
  });
});
