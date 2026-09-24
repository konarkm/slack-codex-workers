import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexRpcClient } from "../codex/rpcClient.js";

// Answers initialize, then closes its input pipe once told it is initialized, and stays alive.
const CLOSES_STDIN = `
const fs = require("node:fs");
let received = "";
process.stdin.on("error", () => {});
process.stdin.on("data", (chunk) => {
  received += chunk;
  for (const line of received.split("\\n").slice(0, -1)) {
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    if (message.method === "initialized") {
      process.stdin.pause();
      fs.closeSync(0);
      process.stderr.write("stdin closed\\n");
    }
  }
  received = received.slice(received.lastIndexOf("\\n") + 1);
});
setTimeout(() => {}, 5000);
`;

describe("CodexRpcClient", () => {
  it("fails the request, instead of crashing the process, when the app-server's input pipe breaks while it is still alive", async () => {
    const client = new CodexRpcClient("node", process.cwd(), { name: "t", title: "t", version: "0" }, () =>
      spawn(process.execPath, ["-e", CLOSES_STDIN], { stdio: ["pipe", "pipe", "pipe"] }),
    );
    const closed = new Promise<void>((resolve) => client.on("stderr", (chunk: string) => chunk.includes("stdin closed") && resolve()));
    const exited = new Promise<void>((resolve) => client.on("exit", () => resolve()));
    await client.start();
    await closed;
    await expect(client.request("thread/start", {})).rejects.toThrow(/EPIPE|not running/);
    await exited;
    expect(client.isRunning()).toBe(false);
  });
});
