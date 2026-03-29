import { z } from "zod";

const webhookSourcePattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
const workstreamNamePattern = "^[A-Za-z0-9][A-Za-z0-9-_]{0,79}$";

export const slackListChannelsToolName = "slack_list_channels";
export const slackListWorkstreamsToolName = "list_workstreams";
export const slackSpawnWorkerToolName = "slack_spawn_worker";
export const slackCreateWorkstreamToolName = "slack_create_workstream";
export const slackUploadFilesToolName = "slack_upload_files";
export const slackGetCurrentTimeToolName = "get_current_time";
export const slackGetCurrentSlackThreadLinkToolName = "get_current_slack_thread_link";
export const slackCreateWebhookSourceToolName = "create_webhook_source";
export const slackListWebhookSourcesToolName = "list_webhook_sources";
export const slackGetWebhookSourceToolName = "get_webhook_source";
export const slackListWebhookRegistrationsToolName = "list_webhook_registrations";
export const slackDisableWebhookSourceToolName = "disable_webhook_source";
export const slackRotateWebhookSourceRouteToolName = "rotate_webhook_source_route";
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
      "List registered active workstreams so you can decide where visible child work should be created or handed off. Prefer this over slack_list_channels when routing follow-up work, delegation, or triage into the right workstream. Returns workstream paths plus their Slack channel names and ids.",
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
      "Create a top-level Slack post in a registered workstream and immediately start a separate Codex worker thread for a distinct user-facing task. This is the visible delegation and handoff primitive for splitting work into another workstream lane. The spawned root Slack post includes a child-mode title tag plus the full initialUserMessage body so the delegated instruction stays visible in Slack, and the bridge prepends standard child context so the child knows it is a spawned worker and whether its context is fresh or forked. If workstream is omitted, use the current workstream. workstream should be a canonical relative path like customers/ef or a root alias such as root, /root, or . The spawned worker is fire-and-forget: it does not return a direct response to the parent, so only use this when a separate visible work lane is the right handoff. Use mode='fresh' unless the child truly needs the parent thread context; use mode='fork' only when inheriting context is important.",
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
      "Create a new Slack workstream home and local scaffold after the user has explicitly approved it in the conversation. Use this when the user agrees a new nested workstream should exist. slug defines the canonical workstream path segment. channelName optionally sets the explicit Slack channel name; if omitted it defaults to slug. Both may only use letters, numbers, hyphen, or underscore, and the runtime normalizes them to lowercase before creation. If parent is omitted in a worker thread, the current workstream is used; if omitted in the admin DM, root is used.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: {
        slug: { type: "string", minLength: 1, pattern: workstreamNamePattern },
        channelName: { type: "string", minLength: 1, pattern: workstreamNamePattern },
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
    name: slackCreateWebhookSourceToolName,
    description:
      "Create a new workspace-global raw webhook source definition with a unique public route and a handler file scaffold. Use this when you need the bridge to accept webhook deliveries from some external system and normalize them into a stable internal source/event/fields contract.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
      },
    },
  },
  {
    name: slackListWebhookSourcesToolName,
    description:
      "List workspace-global webhook source definitions so you can inspect which raw webhook intake routes already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: slackGetWebhookSourceToolName,
    description:
      "Inspect one webhook source definition, including its public URL when configured and the handler file path that owns its normalization contract.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
      },
    },
  },
  {
    name: slackListWebhookRegistrationsToolName,
    description:
      "List all webhook registrations in the current workspace that depend on one webhook source. Use this before changing a shared handler contract so you can preserve existing event names, normalized match fields, and behavior relied on elsewhere.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
      },
    },
  },
  {
    name: slackDisableWebhookSourceToolName,
    description:
      "Disable a webhook source definition so the bridge stops accepting new deliveries for that source route.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
      },
    },
  },
  {
    name: slackRotateWebhookSourceRouteToolName,
    description:
      "Rotate the secret public route for a webhook source definition and return the updated public URL. Use this when the route must change without changing the source name or handler contract.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, pattern: webhookSourcePattern },
      },
    },
  },
  {
    name: slackSetNotificationToolName,
    description:
      "Inspect or control whether this worker thread should notify the human by mentioning them in final Slack thread replies. action='get' returns the current thread notification status. action='set' updates it. enabled=true means mention the root owner in final replies. enabled=false means keep final replies visible in the Slack thread without the mention. New threads default to notification on until explicitly changed.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { const: "get" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "enabled"],
          properties: {
            action: { const: "set" },
            enabled: { type: "boolean" },
          },
        },
      ],
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
      "Create or update a durable webhook registration against a workspace-global webhook source definition. If target is omitted it defaults to 'self'. target='self' sends matching events to the current worker, and deliveryMode chooses whether they queue as separate wake work or steer the active turn. target='workstream' creates new public work in the current workstream and only supports queue-style delivery. source must match an existing webhook source definition.",
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
        deliveryMode: { enum: ["queue", "steer"] },
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
  workerDynamicTools.find((entry) => entry.name === slackCreateWebhookSourceToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackListWebhookSourcesToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackGetWebhookSourceToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackListWebhookRegistrationsToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackDisableWebhookSourceToolName)!,
  workerDynamicTools.find((entry) => entry.name === slackRotateWebhookSourceRouteToolName)!,
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
  slug: z.string().min(1).regex(new RegExp(workstreamNamePattern)),
  channelName: z.string().min(1).regex(new RegExp(workstreamNamePattern)).optional(),
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
export const slackCreateWebhookSourceArgsSchema = z.object({
  source: z.string().min(1),
});
export const slackListWebhookSourcesArgsSchema = z.object({
  query: z.string().min(1).optional(),
});
export const slackGetWebhookSourceArgsSchema = z.object({
  source: z.string().min(1),
});
export const slackListWebhookRegistrationsArgsSchema = z.object({
  source: z.string().min(1),
});
export const slackDisableWebhookSourceArgsSchema = z.object({
  source: z.string().min(1),
});
export const slackRotateWebhookSourceRouteArgsSchema = z.object({
  source: z.string().min(1),
});
export const slackSetNotificationArgsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"),
  }).strict(),
  z.object({
    action: z.literal("set"),
    enabled: z.boolean(),
  }).strict(),
]);

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
  deliveryMode: z.enum(["queue", "steer"]).default("queue"),
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
  "Treat the thread as shared evolving context, not a fresh report each turn. Do not restate recent background the human already has unless it changed, is needed to avoid confusion, or they asked for a recap.",
  "In follow-up turns, lead with the delta or direct answer first. Keep repeated diagnostic framing and repeated setup context to a minimum once the issue is already established.",
  "At the start of work in a worker thread, before substantive work, read the current workstream lineage context in root-to-leaf order: for each level from root through the current workstream, read WORKSTREAM.md and then AGENTS.md if present. Root AGENTS.md may already be auto-injected by Codex, but still read the lineage explicitly so the current workstream context is in view.",
  "If the task later moves into a deeper nested workstream subtree, read that deeper lineage's WORKSTREAM.md and AGENTS.md files before doing substantive work in that deeper scope.",
  "Treat workstream handoff as a normal way to delegate or route work when a separate lane would help. Prefer downward delegation into more specific workstreams when the split is obvious; sideways handoff into peer workstreams is allowed but should be more deliberate.",
  "Proactively suggest spawning a child worker when a separate visible work lane would improve delegation, triage, or handoff. When that split is obvious and clearly beneficial, you may directly spawn the child worker without waiting for another round of user confirmation.",
  "Use list_workstreams when you need to choose the right registered workstream for visible child work, delegation, or handoff. Use slack_list_channels only when you specifically need a channel-level view.",
  "Use slack_spawn_worker only for distinct user-facing child tasks that should live as their own top-level Slack thread. Target other workstreams by canonical workstream path, not by Slack channel. A spawned child worker does not send a direct response back to the parent, so if later follow-up or deliverables matter, rely on durable coordination paths such as workstream files or future wakeups rather than assuming synchronous feedback. Do not use it for internal subagents or minor follow-ups.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the current conversation. This is conversational/tool guidance, not a separate permission layer.",
  "Use get_current_time when you need the current local time or configured workspace timezone for time-aware reasoning or scheduling.",
  "Use get_current_slack_thread_link when you need the exact permalink and Slack routing ids for the current public worker thread so you can reference it from another system.",
  "Use create_webhook_source, list_webhook_sources, get_webhook_source, list_webhook_registrations, disable_webhook_source, and rotate_webhook_source_route to manage workspace-global raw webhook intake routes and their handler files. A webhook source has one authoritative source name, one secret route, and one handler contract.",
  "Before changing a shared webhook handler contract, use list_webhook_registrations for that source and preserve existing event names and normalized match fields unless you are intentionally updating dependent registrations too.",
  "Use set_notification(action:'get') to inspect whether this worker thread will notify the human by @ mentioning them in final Slack replies. Use set_notification(action:'set', enabled:true|false) to change that thread-level setting. New threads default to notification on until explicitly changed.",
  "Leave notifications on for final turn outputs whenever the human needs to notice, review, respond, decide, or act on the outcome in any way.",
  "Call set_notification(action:'set', enabled:false) only when you are still progressing autonomously and there is genuinely nothing the human needs to notice or do yet.",
  "For heartbeat, cron, or webhook-driven work, lean toward set_notification(action:'set', enabled:false) when the run is still progressing independently and the human does not need to be aware yet. Leave notification on when the run surfaced a blocker, risk, decision, handoff, or other outcome the human now needs to know, review, or act on.",
  "Use set_heartbeat, set_cron, set_webhook, disable_registration, list_registrations, get_registration, and list_wake_deliveries to manage durable wakeup registrations and inspect wake execution history for the current worker/workstream when you need ongoing automation. For set_webhook(target=self), use deliveryMode='queue' when every event should become separate work and deliveryMode='steer' when matching events should steer the active turn immediately.",
  "Use slack_upload_files when you need to share one or more existing local files into the current Slack thread. Only upload files that materially help the user.",
  "If you create a child worker, it is fire-and-forget. Do not wait on the child unless the human explicitly asks you to.",
  "The client streams your interleaved assistant messages into the Slack thread. Use them for meaningful progress, blockers, or user-relevant state changes; avoid narrating every minor step.",
  "If the human asks for a narrowly scoped output format, keep your final answer exact to that request unless you are blocked. Interleaved messages may still happen when they are materially useful.",
].join("\n");

