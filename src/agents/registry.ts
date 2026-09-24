import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_DENY_TOOLS, DEFAULT_MODELS, DEFAULT_WAKE_POLICY, type AgentHost, type AgentSpec, type RuntimeKind } from "./types.js";

export const agentNamePattern = /^[a-z][a-z0-9-]{0,31}$/;

const agentSchema = z.object({
  name: z.string().regex(agentNamePattern, "agent names are lowercase letters, digits, and hyphens"),
  title: z.string().min(1).optional(),
  // Emoji name such as ":brain:", or an image URL.
  icon: z.string().min(1).optional(),
  runtime: z.enum(["claude", "codex"]),
  // Omitted: the runtime's default from the file's `defaults`, else DEFAULT_MODELS.
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  // "local", or "ssh:<target>" where target is anything `ssh` accepts (a tailnet host, user@host, a config alias).
  host: z.string().regex(/^(local|ssh:.+)$/).default("local"),
  cwd: z.string().min(1).optional(),
  wake: z.object({ natural: z.boolean().optional(), threshold: z.number().min(0).max(1).optional() }).optional(),
  instructions: z.string().min(1).optional(),
  inheritUserConfig: z.boolean().default(false),
  denyTools: z.array(z.string().min(1)).optional(),
  createdBy: z.string().min(1).optional(),
  retired: z.boolean().optional(),
  retiredReason: z.string().optional(),
});

const registrySchema = z.object({
  // The one Slack app every agent speaks through. Values are names of environment variables.
  slack: z
    .object({ botTokenEnv: z.string().min(1).default("SLACK_BOT_TOKEN"), appTokenEnv: z.string().min(1).default("SLACK_APP_TOKEN") })
    .default({ botTokenEnv: "SLACK_BOT_TOKEN", appTokenEnv: "SLACK_APP_TOKEN" }),
  // Who answers a direct message that is not clearly for anyone. Defaults to the first agent.
  defaultAgent: z.string().min(1).optional(),
  // The model and effort an agent gets when its own entry names none, per runtime.
  defaults: z
    .object({
      claude: z.object({ model: z.string().min(1).optional(), effort: z.string().min(1).optional() }).optional(),
      codex: z.object({ model: z.string().min(1).optional(), effort: z.string().min(1).optional() }).optional(),
    })
    .optional(),
  agents: z.array(agentSchema),
});

export type AgentConfigEntry = z.input<typeof agentSchema>;
type RegistryFile = z.infer<typeof registrySchema>;
type RuntimeDefaults = NonNullable<RegistryFile["defaults"]>;

