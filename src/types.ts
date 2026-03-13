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

export interface WorkerRecord {
  key: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  appThreadId: string;
  activeTurnId: string | null;
  ownerUserId: string;
  rootOwnerUserId: string;
  status: string;
  currentAgentSlackTs: string | null;
  currentAgentItemId: string | null;
  currentWorklogSlackTs: string | null;
  settings: RuntimeSettings;
  parentWorkerKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DmSessionRecord {
  teamId: string;
  userId: string;
  channelId: string;
  appThreadId: string | null;
  activeTurnId: string | null;
  currentAgentSlackTs: string | null;
  currentAgentItemId: string | null;
  currentWorklogSlackTs: string | null;
  settings: RuntimeSettings;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDefaults {
  model: string | null;
  effort: ReasoningEffort | null;
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
}

export interface TurnInput {
  text: string;
  imagePaths?: string[];
}

export interface SlackMessageContext {
  teamId: string;
  channelId: string;
  channelName?: string | null;
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
