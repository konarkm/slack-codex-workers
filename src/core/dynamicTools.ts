import { z } from "zod";

const webhookSourcePattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

export const slackListChannelsToolName = "slack_list_channels";
export const slackListWorkstreamsToolName = "list_workstreams";
export const slackSpawnWorkerToolName = "slack_spawn_worker";
export const slackCreateWorkstreamToolName = "slack_create_workstream";
export const slackUploadFilesToolName = "slack_upload_files";
export const slackGetCurrentTimeToolName = "get_current_time";
export const slackGetCurrentSlackThreadLinkToolName = "get_current_slack_thread_link";
export const slackGetWebhookMailboxToolName = "get_webhook_mailbox";
export const slackRotateWebhookSecretToolName = "rotate_webhook_secret";
export const slackSetNotificationToolName = "set_notification";
export const slackSetHeartbeatToolName = "set_heartbeat";
export const slackSetCronToolName = "set_cron";
export const slackSetWebhookToolName = "set_webhook";
export const slackDisableRegistrationToolName = "disable_registration";
export const slackListRegistrationsToolName = "list_registrations";
export const slackGetRegistrationToolName = "get_registration";
export const slackListWakeDeliveriesToolName = "list_wake_deliveries";
export const slackAdminDisableRegistrationToolName = "disable_registration_admin";
export const slackAdminListRegistrationsToolName = "list_registrations_admin";
export const slackAdminGetRegistrationToolName = "get_registration_admin";
export const slackAdminListWakeDeliveriesToolName = "list_wake_deliveries_admin";
export const slackAdminArchiveWorkstreamToolName = "archive_workstream_admin";

