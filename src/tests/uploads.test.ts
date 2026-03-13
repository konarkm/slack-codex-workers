import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { validateSlackUploadFiles } from "../slack/uploads.js";

const tempDirs: string[] = [];

function makeConfig(dir: string): AppConfig {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "unused",
    codexBin: "codex",
    codexCwd: dir,
    databasePath: path.join(dir, "test.db"),
    adminUserIds: ["U-admin"],
    allowedTeamId: null,
    messageEditThrottleMs: 1,
    appPort: 3013,
    supervisorRestartEnabled: false,
    launchMode: "dev",
    attachmentStorageDir: path.join(dir, "attachments"),
    attachmentMaxBytes: 1024 * 1024 * 1024,
    attachmentTotalMaxBytes: null,
    attachmentDownloadTimeoutMs: 600_000,
    attachmentRetentionMs: null,
    slackUploadTimeoutMs: 600_000,
    slackUploadMaxFiles: 10,
  };
}

async function createDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-upload-test-"));
  tempDirs.push(dir);
  return dir;
}

async function createOutsideDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.homedir(), "slack-upload-outside-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("validateSlackUploadFiles", () => {
  it("accepts relative paths under CODEX_CWD", async () => {
    const dir = await createDir();
    const config = makeConfig(dir);
    const artifactPath = path.join(dir, "artifact.txt");
    await fs.writeFile(artifactPath, "hello");
    const realArtifactPath = await fs.realpath(artifactPath);

    const result = await validateSlackUploadFiles([{ path: "artifact.txt", title: "Artifact" }], config);
    expect(result).toEqual([
      expect.objectContaining({ path: realArtifactPath, filename: "artifact.txt", title: "Artifact" }),
    ]);
  });

  it("rejects paths outside allowed roots", async () => {
    const dir = await createDir();
    const config = makeConfig(dir);
    const outsideDir = await createOutsideDir();
    const outsidePath = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsidePath, "nope");

    await expect(validateSlackUploadFiles([{ path: outsidePath }], config)).rejects.toThrow("outside allowed upload roots");
  });

  it("rejects too many files", async () => {
    const dir = await createDir();
    const config = makeConfig(dir);
    const files = Array.from({ length: 11 }, (_, index) => ({ path: `file-${index}.txt` }));

    await expect(validateSlackUploadFiles(files, config)).rejects.toThrow("at most 10 files");
  });
});
