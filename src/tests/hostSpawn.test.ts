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

  it("lets the remote shell expand a home-relative cwd, and quotes the rest", () => {
    const command = buildRemoteCommand({ command: "codex", args: [], cwd: "~/agent homes/ada", env: { CODEX_HOME: "~/agent homes/ada/.codex-home" } });
    expect(command).toBe(`mkdir -p "$HOME"/'agent homes/ada' && cd "$HOME"/'agent homes/ada' && exec env CODEX_HOME="$HOME"/'agent homes/ada/.codex-home' codex`);
    expect(buildRemoteCommand({ command: "codex", args: [], cwd: "~" })).toBe(`mkdir -p "$HOME" && cd "$HOME" && exec codex`);
  });
});
