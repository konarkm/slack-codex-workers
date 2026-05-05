import { describe, expect, it } from "vitest";
import { helpText, normalizeEffort, parseSlashCommand } from "../core/commands.js";

describe("commands", () => {
  it("parses known slash commands", () => {
    expect(parseSlashCommand("/model gpt-5.5")).toEqual({
      name: "model",
      args: ["gpt-5.5"],
      raw: "/model gpt-5.5",
    });
  });

  it("parses known dot commands", () => {
    expect(parseSlashCommand(".status")).toEqual({
      name: "status",
      args: [],
      raw: ".status",
    });
    expect(parseSlashCommand(".fast on")).toEqual({
      name: "fast",
      args: ["on"],
      raw: ".fast on",
    });
    expect(parseSlashCommand(".new-thread")).toEqual({
      name: "new-thread",
      args: [],
      raw: ".new-thread",
    });
    expect(parseSlashCommand(".workstream-archive ops")).toEqual({
      name: "workstream-archive",
      args: ["ops"],
      raw: ".workstream-archive ops",
    });
    expect(parseSlashCommand("/new-thread")).toEqual({
      name: "new-thread",
      args: [],
      raw: "/new-thread",
    });
  });

  it("parses slash commands with leading whitespace", () => {
    expect(parseSlashCommand("  /health")).toEqual({
      name: "health",
      args: [],
      raw: "  /health",
    });
  });

  it("rejects unknown commands", () => {
    expect(parseSlashCommand("/nope")).toBeNull();
  });

  it("normalizes effort", () => {
    expect(normalizeEffort("HIGH")).toBe("high");
    expect(normalizeEffort("bad")).toBeNull();
  });

  it("renders dm help", () => {
    expect(helpText("dm")).toContain(".restart <codex|bridge|both>");
    expect(helpText("dm")).toContain(".health");
    expect(helpText("dm")).toContain(".restart-now");
    expect(helpText("dm")).toContain(".restart-cancel");
    expect(helpText("dm")).toContain(".new-thread");
    expect(helpText("dm")).toContain(".recover");
    expect(helpText("dm")).toContain(".stop");
    expect(helpText("dm")).toContain(".fast [on|off|status]");
    expect(helpText("dm")).toContain(".workstream-create");
    expect(helpText("dm")).toContain("[channel=<name>]");
    expect(helpText("dm")).toContain(".workstream-archive");
    expect(helpText("dm")).toContain("slash commands may open Slack's built-in command UI first");
    expect(helpText("dm")).toContain("missing or blocked");
  });

  it("renders thread help", () => {
    expect(helpText("thread")).toContain(".status");
    expect(helpText("thread")).toContain(".health");
    expect(helpText("thread")).toContain(".recover");
    expect(helpText("thread")).toContain(".stop");
    expect(helpText("thread")).toContain(".fast [on|off|status]");
    expect(helpText("thread")).toContain(".workstream-create");
    expect(helpText("thread")).toContain("[channel=<name>]");
    expect(helpText("thread")).not.toContain(".workstream-archive");
    expect(helpText("thread")).not.toContain(".restart");
    expect(helpText("thread")).not.toContain(".new-thread");
    expect(helpText("thread")).toContain("missing or blocked");
  });
});
