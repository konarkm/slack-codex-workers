export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcIncoming = JsonRpcRequest | JsonRpcResponse;

export interface WebhookSourceRecord {
  id: string;
  teamId: string;
  source: string;
  routeToken: string;
  handlerPath: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSourceContext {
  source: WebhookSourceRecord;
  method: string;
  url: string;
  routePath: string;
  receivedAt: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedJson: unknown | null;
  remoteAddress: string | null;
}

export interface NormalizedWebhookEventInput {
  event: string;
  dedupeKey: string;
  fields?: Record<string, string> | null;
  payload?: unknown;
  summary?: string | null;
}

export type WebhookHandlerResult =
  | {
      outcome: "events";
      events: NormalizedWebhookEventInput[];
    }
  | {
      outcome: "noop";
      reason?: string | null;
    }
  | {
      outcome: "reject";
      error: string;
      status?: 400 | 401 | 403;
    };

export interface SlackAttachmentInput {
  imagePaths: string[];
  fileNotes: string[];
  storedAttachments: MessageAttachmentRecord[];
}

export interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload: string;
}

export interface MessageAttachmentRecord {
  key: string;
  messageKey: string;
  slackFileId: string;
  name: string;
  mimetype: string;
  localPath: string;
  isImage: boolean;
  sizeBytes: number | null;
  status: "ready" | "failed";
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
