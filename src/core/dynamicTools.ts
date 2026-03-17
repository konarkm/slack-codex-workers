import { z } from "zod";

export const slackListChannelsToolName = "slack_list_channels";
export const slackSpawnWorkerToolName = "slack_spawn_worker";
export const slackCreateWorkstreamToolName = "slack_create_workstream";
export const slackUploadFilesToolName = "slack_upload_files";
export const slackSetHeartbeatToolName = "set_heartbeat";
export const slackSetCronToolName = "set_cron";
export const slackSetWebhookToolName = "set_webhook";
export const slackDisableRegistrationToolName = "disable_registration";
export const slackListRegistrationsToolName = "list_registrations";
export const slackGetRegistrationToolName = "get_registration";
export const slackListPendingWakesToolName = "list_pending_wakes";

export const workerDynamicTools = [
  {
    name: slackListChannelsToolName,
    description:
      "List registered Slack workstream channels so you can decide where a public child worker should be created. Use when you need to route a follow-up task to the right workstream home. Returns channel ids and names.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackSpawnWorkerToolName,
    description:
      "Create a top-level Slack post in a registered workstream channel and immediately start a separate Codex worker thread for a distinct user-facing task. Use this only for visible child work, not for internal delegation. If channel is omitted, use the current workstream channel. Use mode='fresh' unless the child truly needs the parent thread context; use mode='fork' only when inheriting context is important.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "initialUserMessage"],
      properties: {
        channel: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        initialUserMessage: { type: "string", minLength: 1 },
        mode: { enum: ["fresh", "fork"] },
      },
    },
  },
  {
    name: slackCreateWorkstreamToolName,
    description:
      "Create a new Slack workstream home and local scaffold after the user has explicitly approved it in the conversation. Use this when the user agrees a new nested workstream should exist. If parent is omitted in a worker thread, the current workstream is used; if omitted in the admin DM, root is used.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: {
        slug: { type: "string", minLength: 1 },
        parent: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackUploadFilesToolName,
    description:
      "Upload one or more local files into the current Slack conversation. Use this to share artifacts, screenshots, logs, reports, or other files that already exist on disk. Paths may be relative to the current working directory. An optional comment is shared with the files in the same Slack post.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        comment: { type: "string", minLength: 1 },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
              path: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
  {
    name: slackSetHeartbeatToolName,
    description:
      "Create or update a durable worker heartbeat registration for the current public worker thread. This always targets wake_self on the current worker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intervalMinutes"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
        intervalMinutes: { type: "integer", minimum: 1 },
        description: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackSetCronToolName,
    description:
      "Create or update a durable cron registration. target='self' wakes the current worker; target='workstream' creates new public work in the current workstream.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["schedule"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
        schedule: { type: "string", minLength: 1 },
        target: { enum: ["self", "workstream"] },
        description: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackSetWebhookToolName,
    description:
      "Create or update a durable webhook registration. target='self' wakes the current worker; target='workstream' creates new public work in the current workstream.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source", "events"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
        source: { type: "string", minLength: 1 },
        events: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        target: { enum: ["self", "workstream"] },
        description: { type: "string", minLength: 1 },
        match: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },
  },
  {
    name: slackDisableRegistrationToolName,
    description:
      "Disable a durable registration in the current worker/workstream scope without deleting it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["registrationId"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackListRegistrationsToolName,
    description:
      "List durable registrations in the current worker/workstream scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: slackGetRegistrationToolName,
    description:
      "Get the full details for one durable registration in the current worker/workstream scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["registrationId"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackListPendingWakesToolName,
    description:
      "List queued wake deliveries in the current worker/workstream scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
] as const;

export const adminDynamicTools = [
  workerDynamicTools[2],
  workerDynamicTools[3],
] as const;

export const dynamicToolCallParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

export const slackListChannelsArgsSchema = z.object({
  query: z.string().min(1).optional(),
});

export const slackSpawnWorkerArgsSchema = z.object({
  channel: z.string().min(1).optional(),
  title: z.string().min(1),
  initialUserMessage: z.string().min(1),
  mode: z.enum(["fresh", "fork"]).default("fresh"),
});

export const slackCreateWorkstreamArgsSchema = z.object({
  slug: z.string().min(1),
  parent: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

export const slackUploadFilesArgsSchema = z.object({
  comment: z.string().min(1).optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    title: z.string().min(1).optional(),
  })).min(1),
});

export const slackSetHeartbeatArgsSchema = z.object({
  registrationId: z.string().min(1).optional(),
  intervalMinutes: z.number().int().min(1),
  description: z.string().min(1).optional(),
});

export const slackSetCronArgsSchema = z.object({
  registrationId: z.string().min(1).optional(),
  schedule: z.string().min(1),
  target: z.enum(["self", "workstream"]).default("self"),
  description: z.string().min(1).optional(),
});

export const slackSetWebhookArgsSchema = z.object({
  registrationId: z.string().min(1).optional(),
  source: z.string().min(1),
  events: z.array(z.string().min(1)).min(1),
  target: z.enum(["self", "workstream"]).default("self"),
  description: z.string().min(1).optional(),
  match: z.record(z.string(), z.string()).optional(),
});

export const slackDisableRegistrationArgsSchema = z.object({
  registrationId: z.string().min(1),
});

export const slackGetRegistrationArgsSchema = z.object({
  registrationId: z.string().min(1),
});

export const workerDeveloperInstructions = [
  "You are operating inside Slack as one worker in a shared-bot system.",
  "Incoming human messages are prefixed with the Slack speaker name, for example 'alice: can you check this'. Treat that prefix as authoritative speaker identity.",
  "Use normal assistant messages to communicate substantive progress. Raw reasoning is not shown to the human.",
  "Use slack_spawn_worker only for distinct user-facing child tasks that should live as their own top-level Slack thread. Do not use it for internal subagents or minor follow-ups.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the current conversation. This is conversational/tool guidance, not a separate permission layer.",
  "Use set_heartbeat, set_cron, set_webhook, disable_registration, list_registrations, get_registration, and list_pending_wakes to manage durable wakeup registrations for the current worker/workstream when you need ongoing automation.",
  "Use slack_upload_files when you need to share one or more existing local files into the current Slack thread. Only upload files that materially help the user.",
  "If you create a child worker, it is fire-and-forget. Do not wait on the child unless the human explicitly asks you to.",
  "Keep progress clear and concise because the client streams your interleaved assistant messages into the Slack thread.",
].join("\n");

export const adminDeveloperInstructions = [
  "You are operating in the Slack DM admin surface for a trusted local Codex bridge.",
  "Bridge slash commands are intercepted before they reach you.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the conversation.",
  "Use slack_upload_files when you need to share one or more existing local files into this admin DM conversation.",
  "Use concise operational language suitable for an admin/operator chat.",
].join("\n");
