import { describe, expect, it } from "vitest";
import { helpText, normalizeEffort, parseSlashCommand } from "../core/commands.js";

describe("commands", () => {
  it("parses known slash commands", () => {
    expect(parseSlashCommand("/model gpt-5.4")).toEqual({
      name: "model",
      args: ["gpt-5.4"],
      raw: "/model gpt-5.4",
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
    expect(helpText("dm")).toContain("/restart <codex|bridge|both>");
    expect(helpText("dm")).toContain("/health");
    expect(helpText("dm")).toContain("/restart-now");
    expect(helpText("dm")).toContain("/restart-cancel");
    expect(helpText("dm")).toContain("/recover");
    expect(helpText("dm")).toContain("/stop");
    expect(helpText("dm")).toContain("missing or blocked");
  });

  it("renders thread help", () => {
    expect(helpText("thread")).toContain("/status");
    expect(helpText("thread")).toContain("/health");
    expect(helpText("thread")).toContain("/recover");
    expect(helpText("thread")).toContain("/stop");
    expect(helpText("thread")).not.toContain("/restart");
    expect(helpText("thread")).toContain("missing or blocked");
  });
});
