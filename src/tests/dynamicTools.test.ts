import { describe, expect, it } from "vitest";
import {
  adminDynamicTools,
  slackGetCurrentTimeToolName,
  slackCreateWorkstreamArgsSchema,
  slackSetCronArgsSchema,
  slackSetWebhookArgsSchema,
  slackSpawnWorkerArgsSchema,
  workerDynamicTools,
} from "../core/dynamicTools.js";

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

  it("defaults cron target to self", () => {
    expect(slackSetCronArgsSchema.parse({
      schedule: "0 * * * *",
    })).toEqual({
      schedule: "0 * * * *",
      target: "self",
    });
  });

  it("defaults webhook target to self", () => {
    expect(slackSetWebhookArgsSchema.parse({
      source: "github",
      events: ["push"],
    })).toEqual({
      source: "github",
      events: ["push"],
      target: "self",
    });
  });

  it("describes cron registrations as using the time tool for local time", () => {
    const tool = workerDynamicTools.find((entry) => entry.name === "set_cron");
    expect(tool?.description).toContain("Use get_current_time");
    expect(tool?.description).toContain("5-field cron string");
  });

  it("exposes a current time tool", () => {
    const tool = workerDynamicTools.find((entry) => entry.name === slackGetCurrentTimeToolName);
    expect(tool?.description).toContain("current local time or timezone");
  });

  it("exposes the current time tool to the admin surface", () => {
    const tool = adminDynamicTools.find((entry) => entry.name === slackGetCurrentTimeToolName);
    expect(tool?.description).toContain("current local time or timezone");
  });
});
