import process from "node:process";
import { config as loadDotEnv } from "dotenv";
import { logError, logInfo } from "../logger.js";
import { AgentHub } from "./hub.js";
import { loadHubConfig } from "./hubConfig.js";

loadDotEnv({ quiet: true });

async function main(): Promise<void> {
  const hub = new AgentHub(loadHubConfig());
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logInfo(`received ${signal}, shutting down`);
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await hub.start();
}

main().catch((error) => {
  logError("agent hub failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
