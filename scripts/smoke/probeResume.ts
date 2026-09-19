// What does the SDK do when asked to resume a session whose transcript does not exist?
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

async function* input() {
  yield { type: "user" as const, message: { role: "user" as const, content: "Say OK." }, parent_tool_use_id: null, uuid: randomUUID(), origin: { kind: "human" as const } };
  await new Promise(() => {});
}
const q = query({ prompt: input(), options: { resume: randomUUID(), model: "claude-haiku-4-5-20251001", settingSources: [], cwd: "/tmp", stderr: (data) => console.log("STDERR:", data.trim().slice(0, 300)) } });
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 60_000);
try {
  for await (const message of q) {
    console.log("MSG", message.type, "subtype" in message ? message.subtype : "", message.type === "result" ? JSON.stringify(message).slice(0, 400) : "");
    if (message.type === "result") process.exit(0);
  }
  console.log("STREAM ENDED");
} catch (error) {
  console.log("THROWN:", error instanceof Error ? error.message.slice(0, 500) : String(error));
}
process.exit(0);
