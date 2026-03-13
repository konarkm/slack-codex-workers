import { z } from "zod";

export const slackListChannelsToolName = "slack_list_channels";
export const slackSpawnWorkerToolName = "slack_spawn_worker";
export const slackUploadFilesToolName = "slack_upload_files";

export const workerDynamicTools = [
  {
    name: slackListChannelsToolName,
    description:
      "List accessible Slack channels so you can decide where a public child worker should be created. Use when you need to route a follow-up task to the right channel. Returns channel ids and names.",
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
      "Create a top-level Slack post that immediately starts a separate Codex worker thread for a distinct user-facing task. Use this only for visible child work, not for internal delegation. If channel is omitted, use the current channel. Use mode='fresh' unless the child truly needs the parent thread context; use mode='fork' only when inheriting context is important.",
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
] as const;

export const adminDynamicTools = [
  workerDynamicTools[2],
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

export const slackUploadFilesArgsSchema = z.object({
  comment: z.string().min(1).optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    title: z.string().min(1).optional(),
  })).min(1),
});

export const workerDeveloperInstructions = [
  "You are operating inside Slack as one worker in a shared-bot system.",
  "Incoming human messages are prefixed with the Slack speaker name, for example 'alice: can you check this'. Treat that prefix as authoritative speaker identity.",
  "Use normal assistant messages to communicate substantive progress. Raw reasoning is not shown to the human.",
  "Use slack_spawn_worker only for distinct user-facing child tasks that should live as their own top-level Slack thread. Do not use it for internal subagents or minor follow-ups.",
  "Use slack_upload_files when you need to share one or more existing local files into the current Slack thread. Only upload files that materially help the user.",
  "If you create a child worker, it is fire-and-forget. Do not wait on the child unless the human explicitly asks you to.",
  "Keep progress clear and concise because the client streams your interleaved assistant messages into the Slack thread.",
].join("\n");

export const adminDeveloperInstructions = [
  "You are operating in the Slack DM admin surface for a trusted local Codex bridge.",
  "Bridge slash commands are intercepted before they reach you.",
  "Use slack_upload_files when you need to share one or more existing local files into this admin DM conversation.",
  "Use concise operational language suitable for an admin/operator chat.",
].join("\n");
