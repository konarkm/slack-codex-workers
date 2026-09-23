import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CodexRuntime, classifyCodexError, codexDenyArgs, codexToolServerArgs, type CodexRpc } from "../runtimes/codexRuntime.js";
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
  icon: null,
  instructionsPath: null,
  inheritUserConfig: false,
  denyTools: [],
  retired: false,
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

function setup(sessionId: string | null) {
  const rpc = new FakeRpc();
  const states: RuntimeState[] = [];
  const sessions: Array<string | null> = [];
  const turns: Array<{ status: string; finalText: string; consumedInputIds: string[] }> = [];
  const events: RuntimeEvents = {
    onSessionChanged: (id) => void sessions.push(id),
    onStateChanged: (state) => void states.push(state),
    onTurnCompleted: (event) => void turns.push(event),
    onActivity: () => {},
    onCompaction: () => {},
    onProblem: () => {},
  };
  const runtime = new CodexRuntime(
    {
      spec,
      sessionId,
      instructions: "be a teammate",
      tools: [{ name: "send", description: "send", shape: { text: z.string() }, handler: async () => "ok" }],
      toolAccess: ACCESS,
      events,
    },
    "codex",
    () => rpc as unknown as CodexRpc,
  );
  return { rpc, runtime, states, sessions, turns };
}

const ACCESS = { url: "http://127.0.0.1:3015/mcp", token: "secret" };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));


