export function logInfo(message: string, data?: unknown): void {
  log("INFO", message, data);
}

export function logWarn(message: string, data?: unknown): void {
  log("WARN", message, data);
}

export function logError(message: string, data?: unknown): void {
  log("ERROR", message, data);
}

function log(level: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${timestamp}] ${level} ${message}`);
    return;
  }
  console.log(`[${timestamp}] ${level} ${message}`, data);
}
