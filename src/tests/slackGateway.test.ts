import { describe, expect, it, vi } from "vitest";
import { SlackGateway } from "../slack/slackGateway.js";
import type { AppConfig } from "../config.js";

const uploadV2Mock = vi.hoisted(() => vi.fn());

vi.mock("@slack/bolt", () => ({
  App: class {
    public client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "B1", team_id: "T1" }) },
      users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: "mock-user" } } }) },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.000" }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        uploadV2: uploadV2Mock,
      },
      conversations: {
        join: vi.fn().mockResolvedValue({ ok: true }),
        create: vi.fn().mockResolvedValue({ channel: { id: "C-created", name: "created", is_private: false, is_member: true } }),
        archive: vi.fn().mockResolvedValue({ ok: true }),
        open: vi.fn().mockResolvedValue({ channel: { id: "D-opened" } }),
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
      },
    };

    public start = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
  },
}));

function makeConfig(): AppConfig {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "unused",
    codexBin: "codex",
    workspaceRoot: "/tmp",
    databasePath: "/tmp/test.db",
    adminUserIds: ["U-admin"],
    allowedTeamId: null,
    messageEditThrottleMs: 1,
    appPort: 3013,
    supervisorRestartEnabled: false,
    launchMode: "dev",
    attachmentStorageDir: "/tmp/attachments",
    attachmentMaxBytes: 1024 * 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 600_000,
    attachmentRetentionMs: null,
    slackUploadTimeoutMs: 600_000,
    slackUploadMaxFiles: 10,
    showSlackWorklog: false,
    workspaceTimezone: "America/Los_Angeles",
    webhookPort: 3014,
    webhookBindHost: "127.0.0.1",
    webhookPath: "/webhooks",
    webhookBodyMaxBytes: 256 * 1024,
    webhookBodyReadTimeoutMs: 30_000,
    webhookPayloadStorageDir: "/tmp/webhooks",
    webhookSharedSecret: "secret-shared",
    webhookPreviousSharedSecret: "secret-previous",
    webhookPublicBaseUrl: "https://hooks.example.test",
    webhookTrustLoopbackProxy: false,
  };
}

describe("SlackGateway uploadFilesToConversation", () => {
  it("flattens nested uploadV2 completion responses for multi-file uploads", async () => {
    uploadV2Mock.mockResolvedValueOnce({
      ok: true,
      files: [
        {
          ok: true,
          files: [
            { id: "F1", title: "Corso di Lingua prices.pdf", name: "Corso di Lingua prices.pdf", permalink: "https://files.example/F1" },
            { id: "F2", title: "Estate INPSieme prices.pdf", name: "Estate INPSieme prices.pdf", permalink: "https://files.example/F2" },
          ],
        },
      ],
    });

    const gateway = new SlackGateway(makeConfig());
    const uploaded = await gateway.uploadFilesToConversation("C1", "1.000", [
      { path: "/tmp/corso.pdf", filename: "Corso di Lingua prices.pdf", title: "Corso di Lingua prices.pdf", sizeBytes: 100 },
      { path: "/tmp/estate.pdf", filename: "Estate INPSieme prices.pdf", title: "Estate INPSieme prices.pdf", sizeBytes: 100 },
    ]);

    expect(uploaded).toEqual([
      {
        id: "F1",
        name: "Corso di Lingua prices.pdf",
        title: "Corso di Lingua prices.pdf",
        permalink: "https://files.example/F1",
      },
      {
        id: "F2",
        name: "Estate INPSieme prices.pdf",
        title: "Estate INPSieme prices.pdf",
        permalink: "https://files.example/F2",
      },
    ]);
  });
});