export const workerDynamicTools = [
  {
    name: slackListChannelsToolName,
    description:
      "List registered Slack workstream channels. Use this when you need a channel-level view of the bridge workspace. Returns only active registered workstream-home channels.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackListWorkstreamsToolName,
    description:
      "List registered active workstreams so you can decide where visible child work should be created. Prefer this over slack_list_channels when routing follow-up work. Returns workstream paths plus their Slack channel names and ids.",
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
      "Create a top-level Slack post in a registered workstream and immediately start a separate Codex worker thread for a distinct user-facing task. Use this only for visible child work, not for internal delegation. If workstream is omitted, use the current workstream. workstream should be a canonical relative path like customers/ef or a root alias such as root, /root, or . Use mode='fresh' unless the child truly needs the parent thread context; use mode='fork' only when inheriting context is important.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "initialUserMessage"],
      properties: {
        workstream: { type: "string", minLength: 1 },
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
    name: slackGetCurrentTimeToolName,
    description:
      "Get the current time along with the configured workspace timezone. Use this when you need the current local time or timezone before choosing a schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: slackGetCurrentSlackThreadLinkToolName,
    description:
      "Get the exact Slack permalink for the current public worker thread root message, along with the Slack routing ids for that thread. Use this when you need to reference the current Slack thread from another system such as Linear.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: slackGetWebhookMailboxToolName,
    description:
      "Get the shared webhook mailbox configuration for this bridge, including the public endpoint when configured, the shared secret, the accepted auth headers, and the JSON body shape expected by webhook ingress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: slackSetNotificationToolName,
    description:
      "Control whether the current worker turn should notify the human when it completes. enabled=true means mention the root owner on the final reply for this turn. enabled=false means keep the final reply visible in the Slack thread without the mention. This is turn-scoped and defaults to false unless you opt in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
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
      "Create or update a durable cron registration. If target is omitted it defaults to 'self'. target='self' wakes the current worker; target='workstream' creates new public work in the current workstream. schedule must be a 5-field cron string using numeric fields, ranges, lists, and steps. Cron schedules are interpreted in the configured workspace timezone. Use get_current_time when you need the current local time or timezone before choosing a schedule.",
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
      "Create or update a durable webhook registration against the shared bridge webhook mailbox. If target is omitted it defaults to 'self'. target='self' wakes the current worker; target='workstream' creates new public work in the current workstream. source is the logical producer namespace and must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}. Use get_webhook_mailbox when you need the shared endpoint, auth secret, or payload shape for configuring external systems.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source", "events"],
      properties: {
        registrationId: { type: "string", minLength: 1 },
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
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
    name: slackListWakeDeliveriesToolName,
    description:
      "List wake delivery records in the current worker/workstream scope, including queued, delivered, failed, and quarantined executions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
] as const;

export const adminDynamicTools = [
  workerDynamicTools.find((entry) => entry.name === slackGetCurrentTimeToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackGetWebhookMailboxToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackCreateWorkstreamToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackUploadFilesToolName)!,
  {
    name: slackAdminListRegistrationsToolName,
    description:
      "Primary admin tool for bird's-eye registration inspection from the admin DM. Prefer this over shell or file inspection when you need to see registrations. If workstream is provided, limit results to that workstream path; otherwise list all registrations in the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workstream: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackAdminGetRegistrationToolName,
    description:
      "Primary admin tool for detailed registration inspection by id from the admin DM. Prefer this over shell or file inspection when you need the full stored registration record, regardless of which worker or workstream owns it.",
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
    name: slackAdminDisableRegistrationToolName,
    description:
      "Primary admin tool for registration cleanup from the admin DM. Disable a durable registration by id without deleting it, regardless of which worker or workstream owns it.",
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
    name: slackAdminListWakeDeliveriesToolName,
    description:
      "Primary admin tool for wake-delivery inspection from the admin DM. Prefer this over shell or file inspection when you need queued, delivered, failed, or quarantined wake records. Filter by workstream path and/or registration id when you need a narrower operational view.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workstream: { type: "string", minLength: 1 },
        registrationId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackAdminArchiveWorkstreamToolName,
    description:
      "Primary admin tool for retiring a child workstream from the admin DM. Archive the Slack channel, disable that workstream's registrations, quarantine queued or retryable wakes, and remove it from live routing while keeping the local scaffold on disk.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workstream"],
      properties: {
        workstream: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackRotateWebhookSecretToolName,
    description:
      "Rotate the shared webhook mailbox secret for the entire bridge. This moves the previous current secret into fallback position and returns the updated mailbox bundle. Use this only in the admin DM when rotating external webhook credentials intentionally.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
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

export const slackListWorkstreamsArgsSchema = z.object({
  query: z.string().min(1).optional(),
});

export const slackSpawnWorkerArgsSchema = z.object({
  workstream: z.string().min(1).optional(),
  title: z.string().min(1),
  initialUserMessage: z.string().min(1),
  mode: z.enum(["fresh", "fork"]).default("fresh"),
}).strict();

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

export const slackGetCurrentSlackThreadLinkArgsSchema = z.object({});
export const slackGetWebhookMailboxArgsSchema = z.object({});
export const slackRotateWebhookSecretArgsSchema = z.object({});
export const slackSetNotificationArgsSchema = z.object({
  enabled: z.boolean(),
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

export const slackAdminListRegistrationsArgsSchema = z.object({
  workstream: z.string().trim().min(1).optional(),
});

export const slackGetRegistrationArgsSchema = z.object({
  registrationId: z.string().min(1),
});

export const slackAdminGetRegistrationArgsSchema = z.object({
  registrationId: z.string().min(1),
});

export const slackAdminDisableRegistrationArgsSchema = z.object({
  registrationId: z.string().min(1),
});

export const slackAdminListWakeDeliveriesArgsSchema = z.object({
  workstream: z.string().trim().min(1).optional(),
  registrationId: z.string().min(1).optional(),
});

export const slackAdminArchiveWorkstreamArgsSchema = z.object({
  workstream: z.string().trim().min(1),
});

export const workerDeveloperInstructions = [
  "You are operating inside Slack as one worker in a shared-bot system.",
  "Incoming human messages are prefixed with the Slack speaker name, for example 'alice: can you check this'. Treat that prefix as authoritative speaker identity.",
  "Do not echo the speaker prefix back in your own replies. Write naturally to the human instead of starting messages with forms like 'alice:' or 'Konark:'.",
  "During normal execution and routine updates, communicate like a strong operator or employee: lead with the result or current state, keep routine updates concise, and mention detailed evidence only when it is material, surprising, risky, or requested.",
  "When the user is planning, evaluating options, discussing architecture, or setting up a long-horizon workflow, do not over-compress. In those planning conversations, explain tradeoffs, assumptions, and recommended paths clearly enough to support good decisions.",
  "Use normal assistant messages to communicate substantive progress. Raw reasoning is not shown to the human.",
  "Use list_workstreams when you need to choose the right registered workstream for visible child work. Use slack_list_channels only when you specifically need a channel-level view.",
  "Use slack_spawn_worker only for distinct user-facing child tasks that should live as their own top-level Slack thread. Target other workstreams by canonical workstream path, not by Slack channel. Do not use it for internal subagents or minor follow-ups.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the current conversation. This is conversational/tool guidance, not a separate permission layer.",
  "Use get_current_time when you need the current local time or configured workspace timezone for time-aware reasoning or scheduling.",
  "Use get_current_slack_thread_link when you need the exact permalink and Slack routing ids for the current public worker thread so you can reference it from another system.",
  "Use get_webhook_mailbox when you need the bridge's shared webhook endpoint, secret, or accepted payload shape so you can configure external systems end-to-end.",
  "Use set_notification(enabled: true|false) to decide whether the current worker turn should notify the human on completion. The default is no notification unless you opt in.",
  "For direct back-and-forth with the human in this Slack thread, you should usually call set_notification(enabled: true) before finishing your turn unless the human asked you not to notify them.",
  "For autonomous heartbeat, cron, or webhook wake work, usually leave notification off unless there is a material update, blocker, risk, or decision that warrants pinging the human.",
  "Use set_heartbeat, set_cron, set_webhook, disable_registration, list_registrations, get_registration, and list_wake_deliveries to manage durable wakeup registrations and inspect wake execution history for the current worker/workstream when you need ongoing automation.",
  "Use slack_upload_files when you need to share one or more existing local files into the current Slack thread. Only upload files that materially help the user.",
  "If you create a child worker, it is fire-and-forget. Do not wait on the child unless the human explicitly asks you to.",
  "Keep progress clear and concise because the client streams your interleaved assistant messages into the Slack thread.",
].join("\n");

export const adminDeveloperInstructions = [
  "You are operating in the Slack DM admin surface for a trusted local Codex bridge.",
  "Bridge slash commands are intercepted before they reach you.",
  "During normal execution and routine updates, communicate like a strong operator or employee: lead with the result or current state, keep routine updates concise, and mention detailed evidence only when it is material, surprising, risky, or requested.",
  "When the user is planning, evaluating options, discussing architecture, or setting up a long-horizon workflow, do not over-compress. In those planning conversations, explain tradeoffs, assumptions, and recommended paths clearly enough to support good decisions.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the conversation.",
  "Use get_current_time when you need the current local time or configured workspace timezone.",
  "Use get_webhook_mailbox to inspect the current shared webhook mailbox endpoint and secret, and use rotate_webhook_secret when the human intentionally wants to rotate that organization-wide secret.",
  "Prefer admin-specific tools before shell exploration for operational tasks in the admin DM.",
  "For registration inspection and cleanup, use list_registrations_admin, get_registration_admin, disable_registration_admin, and list_wake_deliveries_admin first. These tools accept explicit workstream or registration filters instead of using current worker-thread scope.",
  "Use archive_workstream_admin when the human wants to retire a child workstream from the admin DM. This is the admin path for archiving a workstream, not a worker-thread operation.",
  "Only fall back to shell or file inspection when the admin tools are insufficient for the task.",
  "Use slack_upload_files when you need to share one or more existing local files into this admin DM conversation.",
  "Use concise operational language suitable for an admin/operator chat.",
].join("\n");
