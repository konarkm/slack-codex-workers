// Live smoke test for CodexRuntime: wake, tool call, restart and resume (tools must survive the resume).
// Usage: tsx scripts/smoke/claudeRuntime.ts <cwd> [model] [ssh-target]
import { z } from "zod";
import { CodexRuntime } from "../../src/runtimes/codexRuntime.js";
import { DEFAULT_WAKE_POLICY, type AgentSpec, type AgentTool, type RuntimeEvents } from "../../src/agents/types.js";

const [cwd, model = "gpt-5.6-luna", sshTarget] = process.argv.slice(2);
if (!cwd) throw new Error("usage: codexRuntime.ts <cwd> [model] [ssh-target]");

const spec: AgentSpec = {
  name: "smoke",
  title: null,
  runtime: "codex",
  model,
  effort: null,
  host: sshTarget ? { kind: "ssh", target: sshTarget } : { kind: "local" },
  cwd,
  wake: DEFAULT_WAKE_POLICY,
  icon: null,
  instructionsPath: null,
  inheritUserConfig: false,
  // A smoke test gets no operator setup at all: its stub tools must be the only way out.
  denyTools: [],
};

const sent: string[] = [];
const tools: AgentTool[] = [
  {
    name: "send_message",
    description: "Send a message to a conversation. This is the only way anyone sees what you say.",
    shape: { conversation: z.string(), text: z.string() },
    handler: async (args) => {
      const { conversation, text } = args as { conversation: string; text: string };
      sent.push(`${conversation}: ${text}`);
      return "sent";
    },
  },
];

function makeRuntime(sessionId: string | null): { runtime: CodexRuntime; turnDone: () => Promise<void>; session: () => string | null } {
  let resolveTurn: (() => void) | null = null;
  let session = sessionId;
  const events: RuntimeEvents = {
    onSessionChanged: (id) => { session = id; console.log("session", id); },
    onStateChanged: (state) => console.log("state", state),
    onTurnCompleted: (event) => { console.log("turn", event.status, event.error ?? "", JSON.stringify(event.finalText.slice(0, 120))); resolveTurn?.(); },
    onActivity: (item) => console.log("activity", item.title),
    onCompaction: (event) => console.log("compaction", event.status),
    onProblem: (message) => console.log("problem", message),
  };
  const runtime = new CodexRuntime({
    spec,
    sessionId,
    instructions: "This is a test harness with no real chat system behind it. You are a teammate reached through chat. Nothing you write is seen unless you call send_message. Keep messages to one sentence.",
    tools,
    events,
  });
  return { runtime, turnDone: () => new Promise<void>((resolve) => { resolveTurn = resolve; }), session: () => session };
}

const first = makeRuntime(null);
let done = first.turnDone();
await first.runtime.deliver({ text: "While you were idle:\n[#ops] Priya: heads up, the deploy codeword this week is 'marmalade'.\n\nNew:\n[#general] Konark mentioned you: what's this week's deploy codeword? Reply in #general.", id: "in-1", imagePaths: [], priority: "next" });
await done;
await first.runtime.stop();

const second = makeRuntime(first.session());
done = second.turnDone();
await second.runtime.deliver({ text: "[DM] Konark: which channel did I ask you about the codeword in? Reply in DM.", id: "in-2", imagePaths: [], priority: "now" });
await done;
await second.runtime.stop();

console.log("SENT", JSON.stringify(sent, null, 2));
const ok = sent.some((line) => /marmalade/i.test(line)) && sent.some((line) => /general/i.test(line) && /^DM|dm/i.test(line.split(":")[0] ?? ""));
console.log(ok ? "SMOKE PASS" : "SMOKE CHECK MANUALLY");
process.exit(0);
