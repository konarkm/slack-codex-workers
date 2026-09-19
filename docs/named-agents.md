# Named agents

Named agents are teammates in Slack. Each one is a single mind: one Slack app, one durable inbox, and one Claude Agent SDK or Codex app-server session that is resumed by id across restarts. Mention an agent in any channel, reply to it in any thread, or DM it, and you are talking to the same session with the same context.

This is the successor to the one-worker-per-thread bridge described in the README. Both live in this repo until the old core is removed.

## Run it

```bash
mkdir -p .slack-agents && cp agents.example.json .slack-agents/agents.json   # then edit
npm run agents
```

State lives under `.slack-agents/` (override with `AGENTS_STATE_ROOT`): the registry `agents.json`, the SQLite database, downloaded attachments, and each local agent's home directory under `homes/<name>`.

Credentials come from the environment, per agent: `SLACK_BOT_TOKEN_<NAME>` and `SLACK_APP_TOKEN_<NAME>` (name upper-cased, hyphens as underscores). An entry can point at other variable names with `slackBotTokenEnv` and `slackAppTokenEnv`. An agent with missing credentials is skipped with an error; the others still start.

Other settings: `SLACK_ADMIN_USER_IDS` (who may use operator commands), `WORKSPACE_TIMEZONE`, `CODEX_BIN`, `AGENT_WAKE_BUDGET` (default 8), `THREAD_CONTEXT_LIMIT` (default 12).

## One Slack app per agent

A Slack app has exactly one bot user, and only a bot user can be @-mentioned, DMed, or listed as a member. Per-message name and icon overrides cannot. So each named agent gets its own app:

```bash
npx tsx scripts/provision-agent.ts ada --title "generalist manager"
```

This creates the app from a manifest (scopes, events, Socket Mode, agent surface) using an app configuration token (`SLACK_CONFIG_TOKEN`, plus `SLACK_CONFIG_REFRESH_TOKEN` so the 12-hour token can be rotated). Slack has no API for the last two steps, so the script prints the links: install the app to the workspace, and generate an app-level token with `connections:write`. Free workspaces allow 10 apps in total.

## Registry entry

| Field | Meaning |
|---|---|
| `name` | Lowercase handle. Also the agent's home directory name and env var suffix. |
| `title` | Short role line shown in the app description and the agent's instructions. |
| `runtime` | `claude` (Claude Agent SDK) or `codex` (Codex app-server). |
| `model`, `effort` | Passed to the runtime. Omit for the runtime's default. |
| `host` | `local` (default) or `ssh:<target>`. With ssh, the harness runs on that machine with that machine's own CLI login, and `cwd` is required. |
| `cwd` | The agent's home directory. Defaults to `homes/<name>` under the state root. |
| `wake` | What wakes the agent: `mentions` (default on), `directMessages` (default on), `participatingThreads` (replies in threads it has spoken in, default off), `ambient` (every message in its channels, default off). |
| `instructions` | Path to the agent's own standing instructions, appended to the base instructions. |
| `inheritUserConfig` | Claude only. Load the operator's user-level settings, MCP servers, and claude.ai connectors into the agent. Default off: an agent gets the bridge's tools and its own home directory's config, nothing else. |

## How a message reaches an agent

Every message the agent's app can see is stored in the agent's inbox, once, keyed by its Slack coordinates. A message that matches the agent's wake rules wakes it. Any other message waits in the inbox and is delivered with the next wake, marked as context. Nothing is dropped.

Messages arrive as tagged sections. The bridge writes the header fields; the content is escaped so it cannot imitate one:

```
<slack-message wake="mention">
From: Konark (U0AM64ML33J, human)
Where: #general (C0ANCMY4WU9), top level
Time: 2026-09-18 23:55:41 PDT
Message ts: 1789800941.139369
Reply target: channel=C0ANCMY4WU9 thread_ts=1789800941.139369
Content:
@you (U0ALQRTGUN5) quick check: which channel is this?
</slack-message>
```

- The reply target is computed by the bridge: under the message in channels, flat under an existing thread root, in the flow of a DM.
- A mention in a thread the agent has not seen brings the most recent earlier messages in a `<thread-context>` section, with `included`, `total`, and `truncated` attributes.
- A message that arrives mid-turn is delivered into the running turn with a note to keep working and take it into account.
- Another agent wakes an agent only by mentioning it. After `AGENT_WAKE_BUDGET` consecutive agent-to-agent wakes in one thread, further ones arrive as context until a human posts in that thread.

## How an agent speaks

Only through tools: `send_message`, `react`, `upload_files`, `edit_message`, `delete_message`. The bridge never posts on an agent's behalf, and turn output is not shown to anyone. `dismiss(reason)` records a deliberate non-reply. If a woken turn ends with no visible action and no dismissal, the bridge tells the agent once.

Other tools: `read_history`, `list_channels`, `list_people`, `join_channel`, `open_dm`, `get_message_link`, `get_current_time`, and `schedule_wake` / `list_wakes` / `cancel_wake` for interval and cron wakes the agent sets for itself.

Where the app is declared as a Slack agent, the thread shows Slack's working indicator while the agent's turn runs, and Slack's stop button interrupts the turn.

## Operator commands

Admins can send these in an agent's DM. They control the harness and are not delivered to the agent; replies are marked `_bridge_`.

- `.status`: state, runtime, host, session id, queued input, last error
- `.stop`: interrupt the current turn
- `.compact`: compact the session's context
- `.reset`: forget the session; the next message starts a new one

## Trust model

Agents run with approvals off and full access on their host, as the original bridge did. Anyone who can message an agent can direct a process with shell access on that machine. Use this only in a workspace where every member is trusted with that.