export const adminDeveloperInstructions = [
  "You are operating in the Slack DM admin surface for a trusted local Codex bridge.",
  "Bridge slash commands are intercepted before they reach you.",
  "During normal execution and routine updates, communicate like a strong operator or employee: lead with the result or current state, keep routine updates concise, and mention detailed evidence only when it is material, surprising, risky, or requested.",
  "When the user is planning, evaluating options, discussing architecture, or setting up a long-horizon workflow, do not over-compress. In those planning conversations, explain tradeoffs, assumptions, and recommended paths clearly enough to support good decisions.",
  "Use slack_create_workstream only after the human has explicitly approved creating a new workstream in the conversation.",
  "Use get_current_time when you need the current local time or configured workspace timezone.",
  "Use create_webhook_source, list_webhook_sources, get_webhook_source, list_webhook_registrations, disable_webhook_source, and rotate_webhook_source_route to manage workspace-global raw webhook intake routes and their handler files.",
  "Before changing a shared webhook handler contract, inspect list_webhook_registrations for that source and preserve existing event names and normalized match fields unless you are intentionally updating dependent registrations too.",
  "Prefer admin-specific tools before shell exploration for operational tasks in the admin DM.",
  "For registration inspection and cleanup, use list_registrations_admin, get_registration_admin, disable_registration_admin, and list_wake_deliveries_admin first. These tools accept explicit workstream or registration filters instead of using current worker-thread scope.",
  "Use archive_workstream_admin when the human wants to retire a child workstream from the admin DM. This is the admin path for archiving a workstream, not a worker-thread operation.",
  "Only fall back to shell or file inspection when the admin tools are insufficient for the task.",
  "Use slack_upload_files when you need to share one or more existing local files into this admin DM conversation.",
  "Use concise operational language suitable for an admin/operator chat.",
].join("\n");
