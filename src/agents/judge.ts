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

// A judgment takes about 150 ms, so a failed one is simply asked again before the plain rules take over.
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 2_500;
const RETRY_WAITS_MS = [150, 500];

interface JevAnswer {
  type: string;
  noul?: number;
  choice?: string;
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
    const errors: string[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        const verdict = await this.ask(input);
        if (errors.length > 0) logWarn("judgment succeeded after a retry", { errors });
        return verdict;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        const wait = RETRY_WAITS_MS[attempt];
        if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    logWarn("judgment model unavailable; using plain rules for this message", { errors });
    return this.fallback.judge(input);
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
    // An open ask ("can someone…") is said to every agent. Nobody picks a taker here: the agents all hear it and
    // settle between themselves who takes it, or ask.
    questions.open_ask = {
      type: "noul",
      instructions:
        'Is `new_message` an open question or request put to the room with nobody named ("can someone", "does anyone know", or a task stated to no one), of a kind the agents in `agents` exist to pick up?',
      criteria: {
        true: "Nobody is named, it is not a reply in an exchange already under way, and it asks for work or information that an agent on this team could provide",
        false: "It names or is plainly said to specific people or agents, continues an exchange already under way, or is talk between people (plans, chatter, social questions) that no agent is being asked to handle",
      },
    };
    input.agents.forEach((agent, index) => {
      questions[`needs_${index}`] = {
        type: "noul",
        instructions: `Is \`new_message\` said to the agent named "${agent.name}"? Read it the way ${agent.name} would on seeing it in Slack: from the words, from who has been talking to whom in \`recent_messages\`, and from each agent's role in \`agents\`. Judge only who is being spoken to. Do not judge whether the message is important or needs a reply.`,
        criteria: {
          true: `The message is said to ${agent.name}: it names, greets, or thanks ${agent.name}, asks or tells ${agent.name} something, replies to something ${agent.name} said, continues a back-and-forth ${agent.name} is part of even without naming anyone, says ${agent.name} should do or look at something, or is addressed to all the agents`,
          false: `The message is said to someone else, only reports on or gossips about ${agent.name} without wanting anything from ${agent.name}, is a social question or plan among people (coffee, lunch, who is around), or is general talk that is not directed at ${agent.name}`,
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
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
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
    const openAsk = answers.open_ask?.noul ?? 0;
    if (openAsk >= 0.5) for (const agent of input.agents) needs.set(agent.name, Math.max(needs.get(agent.name) ?? 0, openAsk));
    const urgency = answers.urgency?.choice;
    return {
      needs,
      stop,
      urgency: urgency === "now" || urgency === "later" ? urgency : "next",
      source: "jev",
    };
  }
}
