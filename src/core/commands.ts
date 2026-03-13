import type { ReasoningEffort } from "../types.js";

export type CommandName = "help" | "status" | "restart" | "model" | "effort" | "compact" | "recover";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  raw: string;
}

const COMMANDS = new Set<CommandName>(["help", "status", "restart", "model", "effort", "compact", "recover"]);

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
    lines.push("/restart <codex|bridge|both> - restart runtime components");
    lines.push("/model [id] - show or set global defaults for new workers");
    lines.push("/effort [level] - show or set global defaults for new workers");
    lines.push("/compact - compact the DM admin conversation");
    lines.push("/recover - recreate the backing Codex thread when runtime context is missing");
    return lines.join("\n");
  }
  lines.push("/help - show thread command help");
  lines.push("/model [id] - show or set model for this worker thread");
  lines.push("/effort [level] - show or set reasoning effort for this worker thread");
  lines.push("/compact - compact this worker thread when idle");
  lines.push("/recover - recreate the backing Codex thread if it is missing");
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