function parseHost(value: string): AgentHost {
  return value === "local" ? { kind: "local" } : { kind: "ssh", target: value.slice("ssh:".length) };
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function toSpec(entry: RegistryFile["agents"][number], agentsRoot: string, defaults: RuntimeDefaults = {}): AgentSpec {
  const runtimeDefaults = defaults[entry.runtime as RuntimeKind];
  const host = parseHost(entry.host);
  if (host.kind === "ssh" && !entry.cwd) throw new Error(`Agent ${entry.name} runs over ssh and needs an explicit cwd on that host`);
  // A remote cwd is a path on the remote machine; leave it for that machine's shell to interpret.
  const cwd = host.kind === "ssh" ? entry.cwd! : path.resolve(expandHome(entry.cwd ?? path.join(agentsRoot, entry.name)));
  return {
    name: entry.name,
    title: entry.title ?? null,
    icon: entry.icon ?? null,
    runtime: entry.runtime,
    model: entry.model ?? runtimeDefaults?.model ?? DEFAULT_MODELS[entry.runtime],
    effort: entry.effort ?? runtimeDefaults?.effort ?? null,
    host,
    cwd,
    wake: { ...DEFAULT_WAKE_POLICY, ...entry.wake },
    instructionsPath: entry.instructions ? path.resolve(expandHome(entry.instructions)) : null,
    inheritUserConfig: entry.inheritUserConfig,
    denyTools: entry.denyTools ?? DEFAULT_DENY_TOOLS,
    retired: entry.retired ?? false,
  };
}

// The agents of one workspace. The file is the source of truth, so an agent created at runtime survives a restart.
export class AgentRegistry {
  private file: RegistryFile;

  constructor(
    private readonly filePath: string,
    // Holds each local agent's home directory (agentsRoot/<name>) unless the entry sets its own cwd.
    private readonly agentsRoot: string,
  ) {
    if (!fs.existsSync(filePath)) throw new Error(`Agent registry not found: ${filePath}`);
    this.file = registrySchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const seen = new Set<string>();
    for (const entry of this.file.agents) {
      if (seen.has(entry.name)) throw new Error(`Duplicate agent name: ${entry.name}`);
      seen.add(entry.name);
    }
  }

  slackEnv(): { botTokenEnv: string; appTokenEnv: string } {
    return this.file.slack;
  }

  specs(): AgentSpec[] {
    return this.file.agents.map((entry) => toSpec(entry, this.agentsRoot, this.file.defaults));
  }

  defaultAgent(): string | null {
    const named = this.file.defaultAgent;
    if (named && this.file.agents.some((entry) => entry.name === named && !entry.retired)) return named;
    return this.file.agents.find((entry) => !entry.retired)?.name ?? null;
  }

  has(name: string): boolean {
    return this.file.agents.some((entry) => entry.name === name);
  }

  spec(name: string): AgentSpec | null {
    const entry = this.file.agents.find((candidate) => candidate.name === name);
    return entry ? toSpec(entry, this.agentsRoot, this.file.defaults) : null;
  }

  // Changes what an agent is: its role, instructions, model, icon. Instructions given as text replace the agent's own file.
  update(name: string, patch: { title?: string; model?: string | null; effort?: string | null; icon?: string; retired?: boolean; retiredReason?: string }, instructionsText?: string): AgentSpec {
    const entry = this.file.agents.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`No agent named ${name}.`);
    if (patch.title !== undefined) entry.title = patch.title;
    if (patch.icon !== undefined) entry.icon = patch.icon;
    if (patch.model !== undefined) entry.model = patch.model ?? undefined;
    if (patch.effort !== undefined) entry.effort = patch.effort ?? undefined;
    if (patch.retired !== undefined) {
      entry.retired = patch.retired;
      entry.retiredReason = patch.retired ? patch.retiredReason : undefined;
    }
    if (instructionsText?.trim()) {
      const instructionsPath = entry.instructions ? path.resolve(expandHome(entry.instructions)) : path.join(this.agentsRoot, entry.name, "AGENT.md");
      fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
      fs.writeFileSync(instructionsPath, `${instructionsText.trim()}\n`);
      entry.instructions = instructionsPath;
    }
    this.write();
    return toSpec(entry, this.agentsRoot, this.file.defaults);
  }

  // Removes an agent from the roster. Its home directory is the caller's to deal with.
  remove(name: string): AgentSpec {
    const index = this.file.agents.findIndex((candidate) => candidate.name === name);
    if (index < 0) throw new Error(`No agent named ${name}.`);
    const [entry] = this.file.agents.splice(index, 1);
    if (this.file.defaultAgent === name) this.file.defaultAgent = undefined;
    this.write();
    return toSpec(entry!, this.agentsRoot, this.file.defaults);
  }

  private write(): void {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.file, null, 2)}\n`);
    fs.renameSync(temporary, this.filePath);
  }

  // Adds an agent and writes the file. Instructions given as text are saved in the agent's home.
  add(entry: AgentConfigEntry, instructionsText?: string): AgentSpec {
    const parsed = agentSchema.parse(entry);
    if (this.has(parsed.name)) throw new Error(`An agent named ${parsed.name} already exists.`);
    if (instructionsText?.trim()) {
      const instructionsPath = path.join(this.agentsRoot, parsed.name, "AGENT.md");
      fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
      fs.writeFileSync(instructionsPath, `${instructionsText.trim()}\n`);
      parsed.instructions = instructionsPath;
    }
    const spec = toSpec(parsed, this.agentsRoot, this.file.defaults);
    this.file.agents.push(parsed);
    this.write();
    return spec;
  }
}
