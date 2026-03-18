import { describe, expect, it } from "vitest";
import {
  slackAdminArchiveWorkstreamArgsSchema,
  slackAdminArchiveWorkstreamToolName,
  slackAdminDisableRegistrationToolName,
  slackAdminGetRegistrationToolName,
  slackAdminListRegistrationsArgsSchema,
  slackAdminListRegistrationsToolName,
  slackAdminListWakeDeliveriesToolName,
  adminDynamicTools,
  adminDeveloperInstructions,
  slackGetCurrentTimeToolName,
  slackGetWebhookMailboxToolName,
  slackRotateWebhookSecretToolName,
  slackCreateWorkstreamArgsSchema,
  slackSetCronArgsSchema,
  slackSetWebhookArgsSchema,
  slackSpawnWorkerArgsSchema,
  workerDeveloperInstructions,
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

  it("exposes the shared webhook mailbox tool to workers and admins", () => {
    const workerTool = workerDynamicTools.find((entry) => entry.name === slackGetWebhookMailboxToolName);
    const adminTool = adminDynamicTools.find((entry) => entry.name === slackGetWebhookMailboxToolName);
    expect(workerTool?.description).toContain("shared webhook mailbox");
    expect(adminTool?.description).toContain("shared webhook mailbox");
  });

  it("exposes webhook secret rotation only on the admin surface", () => {
    expect(workerDynamicTools.map((entry) => entry.name)).not.toContain(slackRotateWebhookSecretToolName);
    expect(adminDynamicTools.map((entry) => entry.name)).toContain(slackRotateWebhookSecretToolName);
  });

  it("tells workers not to echo Slack speaker prefixes back to the human", () => {
    expect(workerDeveloperInstructions).toContain("Do not echo the speaker prefix back in your own replies.");
    expect(workerDeveloperInstructions).toContain("'Konark:'");
  });

  it("tells workers to be concise by default but fuller during planning", () => {
    expect(workerDeveloperInstructions).toContain("communicate like a strong operator or employee");
    expect(workerDeveloperInstructions).toContain("do not over-compress");
    expect(workerDeveloperInstructions).toContain("planning, evaluating options, discussing architecture");
  });

  it("tells admins to be concise by default but fuller during planning", () => {
    expect(adminDeveloperInstructions).toContain("communicate like a strong operator or employee");
    expect(adminDeveloperInstructions).toContain("do not over-compress");
    expect(adminDeveloperInstructions).toContain("planning, evaluating options, discussing architecture");
  });

  it("exposes admin registration management tools only on the admin surface", () => {
    const workerNames = workerDynamicTools.map((entry) => entry.name);
    const adminNames = adminDynamicTools.map((entry) => entry.name);
    expect(workerNames).not.toContain(slackAdminListRegistrationsToolName);
    expect(workerNames).not.toContain(slackAdminGetRegistrationToolName);
    expect(workerNames).not.toContain(slackAdminDisableRegistrationToolName);
    expect(workerNames).not.toContain(slackAdminListWakeDeliveriesToolName);
    expect(workerNames).not.toContain(slackAdminArchiveWorkstreamToolName);
    expect(adminNames).toContain(slackAdminListRegistrationsToolName);
    expect(adminNames).toContain(slackAdminGetRegistrationToolName);
    expect(adminNames).toContain(slackAdminDisableRegistrationToolName);
    expect(adminNames).toContain(slackAdminListWakeDeliveriesToolName);
    expect(adminNames).toContain(slackAdminArchiveWorkstreamToolName);
  });

  it("parses optional admin registration filters", () => {
    expect(slackAdminListRegistrationsArgsSchema.parse({
      workstream: "ops-debug",
    })).toEqual({
      workstream: "ops-debug",
    });
  });

  it("rejects whitespace-only admin workstream filters", () => {
    expect(() => slackAdminListRegistrationsArgsSchema.parse({
      workstream: "   ",
    })).toThrow();
  });

  it("parses admin workstream archive arguments", () => {
    expect(slackAdminArchiveWorkstreamArgsSchema.parse({
      workstream: "ops-debug",
    })).toEqual({
      workstream: "ops-debug",
    });
  });
});
