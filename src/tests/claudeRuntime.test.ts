import { describe, expect, it } from "vitest";
import { claudeToolServerConfig } from "../runtimes/claudeRuntime.js";

describe("claudeToolServerConfig", () => {
  it("points Claude at the tool server, keeps the tools in the prompt, and leaves the token to the environment", () => {
    const config = claudeToolServerConfig("http://127.0.0.1:3015/mcp");
    expect(config).toEqual({
      bridge: { type: "http", url: "http://127.0.0.1:3015/mcp", headers: { Authorization: "Bearer ${SLACK_AGENTS_TOOL_TOKEN}" }, alwaysLoad: true, timeout: 900_000 },
    });
  });
});
