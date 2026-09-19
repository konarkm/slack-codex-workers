import { describe, expect, it } from "vitest";
import { JevJudge, type JudgeInput } from "../agents/judge.js";

const input: JudgeInput = {
  conversation: { kind: "channel", name: "general", inThread: false },
  agents: [{ name: "ada", role: "manager", inThisConversation: false, working: false }, { name: "cody", role: "builder", inThisConversation: true, working: true }],
  recent: [{ from: "cody (agent)", text: "the plist points at the old checkout" }],
  message: { from: "Konark (human)", text: "ok can you fix that" },
  authorKind: "human",
};

function fakeFetch(respond: (body: any) => { status?: number; json?: unknown } | Promise<never>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const impl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const result = await respond(body);
    return { ok: (result.status ?? 200) < 300, status: result.status ?? 200, json: async () => result.json };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("JevJudge", () => {
  it("asks one request per message: a question per agent, a stop question only for working agents, plus acknowledgement and urgency", async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: { answers: { needs_0: { type: "noul", noul: 0.04 }, needs_1: { type: "noul", noul: 0.96 }, stop_1: { type: "noul", noul: 0.01 }, bare_ack: { type: "noul", noul: 0.02 }, urgency: { type: "choice", choice: "now" } } },
    }));
    const verdict = await new JevJudge({ apiKey: "k", fetchImpl: impl }).judge(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.Authorization).toBe("Bearer k");
    expect(Object.keys(calls[0]!.body.questions).sort()).toEqual(["bare_ack", "needs_0", "needs_1", "stop_1", "urgency"]);
    expect(calls[0]!.body.state.new_message).toEqual(input.message);
    expect(calls[0]!.body.state.agents[1]).toMatchObject({ name: "cody", already_in_this_conversation: true, working_right_now: true });
    expect(verdict).toMatchObject({ source: "jev", urgency: "now", bareAck: 0.02 });
    expect(verdict.needs.get("cody")).toBe(0.96);
    expect(verdict.stop.has("ada")).toBe(false);
  });

  it("falls back to plain rules when the model cannot be reached or answers badly, so messages still wake someone", async () => {
    const down = fakeFetch(() => ({ status: 503 }));
    const named = { ...input, message: { from: "Konark (human)", text: "ada, status?" } };
    const verdict = await new JevJudge({ apiKey: "k", fetchImpl: down.impl }).judge(named);
    expect(verdict.source).toBe("rules");
    expect(verdict.needs.get("ada")).toBeGreaterThan(0.5);

    const partial = fakeFetch(() => ({ json: { answers: { needs_0: { type: "noul", noul: 0.9 } } } }));
    expect((await new JevJudge({ apiKey: "k", fetchImpl: partial.impl }).judge(named)).source).toBe("rules");

    const hanging = (async (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect((await new JevJudge({ apiKey: "k", fetchImpl: hanging, timeoutMs: 20 }).judge(named)).source).toBe("rules");
  });
});
