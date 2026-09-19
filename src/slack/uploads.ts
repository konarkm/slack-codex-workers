import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UploadConfig } from "../settings.js";

export interface SlackUploadInput {
  path: string;
  title?: string;
}

export interface ValidatedSlackUploadFile {
  path: string;
  filename: string;
  title?: string;
  sizeBytes: number;
}

export async function validateSlackUploadFiles(
  files: SlackUploadInput[],
  config: UploadConfig,
): Promise<ValidatedSlackUploadFile[]> {
  if (files.length === 0) {
    throw new Error("At least one file is required.");
  }
  if (files.length > config.slackUploadMaxFiles) {
    throw new Error(`Upload supports at most ${config.slackUploadMaxFiles} files per call.`);
  }

  const allowedRoots = await Promise.all([
    normalizeRoot(config.workspaceRoot),
    normalizeRoot(config.attachmentStorageDir),
    normalizeRoot(os.tmpdir()),
  ]);

  const validated: ValidatedSlackUploadFile[] = [];
  for (const file of files) {
    const resolvedPath = path.isAbsolute(file.path)
      ? file.path
      : path.resolve(config.workspaceRoot, file.path);
    const realPath = await fs.realpath(resolvedPath).catch(() => null);
    if (!realPath) {
      throw new Error(`File does not exist: ${file.path}`);
    }
    if (!isUnderAnyRoot(realPath, allowedRoots)) {
      throw new Error(`File is outside allowed upload roots: ${file.path}`);
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${file.path}`);
    }
    if (stat.size > config.attachmentMaxBytes) {
      throw new Error(`${path.basename(realPath)} exceeds the per-file upload limit.`);
    }
    validated.push({
      path: realPath,
      filename: path.basename(realPath),
      title: file.title?.trim() || undefined,
      sizeBytes: stat.size,
    });
  }

  return validated;
}

async function normalizeRoot(rootPath: string): Promise<string> {
  const resolved = path.resolve(rootPath);
  return fs.realpath(resolved).catch(() => resolved);
}

function isUnderAnyRoot(candidatePath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
