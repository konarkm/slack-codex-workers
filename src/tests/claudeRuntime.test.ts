import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeRuntime, claudeToolServerConfig } from "../runtimes/claudeRuntime.js";
import { DEFAULT_WAKE_POLICY, type RuntimeInput } from "../agents/types.js";

describe("claudeToolServerConfig", () => {
  it("points Claude at the tool server, keeps the tools in the prompt, and leaves the token to the environment", () => {
    const config = claudeToolServerConfig("http://127.0.0.1:3015/mcp");
    expect(config).toEqual({
      bridge: { type: "http", url: "http://127.0.0.1:3015/mcp", headers: { Authorization: "Bearer ${SLACK_AGENTS_TOOL_TOKEN}" }, alwaysLoad: true, timeout: 900_000 },
    });
  });
});

describe("ClaudeRuntime", () => {
  it("leaves out an image that can no longer be read, and says so, instead of failing the hand-off", async () => {
    const runtime = new ClaudeRuntime({
      spec: { name: "ada", title: null, runtime: "claude", model: null, effort: null, host: { kind: "local" }, cwd: "/tmp", wake: DEFAULT_WAKE_POLICY, icon: null, instructionsPath: null, inheritUserConfig: false, denyTools: [], retired: false },
      sessionId: null,
      instructions: "",
      tools: [],
      toolAccess: { url: "http://127.0.0.1:0/mcp", token: "t" },
      events: { onSessionChanged: () => {}, onStateChanged: () => {}, onTurnCompleted: () => {}, onActivity: () => {}, onCompaction: () => {}, onProblem: () => {} },
    });
    const build = (runtime as unknown as { buildUserMessage(input: RuntimeInput): Promise<SDKUserMessage> }).buildUserMessage.bind(runtime);
    const message = await build({ id: "in-one", text: "look at this", imagePaths: ["/nonexistent/gone.png"], priority: "next" });
    expect(message.message.content).toBe("look at this\n\n[bridge notice] Not attached; the file could not be read (it may have been removed): /nonexistent/gone.png");
  });
});
