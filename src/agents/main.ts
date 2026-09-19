import process from "node:process";
import { config as loadDotEnv } from "dotenv";
import { logError, logInfo } from "../logger.js";
import { AgentHub } from "./hub.js";
import { loadHubConfig } from "./hubConfig.js";
import { JevJudge, RuleJudge } from "./judge.js";

loadDotEnv({ quiet: true });

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) logInfo("TYPESAFE_API_KEY is not set; agents wake on plain rules (their name, a DM, a thread they are in)");
  const hub = new AgentHub(loadHubConfig(), apiKey ? new JevJudge({ apiKey, model: process.env.TYPESAFE_MODEL?.trim() || undefined }) : new RuleJudge());
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logInfo(`received ${signal}, shutting down`);
    // A harness that will not stop (a hung ssh session) must not keep the hub from exiting.
    const deadline = setTimeout(() => process.exit(0), 15_000);
    deadline.unref();
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    // Slack's socket client rejects this way when it gives up on a connection. Record why before the launcher restarts us.
    logError("unhandled rejection; exiting so the launcher can restart the hub", { reason: reason instanceof Error ? reason.message : String(reason) });
    process.exit(1);
  });
  await hub.start();
}

main().catch((error) => {
  logError("agent hub failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
