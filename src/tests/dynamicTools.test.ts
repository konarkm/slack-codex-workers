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
  slackCreateWebhookSourceToolName,
  slackDisableWebhookSourceToolName,
  slackGetCurrentTimeToolName,
  slackCreateWorkstreamArgsSchema,
  slackGetCurrentSlackThreadLinkToolName,
  slackGetWebhookSourceToolName,
  slackListWebhookRegistrationsToolName,
  slackListWebhookSourcesToolName,
  slackRotateWebhookSourceRouteToolName,
  slackSetCronArgsSchema,
  slackListWorkstreamsToolName,
  slackSetNotificationArgsSchema,
  slackSetNotificationToolName,
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

  it("parses workstream-targeted spawn args", () => {
    expect(
      slackSpawnWorkerArgsSchema.parse({
        workstream: "customers/ef",
        title: "Follow up",
        initialUserMessage: "Check this later",
      }),
    ).toEqual({
      workstream: "customers/ef",
      title: "Follow up",
      initialUserMessage: "Check this later",
      mode: "fresh",
    });
  });

  it("rejects legacy channel-targeted spawn args", () => {
    expect(() => slackSpawnWorkerArgsSchema.parse({
      channel: "#ops",
      title: "Follow up",
      initialUserMessage: "Check this later",
    })).toThrow();
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
      deliveryMode: "queue",
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

  it("exposes the current Slack thread link tool only on the worker surface", () => {
    const workerTool = workerDynamicTools.find((entry) => entry.name === slackGetCurrentSlackThreadLinkToolName);
    const adminNames = adminDynamicTools.map((entry) => entry.name);
    expect(workerTool?.description).toContain("exact Slack permalink for the current public worker thread");
    expect(adminNames).not.toContain(slackGetCurrentSlackThreadLinkToolName);
  });

  it("exposes list_workstreams only on the worker surface", () => {
    const workerTool = workerDynamicTools.find((entry) => entry.name === slackListWorkstreamsToolName);
    const adminNames = adminDynamicTools.map((entry) => entry.name);
    expect(workerTool?.description).toContain("delegation, or triage");
    expect(adminNames).not.toContain(slackListWorkstreamsToolName);
  });

  it("exposes the current time tool to the admin surface", () => {
    const tool = adminDynamicTools.find((entry) => entry.name === slackGetCurrentTimeToolName);
    expect(tool?.description).toContain("current local time or timezone");
  });

  it("exposes webhook source lifecycle tools to workers and admins", () => {
    const names = [
      slackCreateWebhookSourceToolName,
      slackListWebhookSourcesToolName,
      slackGetWebhookSourceToolName,
      slackListWebhookRegistrationsToolName,
      slackDisableWebhookSourceToolName,
      slackRotateWebhookSourceRouteToolName,
    ];
    for (const name of names) {
      expect(workerDynamicTools.map((entry) => entry.name)).toContain(name);
      expect(adminDynamicTools.map((entry) => entry.name)).toContain(name);
    }
  });

  it("parses set_notification arguments", () => {
    expect(slackSetNotificationArgsSchema.parse({
      enabled: true,
    })).toEqual({
      enabled: true,
    });
  });

  it("exposes notification control only on the worker surface", () => {
    const workerTool = workerDynamicTools.find((entry) => entry.name === slackSetNotificationToolName);
    const adminNames = adminDynamicTools.map((entry) => entry.name);
    expect(workerTool?.description).toContain("current worker turn should notify the human");
    expect(adminNames).not.toContain(slackSetNotificationToolName);
  });

  it("tells workers not to echo Slack speaker prefixes back to the human", () => {
    expect(workerDeveloperInstructions).toContain("Do not echo the speaker prefix back in your own replies.");
    expect(workerDeveloperInstructions).toContain("'Konark:'");
  });

  it("tells workers to be concise by default but fuller during planning", () => {
    expect(workerDeveloperInstructions).toContain("communicate like a strong operator or employee");
    expect(workerDeveloperInstructions).toContain("do not over-compress");
    expect(workerDeveloperInstructions).toContain("planning, evaluating options, discussing architecture");
    expect(workerDeveloperInstructions).toContain("Use set_notification(enabled: true|false)");
    expect(workerDeveloperInstructions).toContain("usually call set_notification(enabled: true)");
    expect(workerDeveloperInstructions).toContain("Use get_current_slack_thread_link");
    expect(workerDeveloperInstructions).toContain("Use list_workstreams");
    expect(workerDeveloperInstructions).toContain("create_webhook_source, list_webhook_sources, get_webhook_source, list_webhook_registrations");
    expect(workerDeveloperInstructions).toContain("Treat workstream handoff as a normal way to delegate or route work");
    expect(workerDeveloperInstructions).toContain("Proactively suggest spawning a child worker");
    expect(workerDeveloperInstructions).toContain("does not send a direct response back to the parent");
    expect(workerDeveloperInstructions).toContain("Before changing a shared webhook handler contract");
    expect(workerDeveloperInstructions).toContain("interleaved assistant messages into the Slack thread");
    expect(workerDeveloperInstructions).toContain("meaningful progress, blockers, or user-relevant state changes");
    expect(workerDeveloperInstructions).toContain("narrowly scoped output format");
  });

  it("tells admins to be concise by default but fuller during planning", () => {
    expect(adminDeveloperInstructions).toContain("communicate like a strong operator or employee");
    expect(adminDeveloperInstructions).toContain("do not over-compress");
    expect(adminDeveloperInstructions).toContain("planning, evaluating options, discussing architecture");
    expect(adminDeveloperInstructions).toContain("list_webhook_registrations");
    expect(adminDeveloperInstructions).toContain("Before changing a shared webhook handler contract");
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
