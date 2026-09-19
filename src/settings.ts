// Settings shared by the file and webhook helpers.

export interface AttachmentConfig {
  attachmentStorageDir: string;
  attachmentMaxBytes: number;
  attachmentTotalMaxBytes: number | null;
  attachmentDownloadTimeoutMs: number;
}

export interface UploadConfig {
  slackUploadMaxFiles: number;
  // Relative upload paths resolve against this directory.
  workspaceRoot: string;
  attachmentStorageDir: string;
  attachmentMaxBytes: number;
}

export interface WebhookServerConfig {
  webhookPort: number;
  webhookBindHost: string;
  webhookPath: string;
  webhookTrustLoopbackProxy: boolean;
  webhookBodyMaxBytes: number;
  webhookBodyReadTimeoutMs: number;
}
