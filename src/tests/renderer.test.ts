import { describe, expect, it } from "vitest";
import { appendFileNotes, normalizeSlackMrkdwn, renderFinalMessage, renderWorklog } from "../slack/renderer.js";

describe("renderer", () => {
  it("renders worklog lines", () => {
    const text = renderWorklog([
      { itemId: "1", type: "commandExecution", title: "Run command", status: "started" },
      { itemId: "2", type: "mcpToolCall", title: "MCP: github/list", status: "completed", detail: "ok" },
    ]);
    expect(text).toContain("_Worklog_");
    expect(text).toContain(":hourglass_flowing_sand: Run command");
    expect(text).toContain(":white_check_mark: MCP: github/list - ok");
  });

  it("renders final owner mention", () => {
    expect(renderFinalMessage("U123", "Done")).toBe("<@U123> Done");
  });

  it("renders final messages without a mention when no owner exists", () => {
    expect(renderFinalMessage("", "Done")).toBe("Done");
  });

  it("appends file notes", () => {
    expect(appendFileNotes("hi", ["a.pdf at /tmp/a.pdf"])).toContain("Attached files:");
  });

  it("normalizes common markdown for Slack mrkdwn", () => {
    const text = normalizeSlackMrkdwn("**Bold** and __italic__ with [OpenAI](https://openai.com/).");
    expect(text).toBe("*Bold* and _italic_ with <https://openai.com/|OpenAI>.");
  });

  it("flattens local markdown links while preserving plain text paths", () => {
    const text = normalizeSlackMrkdwn(
      "See [schema.ts](/workspace/project/foo/schema.ts#L10), [local](./src/file.ts), [file](file:///tmp/a.txt), and plain /workspace/project/foo/schema.ts.",
    );
    expect(text).toBe(
      "See schema.ts, local, file, and plain /workspace/project/foo/schema.ts.",
    );
  });
});
