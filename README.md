# slack-codex-workers

Named AI agents as teammates in Slack. Each agent is one mind: one Slack app, one durable inbox, and one Claude Agent SDK or Codex app-server session that is resumed by id across restarts. Mention an agent in any channel, reply to it in any thread, or DM it, and you are talking to the same session with the same context.

This is a personal, local-first tool built for one trusted operator. It is not a team product or a Slack Marketplace app. Licensed under Apache-2.0.

## Trust model

Agents run with approvals off and full access on their host. By default a Claude agent also inherits the operator's user-level setup, including cloud connectors. Anyone who can message an agent can direct a process with shell access, and the operator's connected accounts, on that machine. Slack is the interface, not a permission boundary: use this only in a workspace where every member is trusted with that.

Webhook URLs are bearer secrets, handler files run as trusted code inside the bridge, and accepted payloads are stored on disk under the state root.

## Run it

```bash
npm install
mkdir -p ~/.slack-agents && cp agents.example.json ~/.slack-agents/agents.json   # then edit
cp .env.example .env                                                        # then fill in
npm run agents            # or: npm run launch (restarts on crash), npm run launch:prod (compiled)
```

Requires Node 24 or newer, a logged-in `claude` CLI for Claude agents, and a logged-in `codex` CLI for Codex agents, on whichever machine each agent runs.

State lives under `~/.slack-agents/` (override with `AGENTS_STATE_ROOT`), outside the checkout on purpose, since Claude keys a session's transcript by the agent's home directory: the registry `agents.json`, the SQLite database, downloaded attachments, and each local agent's home directory under `homes/<name>`.

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
| `wake` | What wakes the agent: `mentions` (default on), `directMessages` (default on), `participatingThreads` (replies in threads it has spoken in, default on), `ambient` (every message in its channels, default off). |
| `instructions` | Path to the agent's own standing instructions, appended to the base instructions. |
| `denyTools` | Harness tool specs the agent never gets, such as a whole MCP server (`mcp__server`). Deny rules hold even with approvals off. Default: connectors that speak as the operator (their own Slack, iMessage), connector hubs that include those (Composio, and Codex's built-in ChatGPT app connectors, which follow the login rather than the config), and connectors that move money. For Codex a denied server is switched off for the agent's whole app-server. Set `[]` to lift it. |
| `inheritUserConfig` | Claude only. Default on: the agent loads the operator's user-level settings, MCP servers, and claude.ai connectors, so it can use what the operator can. Set it to `false` to confine an agent to the bridge's tools and its own home directory's config; a Codex agent then runs with its own Codex home holding only the login, with the app connectors off. |

## How a message reaches an agent

Every message the agent's app can see is stored in the agent's inbox, once, keyed by its Slack coordinates. A message that matches the agent's wake rules wakes it. Any other message waits in the inbox and is delivered with the next wake, marked as context. Nothing is dropped on the way in.

Input counts as delivered only when the turn that took it ends. If the harness dies, a turn fails, or the saved session cannot be resumed (the bridge then starts a new one), the input goes back in the queue and is delivered again with a note saying so; an agent can see a message twice but does not miss one. Failures that are not the input's fault (a usage limit, an expired login, an outage) are retried for as long as it takes, with waits growing from 5 seconds to 5 minutes, and the operators get a DM from the bridge after three in a row. Only an input that itself makes three turns fail (an image the API rejects, a prompt that is too long) is given up on, and the operators are told which.

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
- Another agent wakes an agent by mentioning it, or by sending it a DM. After `AGENT_WAKE_BUDGET` consecutive wakes by agents of this bridge in one thread (or one DM, or one channel's top level), further ones arrive as context until a person posts there or half an hour passes. Other apps are never limited.
- An edited message is delivered as its own input, so a corrected ask or a late @mention is heard. Shared and forwarded messages and app posts arrive with their words included. Files Slack gives no download link for are named.
- Slack events are handled one at a time per agent, in the order Slack sent them. Slack sends a mention twice (as a message and as a mention); the agent gets it once.

## How an agent speaks

Only through tools: `send_message`, `react`, `upload_files`, `edit_message`, `delete_message`. The bridge never posts on an agent's behalf, and turn output is not shown to anyone. `dismiss(reason)` records a deliberate non-reply. If a woken turn ends with no visible action and no dismissal, the bridge tells the agent once.

Other tools: `read_history`, `list_channels`, `list_people`, `join_channel`, `open_dm`, `get_message_link`, `get_current_time`, and `schedule_wake` / `list_wakes` / `cancel_wake` for interval and cron wakes the agent sets for itself.

Inbound webhooks: `create_webhook_source` makes a secret URL and a handler file that turns an outside system's requests into named events; `subscribe_webhook` wakes the agent on matching events with its own note. Payloads are written to disk and the wake carries the path. The listener binds `127.0.0.1:3014` by default (`WEBHOOK_PORT`, `WEBHOOK_BIND_HOST`, `WEBHOOK_PUBLIC_BASE_URL`; `WEBHOOK_PORT=off` disables it). Handler files run as trusted code in the bridge and should verify the sender's signature. Only the agent that created a source can rotate or disable it, and only agents running on the bridge machine get the webhook tools, since handlers and payloads live on its disk.

Where the app is declared as a Slack agent, the thread shows Slack's working indicator while the agent's turn runs, and Slack's stop button interrupts the turn.

## Operator commands

Admins can send these in an agent's DM. They control the harness and are not delivered to the agent; replies are marked `_bridge_`. The bridge also DMs the admins, marked the same way, when an agent keeps failing or an input is given up on.

- `.status`: state, runtime, host, session id, queued input, last error
- `.stop`: interrupt the current turn
- `.compact`: compact the session's context
- `.reset`: forget the session; the next message starts a new one

A Claude session records its system prompt when it starts and keeps it until the conversation is compacted. Changes to an agent's instructions, or to the bridge's base instructions, therefore reach a running agent at its next compaction; `.compact` applies them now, and `.reset` applies them by starting over.

