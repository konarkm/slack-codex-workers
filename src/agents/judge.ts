import { logWarn } from "../logger.js";

export interface JudgeAgent {
  name: string;
  role: string | null;
  // The agent has already spoken in this thread or DM.
  inThisConversation: boolean;
  // The agent is in the middle of a turn right now.
  working: boolean;
}

export interface JudgeMessage {
  // Display name plus kind, e.g. "Konark (human)" or "cody (agent)".
  from: string;
  text: string;
}

export interface JudgeInput {
  conversation: { kind: "channel" | "private channel" | "group DM" | "direct message with the agents"; name: string | null; inThread: boolean };
  agents: JudgeAgent[];
  // The last few messages before the new one, oldest first.
  recent: JudgeMessage[];
  message: JudgeMessage;
  authorKind: "human" | "agent" | "app";
}

export interface Verdict {
  // Probability, per agent, that this message is said to that agent. Whether it deserves a reply is the agent's call, never the judge's.
  needs: Map<string, number>;
  // Probability, per working agent, that this message tells it to stop.
  stop: Map<string, number>;
  urgency: "now" | "next" | "later";
  source: "jev" | "rules";
}

export interface WakeJudge {
  judge(input: JudgeInput): Promise<Verdict>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesAgent(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])@?${escapeRegex(name)}([^A-Za-z0-9_]|$)`, "i").test(text);
}

// What the bridge falls back to when the judgment model cannot be reached, and what agents with natural wakes off get:
// the agent's name appears, or it is a thread or DM the agent is already part of.
export class RuleJudge implements WakeJudge {
  async judge(input: JudgeInput): Promise<Verdict> {
    const needs = new Map<string, number>();
    const stop = new Map<string, number>();
    const stopWord = /\b(stop|cancel|abort|halt)\b/i.test(input.message.text);
    for (const agent of input.agents) {
      const named = namesAgent(input.message.text, agent.name);
      const continuing = agent.inThisConversation && input.authorKind === "human" && (input.conversation.inThread || input.conversation.kind === "direct message with the agents");
      needs.set(agent.name, named ? 0.9 : continuing ? 0.7 : 0.05);
      if (agent.working) stop.set(agent.name, stopWord && (named || continuing) ? 0.85 : 0.02);
    }
    return { needs, stop, urgency: "next", source: "rules" };
  }
}

// When an open ask has a clear taker, nobody else is woken by it.
const OPEN_ASK_OTHERS_CAP = 0.2;

interface JevAnswer {
  type: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
}

export interface JevOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// Reads each message the way a colleague would: who is this said to, is it a stop, how urgent is it.
// One request per message; every question is judged in parallel over the same state. It decides who, never whether:
// an agent a message is said to is always woken, and the agent, which has the context, decides if a reply is due.
export class JevJudge implements WakeJudge {
  private readonly fallback = new RuleJudge();

  constructor(private readonly options: JevOptions) {}

  async judge(input: JudgeInput): Promise<Verdict> {
    try {
      return await this.ask(input);
    } catch (error) {
      logWarn("judgment model unavailable; using plain rules for this message", { error: error instanceof Error ? error.message : String(error) });
      return this.fallback.judge(input);
    }
  }

  private async ask(input: JudgeInput): Promise<Verdict> {
    const questions: Record<string, unknown> = {
      urgency: {
        type: "choice",
        instructions: "How soon does `new_message` need attention from whoever it is for?",
        criteria: {
          now: "Something is broken, blocked, or time-critical, or the sender says it is urgent",
          next: "An ordinary request or question that should be handled promptly",
          later: "Background information, a note for later, or nothing anyone has to act on",
        },
      },
    };
    // An open ask ("can someone…") is said to nobody in particular. Judged per agent, every agent looks plausible;
    // asked as one choice, the agents are weighed against each other and the best fit takes it.
    questions.open_ask = {
      type: "choice",
      instructions:
        'If `new_message` is an open question or request to the room with nobody named ("can someone", "does anyone know", or a task stated to no one), which agent\'s role in `agents` fits it best? Otherwise answer nobody.',
      criteria: {
        ...Object.fromEntries(input.agents.map((agent, index) => [`agent_${index}`, `An open ask with nobody named, and ${agent.name} (${agent.role ?? "teammate"}) is the best fit for it`])),
        nobody: "The message names or is plainly said to specific people or agents, is addressed to everyone at once, continues an exchange already under way, or is not something any agent should pick up",
      },
    };
    input.agents.forEach((agent, index) => {
      questions[`needs_${index}`] = {
        type: "noul",
        instructions: `Is \`new_message\` said to the agent named "${agent.name}"? Read it the way ${agent.name} would on seeing it in Slack: from the words, from who has been talking to whom in \`recent_messages\`, and from each agent's role in \`agents\`. Judge only who is being spoken to. Do not judge whether the message is important or needs a reply.`,
        criteria: {
          true: `The message is said to ${agent.name}: it names, greets, or thanks ${agent.name}, asks or tells ${agent.name} something, replies to something ${agent.name} said, continues a back-and-forth ${agent.name} is part of even without naming anyone, says ${agent.name} should do or look at something, or is addressed to everyone or to all the agents`,
          false: `The message is said to someone else, only reports on or gossips about ${agent.name} without wanting anything from ${agent.name}, or is general talk that is not directed at ${agent.name}`,
        },
      };
      if (agent.working) {
        questions[`stop_${index}`] = {
          type: "noul",
          instructions: `Is \`new_message\` telling the agent named "${agent.name}" to stop, cancel, or abandon what it is doing right now?`,
        };
      }
    });
    const state = {
      conversation: input.conversation,
      agents: input.agents.map((agent) => ({ name: agent.name, role: agent.role ?? "teammate", already_in_this_conversation: agent.inThisConversation, working_right_now: agent.working })),
      recent_messages: input.recent,
      new_message: input.message,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 4_000);
    let answers: Record<string, JevAnswer>;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint ?? "https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.options.model ?? "jev-latest", state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`judgment request failed with HTTP ${response.status}`);
      answers = ((await response.json()) as { answers: Record<string, JevAnswer> }).answers;
    } finally {
      clearTimeout(timer);
    }
    const needs = new Map<string, number>();
    const stop = new Map<string, number>();
    input.agents.forEach((agent, index) => {
      const need = answers[`needs_${index}`]?.noul;
      if (typeof need !== "number") throw new Error(`judgment response has no answer for ${agent.name}`);
      needs.set(agent.name, need);
      const stopAnswer = answers[`stop_${index}`]?.noul;
      if (typeof stopAnswer === "number") stop.set(agent.name, stopAnswer);
    });
    const openAsk = answers.open_ask;
    const taker = openAsk?.choice?.startsWith("agent_") ? input.agents[Number(openAsk.choice.slice("agent_".length))] : undefined;
    const takerProbability = taker ? (openAsk?.probabilities?.[openAsk.choice!] ?? 0) : 0;
    if (taker && takerProbability >= 0.5) {
      // An open ask goes to its one best fit; "anyone" is not a reason to wake the rest.
      for (const agent of input.agents) needs.set(agent.name, agent === taker ? Math.max(needs.get(agent.name) ?? 0, takerProbability) : Math.min(needs.get(agent.name) ?? 0, OPEN_ASK_OTHERS_CAP));
    }
    const urgency = answers.urgency?.choice;
    return {
      needs,
      stop,
      urgency: urgency === "now" || urgency === "later" ? urgency : "next",
      source: "jev",
    };
  }
}
