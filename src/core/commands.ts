import type { ReasoningEffort } from "../types.js";

export type CommandName =
  | "help"
  | "status"
  | "health"
  | "restart"
  | "restart-now"
  | "restart-cancel"
  | "model"
  | "effort"
  | "compact"
  | "recover"
  | "stop"
  | "workstream-create";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  raw: string;
}

const COMMANDS = new Set<CommandName>([
  "help",
  "status",
  "health",
  "restart",
  "restart-now",
  "restart-cancel",
  "model",
  "effort",
  "compact",
  "recover",
  "stop",
  "workstream-create",
]);

export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  const [nameRaw = "", ...args] = body.split(/\s+/g);
  const name = nameRaw.toLowerCase() as CommandName;
  if (!COMMANDS.has(name)) return null;
  return { name, args, raw: input };
}

export function helpText(scope: "dm" | "thread"): string {
  const lines = ["Commands:"];
  if (scope === "dm") {
    lines.push("/help - show this help");
    lines.push("/status - show bridge status");
    lines.push("/health - show bridge diagnostics");
    lines.push("/restart <codex|bridge|both> - queue a restart until the runtime is idle");
    lines.push("/restart-now - force the currently queued restart immediately");
    lines.push("/restart-cancel - cancel the currently queued restart");
    lines.push("/model [id] - show or set the global default model for threads without overrides");
    lines.push("/effort [level] - show or set the global default effort for threads without overrides");
    lines.push("/compact - compact the DM admin conversation");
    lines.push("/stop - request interruption of the active DM admin turn");
    lines.push("/recover - recover this DM only when the backing Codex thread is missing or blocked");
    lines.push("/workstream-create <slug> [parent=<path>] [description...] - create a new workstream channel and scaffold");
    return lines.join("\n");
  }
  lines.push("/help - show thread command help");
  lines.push("/status - show this worker thread status");
  lines.push("/health - show this worker thread diagnostics");
  lines.push("/model [id] - show or set model for this worker thread");
  lines.push("/effort [level] - show or set reasoning effort for this worker thread");
  lines.push("/compact - compact this worker thread when idle");
  lines.push("/stop - request interruption of the active worker turn");
  lines.push("/recover - recover this thread only when the backing Codex thread is missing or blocked");
  lines.push("/workstream-create <slug> [parent=<path>] [description...] - create a new workstream with explicit user approval");
  return lines.join("\n");
}

export function normalizeEffort(value: string | undefined): ReasoningEffort | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "minimal"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
    ? normalized
    : null;
}
