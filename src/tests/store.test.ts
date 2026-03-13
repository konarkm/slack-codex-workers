import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../db/store.js";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: Store; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-workers-store-"));
  tempDirs.push(dir);
  return {
    dir,
    store: new Store(path.join(dir, "test.db")),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("store", () => {
  it("clears nullable worker fields when explicitly set to null", async () => {
    const { store } = await createStore();
    store.upsertWorker({
      key: "worker-1",
      teamId: "T1",
      channelId: "C1",
      rootTs: "1.000",
      appThreadId: "thread-1",
      activeTurnId: "turn-1",
      ownerUserId: "U1",
      rootOwnerUserId: "U1",
      status: "running",
      currentAgentSlackTs: "2.000",
      currentAgentItemId: "item-1",
      currentWorklogSlackTs: "3.000",
      settings: { model: "gpt-5.4", effort: "high" },
      parentWorkerKey: null,
      lastError: "oops",
      lastInboundMessageTs: "4.000",
      pendingRequest: {
        kind: "tool_user_input",
        requestId: "req-1",
        promptText: "Need input",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questionIds: ["q1"],
        schemaJson: null,
        createdAt: new Date().toISOString(),
      },
    });

    store.updateWorkerState("worker-1", {
      activeTurnId: null,
      status: "idle",
      currentAgentSlackTs: null,
      currentAgentItemId: null,
      currentWorklogSlackTs: null,
      lastError: null,
      pendingRequest: null,
    });

    const worker = store.getWorkerByKey("worker-1");
    expect(worker?.activeTurnId).toBeNull();
    expect(worker?.currentAgentSlackTs).toBeNull();
    expect(worker?.currentAgentItemId).toBeNull();
    expect(worker?.currentWorklogSlackTs).toBeNull();
    expect(worker?.lastError).toBeNull();
    expect(worker?.pendingRequest).toBeNull();
    store.close();
  });

  it("replays only retryable inbound failures and refreshes payload on duplicate create", async () => {
    const { store } = await createStore();
    store.createOrGetInboundMessage({
      key: "msg-1",
      teamId: "T1",
      channelId: "C1",
      messageTs: "1.000",
      rootTs: "1.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "old" }),
    });
    store.markInboundMessageFailed("msg-1", "temporary");

    store.createOrGetInboundMessage({
      key: "msg-1",
      teamId: "T1",
      channelId: "C1",
      messageTs: "1.000",
      rootTs: "1.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "new" }),
    });

    store.createOrGetInboundMessage({
      key: "msg-2",
      teamId: "T1",
      channelId: "C1",
      messageTs: "2.000",
      rootTs: "2.000",
      kind: "thread-reply",
      payloadJson: JSON.stringify({ text: "reject" }),
    });
    store.markInboundMessageRejected("msg-2", "manual");

    const replayable = store.listReplayableInboundMessages();
    expect(replayable.map((record) => record.key)).toContain("msg-1");
    expect(replayable.map((record) => record.key)).not.toContain("msg-2");
    expect(store.getInboundMessage("msg-1")?.payloadJson).toContain("new");
    store.close();
  });
});