describe("CodexRuntime", () => {
  it("starts a thread without baked-in tools (they come from the tool server) and reports the session", async () => {
    const { rpc, runtime, sessions } = setup(null);
    await runtime.start();
    const start = rpc.requests.find((r) => r.method === "thread/start")!;
    expect(start.params.dynamicTools).toBeUndefined();
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

  it("hands Codex the tool server as config overrides and keeps the token out of argv", () => {
    const args = codexToolServerArgs("http://127.0.0.1:3015/mcp");
    expect(args).toEqual(["-c", 'mcp_servers.workspace.url="http://127.0.0.1:3015/mcp"', "-c", 'mcp_servers.workspace.bearer_token_env_var="SLACK_AGENTS_TOOL_TOKEN"', "-c", "mcp_servers.workspace.tool_timeout_sec=900"]);
    expect(args.join(" ")).not.toContain("secret");
  });

  it("starts a turn when idle and steers the running turn otherwise", async () => {
    const { rpc, runtime, states, turns } = setup(null);
    await runtime.deliver({ id: "in-one", text: "one", imagePaths: [], priority: "next" });
    await runtime.deliver({ id: "in-two", text: "two", imagePaths: ["/tmp/a.png"], priority: "next" });
    const methods = rpc.requests.map((r) => r.method);
    expect(methods).toEqual(["thread/start", "turn/start", "turn/steer"]);
    expect(rpc.requests[2]!.params).toMatchObject({ expectedTurnId: "turn-1" });
    expect(rpc.requests[2]!.params.input[1]).toEqual({ type: "localImage", path: "/tmp/a.png" });

    rpc.emit("notification", { method: "item/completed", params: { threadId: "thread-new", item: { id: "i1", type: "agentMessage", text: "done" } } });
    rpc.emit("notification", { method: "turn/completed", params: { threadId: "thread-new", turn: { id: "turn-1", status: "completed" } } });
    await flush();
    expect(turns).toEqual([{ status: "completed", finalText: "done", error: null, consumedInputIds: ["in-one", "in-two"], inputFault: false }]);
    expect(states.at(-1)).toBe("idle");

    await runtime.deliver({ id: "in-three", text: "three", imagePaths: [], priority: "next" });
    expect(rpc.requests.at(-1)!.method).toBe("turn/start");
  });

  it("falls through to a new turn when the steer target already ended", async () => {
    const { rpc, runtime } = setup(null);
    await runtime.deliver({ id: "in-one", text: "one", imagePaths: [], priority: "next" });
    rpc.failNext["turn/steer"] = "no active turn to steer";
    await runtime.deliver({ id: "in-two", text: "two", imagePaths: [], priority: "next" });
    expect(rpc.requests.map((r) => r.method)).toEqual(["thread/start", "turn/start", "turn/steer", "turn/start"]);
  });

  it("does not mark a turn running when it finished before the start response arrived", async () => {
    const { rpc, runtime, states } = setup(null);
    await runtime.start();
    const original = rpc.request.bind(rpc);
    rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await original<T>(method, params);
      if (method === "turn/start") {
        rpc.emit("notification", { method: "turn/started", params: { threadId: "thread-new", turn: { id: "turn-1" } } });
        rpc.emit("notification", { method: "turn/completed", params: { threadId: "thread-new", turn: { id: "turn-1", status: "completed" } } });
        await flush();
      }
      return result;
    };
    await runtime.deliver({ id: "in-quick", text: "quick", imagePaths: [], priority: "next" });
    await flush();
    expect(runtime.state()).toBe("idle");
    expect(states.at(-1)).toBe("idle");
  });

  it("does not resend input as a new turn when a steer times out", async () => {
    const { rpc, runtime } = setup(null);
    await runtime.deliver({ id: "in-one", text: "one", imagePaths: [], priority: "next" });
    rpc.failNext["turn/steer"] = "RPC request timed out: turn/steer";
    await expect(runtime.deliver({ id: "in-two", text: "two", imagePaths: [], priority: "next" })).rejects.toThrow(/timed out/);
    expect(rpc.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  it("treats a failed start request as taken when the turn is seen to have started", async () => {
    const { rpc, runtime } = setup(null);
    await runtime.start();
    const original = rpc.request.bind(rpc);
    rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
      if (method === "turn/start") {
        rpc.emit("notification", { method: "turn/started", params: { threadId: "thread-new", turn: { id: "turn-9" } } });
        await flush();
        throw new Error("RPC request timed out: turn/start");
      }
      return original<T>(method, params);
    };
    await runtime.deliver({ id: "in-one", text: "one", imagePaths: [], priority: "next" });
    expect(runtime.state()).toBe("running");
  });

  it("gives up on a thread that keeps failing to resume, whatever the error says", async () => {
    const { rpc, runtime, sessions } = setup("thread-old");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      rpc.failNext["thread/resume"] = "conversation is corrupt";
      await expect(runtime.start()).rejects.toThrow(/corrupt/);
    }
    rpc.failNext["thread/resume"] = "conversation is corrupt";
    await runtime.start();
    expect(sessions).toEqual(["thread-new"]);
  });

  it("ignores other threads' notifications", async () => {
    const { rpc, runtime, turns } = setup(null);
    await runtime.deliver({ id: "in-one", text: "one", imagePaths: [], priority: "next" });
    rpc.emit("notification", { method: "turn/completed", params: { threadId: "someone-else", turn: { id: "x", status: "completed" } } });
    await flush();
    expect(turns).toEqual([]);
  });

  it("turns denied servers into process-level overrides, and the app connectors into a feature switch", () => {
    // claude_ai_Slack is not a server this Codex home defines; naming it would stop Codex from starting.
    expect(codexDenyArgs(["mcp__composio", "mcp__codex_apps", "Bash(rm *)", "mcp__claude_ai_Slack"], ["composio", "things"])).toEqual([
      "-c", "mcp_servers.composio.enabled=false",
      "-c", "features.apps=false",
    ]);
    expect(codexDenyArgs([], ["composio"])).toEqual([]);
  });

  it("sends instructions and policy again when resuming a thread", async () => {
    const { rpc, runtime } = setup("thread-old");
    await runtime.start();
    expect(rpc.requests[0]).toMatchObject({ method: "thread/resume", params: { threadId: "thread-old", developerInstructions: "be a teammate", approvalPolicy: "never", sandbox: "danger-full-access" } });
  });

  it("classifies Codex error text", () => {
    expect(classifyCodexError(new Error("no rollout found for thread id abc"))).toBe("session_missing");
    expect(classifyCodexError(new Error("401 Unauthorized"))).toBe("auth");
    expect(classifyCodexError(new Error("RPC request timed out: turn/start"))).toBe("transient");
    expect(classifyCodexError(new Error("boom"))).toBe("fatal");
  });
});
