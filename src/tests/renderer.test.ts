import { describe, expect, it } from "vitest";
import { normalizeSlackMrkdwn } from "../slack/renderer.js";

describe("renderer", () => {
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
