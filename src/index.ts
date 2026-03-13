import { EXIT_CODE_RESTART, loadConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { SlackCodexWorkersService } from "./core/service.js";

const config = loadConfig();
const service = new SlackCodexWorkersService(config);
let shuttingDown = false;

async function main(): Promise<void> {
  registerSignalHandlers();
  registerRestartHandler();
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

function registerRestartHandler(): void {
  service.on("restartRequested", (target: string) => {
    void handleRestartRequest(target);
  });
}

async function handleRestartRequest(target: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`restart requested: ${target}`);
  try {
    await service.stop();
  } catch (error) {
    logError("restart shutdown error", error);
  } finally {
    process.exit(target === "bridge" || target === "both" ? EXIT_CODE_RESTART : 0);
  }
}

main().catch((error) => {
  logError("fatal startup error", error);
  process.exitCode = 1;
});
