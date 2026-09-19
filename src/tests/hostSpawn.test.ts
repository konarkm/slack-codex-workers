import { describe, expect, it } from "vitest";
import { buildRemoteCommand, shellQuote } from "../agents/hostSpawn.js";

describe("remote spawn command", () => {
  it("quotes anything a shell could interpret", () => {
    expect(shellQuote("plain-value_1.0")).toBe("plain-value_1.0");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's; rm -rf ~")).toBe(`'it'\\''s; rm -rf ~'`);
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
  });

  it("creates the agent's home, enters it, and execs the harness with only the given env", () => {
    const command = buildRemoteCommand({ command: "claude", args: ["--output-format", "stream-json", "--append-system-prompt", "You are ada; be brief"], cwd: "/home/box/agents/ada", env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", "bad key": "x", SKIPPED: undefined } });
    expect(command).toBe("mkdir -p /home/box/agents/ada && cd /home/box/agents/ada && exec env CLAUDE_CODE_ENTRYPOINT=sdk-ts claude --output-format stream-json --append-system-prompt 'You are ada; be brief'");
  });
});
