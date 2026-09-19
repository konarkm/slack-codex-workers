import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import type { AgentHost } from "./types.js";

export interface HostSpawnRequest {
  host: AgentHost;
  command: string;
  args: string[];
  cwd: string;
  // Extra environment for the child. On ssh hosts only these are forwarded; the remote login shell supplies the rest.
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRemoteCommand(request: Pick<HostSpawnRequest, "command" | "args" | "cwd" | "env">): string {
  const assignments = Object.entries(request.env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const exec = ["exec", ...(assignments.length > 0 ? ["env", ...assignments] : []), shellQuote(request.command), ...request.args.map(shellQuote)];
  return `cd ${shellQuote(request.cwd)} && ${exec.join(" ")}`;
}

// Both agent harnesses speak over stdio, so running one on another machine is the same spawn behind ssh.
export function spawnOnHost(request: HostSpawnRequest): ChildProcessWithoutNullStreams {
  if (request.host.kind === "local") {
    return spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      signal: request.signal,
    });
  }
  // A login shell so the remote PATH and agent CLI logins resolve the way they do interactively.
  const remote = `exec "$SHELL" -lc ${shellQuote(buildRemoteCommand(request))}`;
  return spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", request.host.target, remote], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: request.signal,
  });
}
