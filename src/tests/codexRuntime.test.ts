import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CodexRuntime, classifyCodexError, type CodexRpc } from "../runtimes/codexRuntime.js";
import { DEFAULT_WAKE_POLICY, type AgentSpec, type RuntimeEvents, type RuntimeState } from "../agents/types.js";

const spec: AgentSpec = {
  name: "cody",
  title: null,
  runtime: "codex",
  model: "gpt-5.5",
  effort: null,
  host: { kind: "local" },
  cwd: "/tmp",
  wake: DEFAULT_WAKE_POLICY,
  slackBotTokenEnv: "",
  slackAppTokenEnv: "",
  instructionsPath: null,
  inheritUserConfig: false,
};

class FakeRpc extends EventEmitter {
  requests: Array<{ method: string; params: any }> = [];
  responses: Array<{ id: string | number; result: any }> = [];
  failNext: Record<string, string> = {};
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    const failure = this.failNext[method];
    if (failure) {
      delete this.failNext[method];
      throw new Error(failure);
    }
    if (method === "thread/start") return { thread: { id: "thread-new" } } as T;
    if (method === "turn/start") return { turn: { id: `turn-${this.requests.filter((r) => r.method === "turn/start").length}` } } as T;
    return {} as T;
  }
  async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
  async respondError(): Promise<void> {}
}

function setup(sessionId: string | null, sent: string[] = []) {
  const rpc = new FakeRpc();
  const states: RuntimeState[] = [];
  const sessions: string[] = [];
  const turns: Array<{ status: string; finalText: string }> = [];
  const events: RuntimeEvents = {
    onSessionChanged: (id) => void sessions.push(id),
    onStateChanged: (state) => void states.push(state),
    onTurnCompleted: (event) => void turns.push(event),
    onActivity: () => {},
    onCompaction: () => {},
  };
  const runtime = new CodexRuntime(
    {
      spec,
      sessionId,
      instructions: "be a teammate",
      tools: [{ name: "send", description: "send", shape: { text: z.string() }, handler: async (args) => { sent.push((args as { text: string }).text); return "ok"; } }],
      events,
    },
    "codex",
    () => rpc as unknown as CodexRpc,
  );
  return { rpc, runtime, states, sessions, turns };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CodexRuntime", () => {
  it("starts a thread with canonical dynamic tools and reports the session", async () => {
    const { rpc, runtime, sessions } = setup(null);
    await runtime.start();
    const start = rpc.requests.find((r) => r.method === "thread/start")!;
    expect(start.params.dynamicTools[0]).toMatchObject({ type: "function", name: "send" });
    expect(start.params.dynamicTools[0].inputSchema.properties.text.type).toBe("string");
    expect(start.params.developerInstructions).toBe("be a teammate");
    expect(sessions).toEqual(["thread-new"]);
  });

  it("resumes a persisted thread, and starts a new one when it is gone", async () => {
    const resumed = setup("thread-old");
    await resumed.runtime.start();
    expect(resumed.rpc.requests.map((r) => r.method)).toEqual(["thread/resume"]);
    expect(resumed.runtime.sessionId()).toBe("thread-old");

    const gone = setup("thread-old");
    gone.rpc.failNext["thread/resume"] = "no rollout found for thread id thread-old";
    await gone.runtime.start();
    expect(gone.rpc.requests.map((r) => r.method)).toEqual(["thread/resume", "thread/start"]);
    expect(gone.sessions).toEqual(["thread-new"]);
  });

  it("starts a turn when idle and steers the running turn otherwise", async () => {
    const { rpc, runtime, states, turns } = setup(null);
    await runtime.deliver({ text: "one", imagePaths: [], priority: "next" });
    await runtime.deliver({ text: "two", imagePaths: ["/tmp/a.png"], priority: "next" });
    const methods = rpc.requests.map((r) => r.method);
    expect(methods).toEqual(["thread/start", "turn/start", "turn/steer"]);
    expect(rpc.requests[2]!.params).toMatchObject({ expectedTurnId: "turn-1" });
    expect(rpc.requests[2]!.params.input[1]).toEqual({ type: "localImage", path: "/tmp/a.png" });

    rpc.emit("notification", { method: "item/completed", params: { threadId: "thread-new", item: { id: "i1", type: "agentMessage", text: "done" } } });
    rpc.emit("notification", { method: "turn/completed", params: { threadId: "thread-new", turn: { id: "turn-1", status: "completed" } } });
    await flush();
    expect(turns).toEqual([{ status: "completed", finalText: "done", error: null }]);
    expect(states.at(-1)).toBe("idle");

    await runtime.deliver({ text: "three", imagePaths: [], priority: "next" });
    expect(rpc.requests.at(-1)!.method).toBe("turn/start");
  });

  it("falls through to a new turn when the steer target already ended", async () => {
    const { rpc, runtime } = setup(null);
    await runtime.deliver({ text: "one", imagePaths: [], priority: "next" });
    rpc.failNext["turn/steer"] = "no active turn to steer";
    await runtime.deliver({ text: "two", imagePaths: [], priority: "next" });
    expect(rpc.requests.map((r) => r.method)).toEqual(["thread/start", "turn/start", "turn/steer", "turn/start"]);
  });

  it("runs tool calls from the agent and ignores other threads' notifications", async () => {
    const sent: string[] = [];
    const { rpc, runtime, turns } = setup(null, sent);
    await runtime.deliver({ text: "one", imagePaths: [], priority: "next" });
    rpc.emit("request", { id: 7, method: "item/tool/call", params: { threadId: "thread-new", tool: "send", arguments: { text: "hi" } } });
    rpc.emit("request", { id: 8, method: "item/tool/call", params: { threadId: "thread-new", tool: "send", arguments: { text: 5 } } });
    rpc.emit("notification", { method: "turn/completed", params: { threadId: "someone-else", turn: { id: "x", status: "completed" } } });
    await flush();
    expect(sent).toEqual(["hi"]);
    expect(rpc.responses.find((r) => r.id === 7)).toMatchObject({ result: { success: true } });
    expect(rpc.responses.find((r) => r.id === 8)).toMatchObject({ result: { success: false } });
    expect(turns).toEqual([]);
  });

  it("classifies Codex error text", () => {
    expect(classifyCodexError(new Error("no rollout found for thread id abc"))).toBe("session_missing");
    expect(classifyCodexError(new Error("401 Unauthorized"))).toBe("auth");
    expect(classifyCodexError(new Error("RPC request timed out: turn/start"))).toBe("transient");
    expect(classifyCodexError(new Error("boom"))).toBe("fatal");
  });
});
