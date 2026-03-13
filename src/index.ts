import { loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { SlackCodexWorkersService } from "./core/service.js";

const config = loadConfig();
const service = new SlackCodexWorkersService(config);
let shuttingDown = false;

async function main(): Promise<void> {
  registerSignalHandlers();
  await service.start();
}

function registerSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`received ${signal}, shutting down`);
    try {
      await service.stop();
    } catch (error) {
      logError("shutdown error", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logError("fatal startup error", error);
  process.exitCode = 1;
});
