// Live check of the wake judgments against realistic Slack lines. Needs TYPESAFE_API_KEY.
// Usage: tsx scripts/smoke/jevEval.ts
import { config as loadDotEnv } from "dotenv";
import { JevJudge, type JudgeInput } from "../../src/agents/judge.js";

loadDotEnv({ quiet: true });
const judge = new JevJudge({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
const agents = [
  { name: "ada", role: "generalist manager: plans, coordinates, reports to Konark", inThisConversation: false, working: false },
  { name: "cody", role: "builder: writes, fixes, and ships code", inThisConversation: false, working: false },
  { name: "scout", role: "researcher: looks things up and summarizes", inThisConversation: false, working: false },
];
type Case = { label: string; expect: string[]; stop?: string[]; input: Partial<JudgeInput> & { message: JudgeInput["message"] } };
const human = (text: string) => ({ from: "Konark (human)", text });
const cases: Case[] = [
  { label: "named, no @", expect: ["ada"], input: { message: human("ada what's the plan for today") } },
  { label: "named mid-sentence", expect: ["cody"], input: { message: human("hmm I think cody should take a look at the failing build") } },
  { label: "open ask, no name: every agent hears it", expect: ["ada", "cody", "scout"], input: { message: human("the deploy script is throwing a syntax error, can someone fix it") } },
  { label: "open research ask: every agent hears it", expect: ["ada", "cody", "scout"], input: { message: human("does anyone know how Slack rate limits chat.postMessage these days?") } },
  { label: "slangy greeting by name", expect: ["cody"], input: { message: human("Wsg Cody") } },
  { label: "good morning by name", expect: ["scout"], input: { message: human("gm scout") } },
  { label: "reported speech about an agent", expect: [], input: { message: human("I told Priya that cody would handle it") } },
  { label: "un-named reply in channel after ada answered", expect: ["ada"], input: { agents: agents.map((x) => ({ ...x, inThisConversation: x.name === "ada" })), recent: [human("ada what's on my calendar tomorrow"), { from: "ada (agent)", text: "(in a thread) Two things: standup at 10 and the dentist at 3." }], message: human("ok move the dentist to thursday") } },
  { label: "un-named reply in a thread with two agents, to the last speaker", expect: ["scout"], input: { conversation: { kind: "channel", name: "general", inThread: true }, agents: agents.map((x) => ({ ...x, inThisConversation: x.name !== "cody" })), recent: [human("ada and scout, brief me on Buzz"), { from: "ada (agent)", text: "I'll take positioning; scout has the feature list." }, { from: "scout (agent)", text: "Feature list is up: channels, agents as members, a shared memory. Want pricing too?" }], message: human("yes please, and how do they handle threads") } },
  { label: "un-named channel chatter after an old exchange", expect: [], input: { recent: [human("ada what's on my calendar tomorrow"), { from: "ada (agent)", text: "(in a thread) Two things: standup at 10 and the dentist at 3." }, { from: "Priya (human)", text: "anyone want coffee?" }], message: human("yeah I'll come, give me 5") } },
  { label: "open social question between people", expect: [], input: { recent: [{ from: "Priya (human)", text: "long morning" }], message: human("anyone want coffee?") } },
  { label: "talking ABOUT an agent", expect: [], input: { message: human("lol cody was so slow yesterday, anyway I'm getting lunch") } },
  { label: "human to human", expect: [], input: { message: human("Priya are we still on for 3pm?") } },
  { label: "follow-up with 'you' after cody spoke", expect: ["cody"], input: { agents: agents.map((a) => ({ ...a, inThisConversation: a.name === "cody" })), recent: [human("the deploy is failing on the mini"), { from: "cody (agent)", text: "I see it: the plist points at the old checkout." }], message: human("ok can you fix that and tell ada when it's done") } },
  { label: "two agents addressed", expect: ["ada", "scout"], input: { message: human("ada and scout, I need a competitive brief on Buzz by tonight") } },
  { label: "thanks to an agent (said to it; the agent decides)", expect: ["cody"], input: { agents: agents.map((a) => ({ ...a, inThisConversation: a.name === "cody" })), recent: [{ from: "cody (agent)", text: "Fixed and deployed." }], message: human("thanks!") } },
  { label: "stop in plain words", expect: ["cody"], stop: ["cody"], input: { agents: agents.map((a) => ({ ...a, working: a.name === "cody", inThisConversation: a.name === "cody" })), recent: [human("cody rebuild everything from scratch"), { from: "cody (agent)", text: "Starting the full rebuild." }], message: human("wait no stop, wrong branch") } },
  { label: "agent hands off to agent", expect: ["cody"], input: { authorKind: "agent", message: { from: "ada (agent)", text: "cody, Konark wants the deploy script fixed. Can you take it and report back here?" } } },
  { label: "agent thanks agent (said to it; the agent decides)", expect: ["ada"], input: { authorKind: "agent", agents: agents.filter((a) => a.name !== "cody"), message: { from: "cody (agent)", text: "Got it, thanks ada." } } },
  { label: "DM asking everyone", expect: ["ada", "cody", "scout"], input: { conversation: { kind: "direct message with the agents", name: null, inThread: false }, message: human("what's everyone working on right now?") } },
  { label: "name as part of another word", expect: [], input: { message: human("the adapter layer is scouting for a cody-style refactor, jk. brb") } },
];

let passed = 0;
const started = Date.now();
for (const item of cases) {
  const input: JudgeInput = { conversation: { kind: "channel", name: "general", inThread: false }, agents, recent: [], authorKind: "human", ...item.input };
  const t0 = Date.now();
  const verdict = await judge.judge(input);
  const woken = input.agents.filter((agent) => (verdict.needs.get(agent.name) ?? 0) >= 0.5).map((agent) => agent.name).sort();
  const stopped = [...verdict.stop].filter(([, p]) => p >= 0.8).map(([name]) => name).sort();
  const ok = JSON.stringify(woken) === JSON.stringify([...item.expect].sort()) && JSON.stringify(stopped) === JSON.stringify([...(item.stop ?? [])].sort());
  if (ok) passed += 1;
  const scores = input.agents.map((agent) => `${agent.name}=${(verdict.needs.get(agent.name) ?? 0).toFixed(2)}`).join(" ");
  console.log(`${ok ? "PASS" : "FAIL"} ${item.label.padEnd(40)} ${scores} stop=[${stopped}] ${verdict.urgency} ${verdict.source} ${Date.now() - t0}ms`);
}
console.log(`${passed}/${cases.length} passed in ${Date.now() - started}ms`);
process.exit(0);
