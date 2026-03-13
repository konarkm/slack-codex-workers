import { describe, expect, it } from "vitest";
import { slackSpawnWorkerArgsSchema } from "../core/dynamicTools.js";

describe("dynamic tools", () => {
  it("defaults spawn mode to fresh", () => {
    expect(
      slackSpawnWorkerArgsSchema.parse({
        title: "Follow up",
        initialUserMessage: "Check this later",
      }),
    ).toEqual({
      title: "Follow up",
      initialUserMessage: "Check this later",
      mode: "fresh",
    });
  });
});
