import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSlackAttachments } from "../slack/attachments.js";

const dirs: string[] = [];

async function config(overrides: Partial<{ attachmentMaxBytes: number }> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attachments-test-"));
  dirs.push(dir);
  return { attachmentStorageDir: dir, attachmentMaxBytes: 1024, attachmentTotalMaxBytes: null, attachmentDownloadTimeoutMs: 5_000, ...overrides };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function file(id: string) {
  return { id, name: "report.txt", mimetype: "text/plain", urlPrivateDownload: `https://files.example/${id}` };
}

describe("prepareSlackAttachments", () => {
  it("gives two same-named files downloaded in the same millisecond their own paths", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: string) => new Response(`content of ${url.split("/").pop()}`));
    const settings = await config();
    const [first, second] = await Promise.all([
      prepareSlackAttachments("slack:C1:1.1", [file("F1")], [], "xoxb-test", settings),
      prepareSlackAttachments("slack:C1:2.2", [file("F2")], [], "xoxb-test", settings),
    ]);
    const firstPath = first.storedAttachments[0]!.localPath;
    const secondPath = second.storedAttachments[0]!.localPath;
    expect(firstPath).not.toBe(secondPath);
    expect(await fs.readFile(firstPath, "utf8")).toBe("content of F1");
    expect(await fs.readFile(secondPath, "utf8")).toBe("content of F2");
  });
});
