import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { MessageAttachmentRecord, SlackAttachmentInput, SlackFileRef } from "../types.js";

const IMAGE_PREFIXES = ["image/"];

interface DownloadedAttachment {
  record: MessageAttachmentRecord;
  note: string;
}

export async function prepareSlackAttachments(
  messageKey: string,
  files: SlackFileRef[],
  existing: MessageAttachmentRecord[],
  botToken: string,
  config: AppConfig,
): Promise<SlackAttachmentInput> {
  await fsPromises.mkdir(config.attachmentStorageDir, { recursive: true });

  const attachmentRecords = new Map(existing.map((record) => [record.slackFileId, record]));
  let totalBytes = 0;
  const storedAttachments = new Map<string, MessageAttachmentRecord>();

  for (const existingRecord of existing) {
    if (existingRecord.status !== "ready") continue;
    try {
      const stat = await fsPromises.stat(existingRecord.localPath);
      totalBytes += stat.size;
      storedAttachments.set(existingRecord.slackFileId, existingRecord);
    } catch {
      attachmentRecords.delete(existingRecord.slackFileId);
    }
  }

  const downloads: DownloadedAttachment[] = [];
  for (const file of files) {
    const existingRecord = attachmentRecords.get(file.id);
    if (existingRecord && existingRecord.status === "ready") {
      continue;
    }
    const remainingBudget = config.attachmentTotalMaxBytes === null
      ? Number.POSITIVE_INFINITY
      : Math.max(config.attachmentTotalMaxBytes - totalBytes, 0);
    const download = await downloadSlackAttachment(messageKey, file, botToken, config, remainingBudget);
    downloads.push(download);
    if (download.record.sizeBytes) {
      totalBytes += download.record.sizeBytes;
    }
    storedAttachments.set(download.record.slackFileId, download.record);
  }

  const imagePaths: string[] = [];
  const fileNotes: string[] = [];
  const orderedAttachments = [...storedAttachments.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const record of orderedAttachments) {
    if (record.status !== "ready") {
      fileNotes.push(record.note ?? `${record.name} (download failed)`);
      continue;
    }
    if (record.isImage) {
      imagePaths.push(record.localPath);
    } else {
      fileNotes.push(`${record.name} at ${record.localPath}`);
    }
  }

  return {
    imagePaths,
    fileNotes,
    storedAttachments: orderedAttachments,
  };
}

async function downloadSlackAttachment(
  messageKey: string,
  file: SlackFileRef,
  botToken: string,
  config: AppConfig,
  remainingBudget: number,
): Promise<DownloadedAttachment> {
  const safeName = `${Date.now()}-${sanitizeFileName(file.name)}`;
  const filePath = path.join(config.attachmentStorageDir, safeName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.attachmentDownloadTimeoutMs);
  const isImage = IMAGE_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix));
  const recordKey = `${messageKey}:${file.id}`;

  try {
    const response = await fetch(file.urlPrivateDownload, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      return {
        record: buildAttachmentRecord(recordKey, messageKey, file, filePath, isImage, null, "failed", `${file.name} (download failed: ${response.status})`),
        note: `${file.name} (download failed: ${response.status})`,
      };
    }

    const contentLengthHeader = response.headers.get("content-length");
    const declaredBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
    if (declaredBytes !== null && Number.isFinite(declaredBytes)) {
      if (declaredBytes > config.attachmentMaxBytes) {
        return {
          record: buildAttachmentRecord(recordKey, messageKey, file, filePath, isImage, declaredBytes, "failed", `${file.name} exceeds per-file limit`),
          note: `${file.name} exceeds the per-file attachment limit`,
        };
      }
      if (Number.isFinite(remainingBudget) && declaredBytes > remainingBudget) {
        return {
          record: buildAttachmentRecord(recordKey, messageKey, file, filePath, isImage, declaredBytes, "failed", `${file.name} exceeds remaining attachment budget`),
          note: `${file.name} exceeds the total attachment budget for this message`,
        };
      }
    }

    let writtenBytes = 0;
    const fileHandle = await fsPromises.open(filePath, "w");
    try {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        writtenBytes += value.byteLength;
        if (writtenBytes > config.attachmentMaxBytes || (Number.isFinite(remainingBudget) && writtenBytes > remainingBudget)) {
          controller.abort();
          throw new Error("attachment exceeds configured limits");
        }
        await fileHandle.write(value);
      }
    } finally {
      await fileHandle.close();
    }

    return {
      record: buildAttachmentRecord(recordKey, messageKey, file, filePath, isImage, writtenBytes, "ready", null),
      note: isImage ? file.name : `${file.name} at ${filePath}`,
    };
  } catch (error) {
    await fsPromises.rm(filePath, { force: true }).catch(() => undefined);
    const note = error instanceof Error && error.name === "AbortError"
      ? `${file.name} exceeded attachment limits or timed out`
      : `${file.name} download failed`;
    return {
      record: buildAttachmentRecord(recordKey, messageKey, file, filePath, isImage, null, "failed", note),
      note,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildAttachmentRecord(
  key: string,
  messageKey: string,
  file: SlackFileRef,
  localPath: string,
  isImage: boolean,
  sizeBytes: number | null,
  status: "ready" | "failed",
  note: string | null,
): MessageAttachmentRecord {
  const now = new Date().toISOString();
  return {
    key,
    messageKey,
    slackFileId: file.id,
    name: file.name,
    mimetype: file.mimetype,
    localPath,
    isImage,
    sizeBytes,
    status,
    note,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
