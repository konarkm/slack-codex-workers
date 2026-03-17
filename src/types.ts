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

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RuntimeSettings {
  model: string | null;
  effort: ReasoningEffort | null;
}

export interface WorkerIdentity {
  username: string;
  iconEmoji: string;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "recovery_required"
  | "blocked_input"
  | "blocked_running_turn";

export type InboundMessageKind = "channel-root" | "thread-reply" | "dm-message";
export type InboundMessageStatus = "received" | "processing" | "processed" | "failed";
export type PendingRequestKind = "tool_user_input" | "mcp_elicitation";

export interface PendingRequestState {
  kind: PendingRequestKind;
  requestId: string | null;
  promptText: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  questionIds: string[];
  schemaJson: string | null;
  createdAt: string;
}

export interface WorkerRecord {
  key: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  workstreamId: string | null;
  appThreadId: string;
  activeTurnId: string | null;
  ownerUserId: string;
  rootOwnerUserId: string;
  status: SessionStatus;
  currentAgentSlackTs: string | null;
  currentAgentItemId: string | null;
  currentWorklogSlackTs: string | null;
  settings: RuntimeSettings;
  identity: WorkerIdentity | null;
  parentWorkerKey: string | null;
  requestItemId: string | null;
  requestItemPath: string | null;
  lastError: string | null;
  lastInboundMessageTs: string | null;
  pendingRequest: PendingRequestState | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkstreamRecord {
  id: string;
  teamId: string;
  parentId: string | null;
  slug: string;
  relativePath: string;
  channelId: string;
  channelName: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingWorkerShellSource {
  sourceKind: string;
  sourceSummary: string;
  sourceSlackChannelId?: string | null;
  sourceSlackMessageTs?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
}

export interface PendingWorkerShellRecord {
  id: string;
  teamId: string;
  workstreamId: string;
  channelId: string;
  rootTs: string | null;
  title: string;
  requestItemId: string | null;
  requestItemPath: string | null;
  ownerUserId: string;
  rootOwnerUserId: string;
  settings: RuntimeSettings;
  identity: WorkerIdentity | null;
  parentWorkerKey: string | null;
  source: PendingWorkerShellSource;
  status: "pending" | "slack_created" | "thread_created" | "ready_to_start" | "failed";
  appThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DmSessionRecord {
  teamId: string;
  userId: string;
  channelId: string;
  appThreadId: string | null;
  activeTurnId: string | null;
  status: SessionStatus;
  currentAgentSlackTs: string | null;
  currentAgentItemId: string | null;
  currentWorklogSlackTs: string | null;
  settings: RuntimeSettings;
  lastError: string | null;
  lastInboundMessageTs: string | null;
  pendingRequest: PendingRequestState | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDefaults {
  model: string | null;
  effort: ReasoningEffort | null;
}

export type RestartTarget = "codex" | "bridge" | "both";

export interface PendingRestartRecord {
  target: RestartTarget;
  teamId: string;
  userId: string;
  channelId: string;
  requestedAt: string;
}

export interface ChannelRecord {
  teamId: string;
  channelId: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  updatedAt: string;
}

export interface SlackAttachmentInput {
  imagePaths: string[];
  fileNotes: string[];
  storedAttachments: MessageAttachmentRecord[];
}

export interface TurnInput {
  text: string;
  imagePaths?: string[];
}

export interface SlackMessageContext {
  teamId: string;
  channelId: string;
  channelName?: string | null;
  channelType: string | null;
  userId: string;
  username: string;
  text: string;
  ts: string;
  threadTs: string | null;
  isDm: boolean;
  files: SlackFileRef[];
}

export interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload: string;
}

export interface WorklogItem {
  itemId: string;
  type: string;
  title: string;
  status: "started" | "completed" | "failed";
  detail?: string | null;
}

export interface InboundMessageRecord {
  key: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  rootTs: string;
  kind: InboundMessageKind;
  payloadJson: string;
  status: InboundMessageStatus;
  attempts: number;
  retryable: boolean;
  lastError: string | null;
  workerKey: string | null;
  appThreadId: string | null;
  turnId: string | null;
  createdAt: string;
  updatedAt: string;
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
