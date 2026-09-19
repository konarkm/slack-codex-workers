import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_DENY_TOOLS, DEFAULT_WAKE_POLICY, type AgentHost, type AgentSpec } from "./types.js";

const agentNamePattern = /^[a-z][a-z0-9-]{0,31}$/;

const agentSchema = z.object({
  name: z.string().regex(agentNamePattern, "agent names are lowercase letters, digits, and hyphens"),
  title: z.string().min(1).optional(),
  runtime: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  // "local", or "ssh:<target>" where target is anything `ssh` accepts (a tailnet host, user@host, a config alias).
  host: z.string().regex(/^(local|ssh:.+)$/).default("local"),
  cwd: z.string().min(1).optional(),
  wake: z
    .object({
      mentions: z.boolean().optional(),
      directMessages: z.boolean().optional(),
      participatingThreads: z.boolean().optional(),
      ambient: z.boolean().optional(),
    })
    .optional(),
  slackBotTokenEnv: z.string().min(1).optional(),
  slackAppTokenEnv: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  inheritUserConfig: z.boolean().default(true),
  denyTools: z.array(z.string().min(1)).optional(),
});

const registrySchema = z.object({ agents: z.array(agentSchema) });

export type AgentConfigEntry = z.input<typeof agentSchema>;

export function envSuffix(name: string): string {
  return name.toUpperCase().replaceAll("-", "_");
}

function parseHost(value: string): AgentHost {
  return value === "local" ? { kind: "local" } : { kind: "ssh", target: value.slice("ssh:".length) };
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

// agentsRoot holds each local agent's home directory (agentsRoot/<name>) unless the entry sets its own cwd.
export function parseAgentRegistry(raw: unknown, agentsRoot: string): AgentSpec[] {
  const parsed = registrySchema.parse(raw);
  const seen = new Set<string>();
  return parsed.agents.map((entry) => {
    if (seen.has(entry.name)) throw new Error(`Duplicate agent name: ${entry.name}`);
    seen.add(entry.name);
    const host = parseHost(entry.host);
    if (host.kind === "ssh" && !entry.cwd) throw new Error(`Agent ${entry.name} runs over ssh and needs an explicit cwd on that host`);
    // A remote cwd is a path on the remote machine; leave it for that machine's shell to interpret.
    const cwd = host.kind === "ssh" ? entry.cwd! : path.resolve(expandHome(entry.cwd ?? path.join(agentsRoot, entry.name)));
    return {
      name: entry.name,
      title: entry.title ?? null,
      runtime: entry.runtime,
      model: entry.model ?? null,
      effort: entry.effort ?? null,
      host,
      cwd,
      wake: { ...DEFAULT_WAKE_POLICY, ...entry.wake },
      slackBotTokenEnv: entry.slackBotTokenEnv ?? `SLACK_BOT_TOKEN_${envSuffix(entry.name)}`,
      slackAppTokenEnv: entry.slackAppTokenEnv ?? `SLACK_APP_TOKEN_${envSuffix(entry.name)}`,
      instructionsPath: entry.instructions ? path.resolve(expandHome(entry.instructions)) : null,
      inheritUserConfig: entry.inheritUserConfig,
      denyTools: entry.denyTools ?? DEFAULT_DENY_TOOLS,
    };
  });
}

export function loadAgentRegistry(filePath: string, agentsRoot: string): AgentSpec[] {
  if (!fs.existsSync(filePath)) throw new Error(`Agent registry not found: ${filePath}`);
  return parseAgentRegistry(JSON.parse(fs.readFileSync(filePath, "utf8")), agentsRoot);
}
