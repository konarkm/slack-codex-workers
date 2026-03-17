import { describe, expect, it } from "vitest";
import { slackCreateWorkstreamArgsSchema, slackSpawnWorkerArgsSchema } from "../core/dynamicTools.js";

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

  it("parses workstream creation args", () => {
    expect(slackCreateWorkstreamArgsSchema.parse({
      slug: "ops",
      parent: "root",
      description: "Operational work",
    })).toEqual({
      slug: "ops",
      parent: "root",
      description: "Operational work",
    });
  });
});
