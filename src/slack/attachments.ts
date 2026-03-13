import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlackAttachmentInput, SlackFileRef } from "../types.js";

const IMAGE_PREFIXES = ["image/"];

export async function prepareSlackAttachments(
  files: SlackFileRef[],
  botToken: string,
): Promise<SlackAttachmentInput> {
  const tempDir = path.join(os.tmpdir(), "slack-codex-workers");
  await fs.mkdir(tempDir, { recursive: true });

  const imagePaths: string[] = [];
  const fileNotes: string[] = [];

  for (const file of files) {
    const response = await fetch(file.urlPrivateDownload, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });
    if (!response.ok) {
      fileNotes.push(`${file.name} (download failed: ${response.status})`);
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const safeName = `${Date.now()}-${sanitizeFileName(file.name)}`;
    const filePath = path.join(tempDir, safeName);
    await fs.writeFile(filePath, bytes);

    if (IMAGE_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix))) {
      imagePaths.push(filePath);
    } else {
      fileNotes.push(`${file.name} at ${filePath}`);
    }
  }

  return { imagePaths, fileNotes };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
