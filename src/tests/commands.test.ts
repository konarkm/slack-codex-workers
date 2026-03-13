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
  });
});
