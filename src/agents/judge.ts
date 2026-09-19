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
  // Probability, per agent, that this message needs that agent's attention now.
  needs: Map<string, number>;
  // Probability, per working agent, that this message tells it to stop.
  stop: Map<string, number>;
  // Probability that this is only an acknowledgement nobody needs to act on.
  bareAck: number;
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
    return { needs, stop, bareAck: /^\s*(ok(ay)?|thanks?( you)?|thx|ty|got it|cool|nice|great|👍|🙏)[\s.!]*$/i.test(input.message.text) ? 0.9 : 0.05, urgency: "next", source: "rules" };
  }
}

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

// Reads each message the way a colleague would: who is this for, is it a stop, is it just a thank-you, how urgent is it.
// One request per message; every question is judged in parallel over the same state. The answers only decide who is
// woken. The message itself reaches every agent in the conversation regardless.
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
      bare_ack: {
        type: "noul",
        instructions: "Is `new_message` only an acknowledgement or pleasantry (thanks, ok, got it, sounds good) that asks nothing and needs no reply or action from anyone?",
      },
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
    input.agents.forEach((agent, index) => {
      questions[`needs_${index}`] = {
        type: "noul",
        instructions: `Should the agent named "${agent.name}" be interrupted to read \`new_message\` now? Judge the way an attentive colleague named ${agent.name} would on hearing it in the room: from the words, from who has been talking to whom in \`recent_messages\`, and from each agent's role in \`agents\`.`,
        criteria: {
          true: `The message asks or tells ${agent.name} something, answers ${agent.name}, continues an exchange ${agent.name} is part of, or is a request that clearly falls to ${agent.name}'s role when nobody else is addressed`,
          false: `The message is for someone else, only talks about ${agent.name}, or is general chatter ${agent.name} does not need to act on`,
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
    const urgency = answers.urgency?.choice;
    return {
      needs,
      stop,
      bareAck: answers.bare_ack?.noul ?? 0,
      urgency: urgency === "now" || urgency === "later" ? urgency : "next",
      source: "jev",
    };
  }
}
