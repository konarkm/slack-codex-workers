import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSlackTools, type SlackToolContext } from "../agents/slackTools.js";
import type { SlackHistoryMessage } from "../slack/agentSlack.js";

const BOT = { teamId: "T1", teamName: "Team", botUserId: "UAPP", botId: "BAPP", appId: "A1" };

// Just the Slack calls the tools make, recorded.
class ToolSlack {
  calls: string[] = [];
  conversationFails = false;
  messages = new Map<string, SlackHistoryMessage>();
  uploadTs: string | null = null;
  identity() {
    return BOT;
  }
  async getConversation(channelId: string) {
    if (this.conversationFails) throw new Error("missing_scope");
    return { id: channelId, name: null, type: channelId.startsWith("D") ? "im" : "channel", isMember: true };
  }
  async getPerson(id: string) {
    return { id, name: id, isBot: false, title: null };
  }
  async lookupMessage(_channelId: string, ts: string) {
    return this.messages.get(ts) ?? null;
  }
  async readHistory() {
    this.calls.push("readHistory");
    return [{ ts: "5.2", threadTs: "5.1", userId: null, botId: "BAPP", username: "ada", text: "ada's private reply", replyCount: 0, fileNames: [] }];
  }
  async postMessage(args: { text: string }) {
    this.calls.push(`post ${args.text}`);
    return { ts: "9.9", permalink: null };
  }
  async addReaction(_channelId: string, ts: string) {
    this.calls.push(`react ${ts}`);
  }
  async updateMessage(_channelId: string, ts: string) {
    this.calls.push(`edit ${ts}`);
  }
  async deleteMessage(_channelId: string, ts: string) {
    this.calls.push(`delete ${ts}`);
  }
  async uploadFiles(_channelId: string, threadTs: string | null) {
    this.calls.push(`upload ${threadTs}`);
    return { ts: this.uploadTs };
  }
}

function botMessage(ts: string, username: string, threadTs: string | null = null): SlackHistoryMessage {
  return { ts, threadTs, userId: null, botId: "BAPP", username, text: "hi", replyCount: 0, fileNames: [] };
}

// Tools for cody, where the DM thread 5.1 is ada's session.
function toolsFor(slack: ToolSlack, overrides: Partial<SlackToolContext> = {}) {
  const sent: Array<{ channelId: string; threadTs: string | null; ts: string; text: string }> = [];
  const tools = buildSlackTools({
    slack: slack as never,
    persona: { username: "cody", icon: null },
    afterSend: (item) => sent.push(item),
    noteVisibleAction() {},
    recordThreadParticipation() {},
    uploadConfig: { slackUploadMaxFiles: 5, workspaceRoot: os.tmpdir(), attachmentStorageDir: os.tmpdir(), attachmentMaxBytes: 1024 * 1024 },
    timezone: "UTC",
    canUploadLocalFiles: true,
    latestActionToken: () => null,
    noteRead() {},
    dm: { ownerOf: (_channelId, threadTs) => (threadTs === "5.1" ? "ada" : null), claim() {}, sessions: () => [] },
    fetchFiles: async () => ({ imagePaths: [], fileNotes: [] }),
    markSession: async () => {},
    ...overrides,
  });
  const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.handler(args as never);
  return { run, sent };
}

describe("Slack tools in another agent's DM session", () => {
  it("refuse a known owner's session even when Slack cannot say what the conversation is", async () => {
    const slack = new ToolSlack();
    slack.conversationFails = true;
    const { run } = toolsFor(slack);
    expect(await run("read_history", { channel: "D1", thread_ts: "5.1" })).toContain("ada's session");
    expect(slack.calls).not.toContain("readHistory");
    // Without a thread, whether this is the DM decides what may be read; not knowing is an error, not "a channel".
    await expect(run("read_history", { channel: "D1" })).rejects.toThrow("missing_scope");
    expect(slack.calls).not.toContain("readHistory");
  });

  it("keep react, upload, edit, and delete out of it", async () => {
    const slack = new ToolSlack();
    slack.messages.set("5.2", botMessage("5.2", "ada", "5.1"));
    const { run } = toolsFor(slack);
    expect(await run("react", { channel: "D1", ts: "5.2", emoji: "eyes" })).toContain("ada's session");
    expect(await run("upload_files", { channel: "D1", thread_ts: "5.1", paths: ["nothing.txt"], comment: "here" })).toContain("ada's session");
    expect(await run("edit_message", { channel: "D1", ts: "5.2", text: "mine now" })).not.toBe("edited");
    expect(await run("delete_message", { channel: "D1", ts: "5.2" })).not.toBe("deleted");
    expect(slack.calls).toEqual([]);
  });
});

describe("edit_message and delete_message", () => {
  it("change only the calling agent's own messages", async () => {
    const slack = new ToolSlack();
    slack.messages.set("7.1", botMessage("7.1", "ada"));
    slack.messages.set("7.2", botMessage("7.2", "cody"));
    const { run } = toolsFor(slack);
    expect(await run("edit_message", { channel: "C1", ts: "7.1", text: "x" })).toContain("not yours");
    expect(await run("delete_message", { channel: "C1", ts: "7.1" })).toContain("not yours");
    expect(await run("edit_message", { channel: "C1", ts: "7.2", text: "x" })).toBe("edited");
    expect(await run("delete_message", { channel: "C1", ts: "7.2" })).toBe("deleted");
    expect(slack.calls).toEqual(["edit 7.2", "delete 7.2"]);
  });
});
