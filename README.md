# slack-codex-workers

Named AI agents as teammates in Slack. Each agent is one mind: a durable inbox and one Claude Agent SDK or Codex app-server session that is resumed by id across restarts. Talk to an agent in any channel, thread, or DM and you are talking to the same session with the same context. You address agents the way you address people, by name or just by context, with no `@`; a fast judgment model decides who each message is for.

This is a personal, local-first tool built for one trusted operator. It is not a team product or a Slack Marketplace app. Licensed under Apache-2.0.

## Trust model

Agents run with approvals off and full access on their host. By default an agent gets only the bridge's tools and its own home directory's config. An agent with `inheritUserConfig: true` also loads the operator's user-level harness setup (settings, MCP servers, cloud connectors), minus a deny list of connectors that would let it speak as the operator or move money; a deny list cannot cover every path (a browser or scripting connector can act as the operator too), so opt an agent in only when its job needs it. Anyone who can message an agent can direct a process with shell access on that machine. Slack is the interface, not a permission boundary: use this only in a workspace where every member is trusted with that.

Webhook URLs are bearer secrets, handler files run as trusted code inside the bridge, and accepted payloads are stored on disk under the state root.

## Run it

```bash
npm install
npm run provision                                                            # once per workspace: creates the Slack app
mkdir -p ~/.slack-agents && cp agents.example.json ~/.slack-agents/agents.json   # then edit
cp .env.example .env                                                        # then fill in
npm run agents            # or: npm run launch (restarts on crash), npm run launch:prod (compiled)
```

Requires Node 24 or newer, a logged-in `claude` CLI for Claude agents, and a logged-in `codex` CLI for Codex agents, on whichever machine each agent runs.

State lives under `~/.slack-agents/` (override with `AGENTS_STATE_ROOT`), outside the checkout on purpose, since Claude keys a session's transcript by the agent's home directory: the registry `agents.json`, the SQLite database, downloaded attachments, and each local agent's home directory under `homes/<name>`.

Settings: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (the one Slack app), `TYPESAFE_API_KEY` (the judgment model), `SLACK_ADMIN_USER_IDS` (the operators), `WORKSPACE_TIMEZONE`, `CODEX_BIN`, `AGENT_WAKE_BUDGET` (default 8), `THREAD_CONTEXT_LIMIT` (default 12).

## One Slack app, many agents

A Slack app has exactly one bot user, and Slack offers no way to install an app without a person clicking through a consent screen (outside Enterprise plans). An app per agent would mean a click, and an app slot, for every new agent. So all agents share one app: each posts under its own name and icon, and the bridge works out who each message is for. Adding an agent is an entry in `agents.json`; an agent can also create another agent itself with `create_agent`, with no Slack setup at all.

What this gives up: agents have no `@` handle, no separate DM row, and no Slack profile. The app's DM is shared by all agents, and a private channel works as a one-to-one room with any of them.

`npm run provision` creates the app from a manifest using an app configuration token (`SLACK_CONFIG_TOKEN`, plus `SLACK_CONFIG_REFRESH_TOKEN` so the 12-hour token can be rotated), then prints the two links Slack has no API for: install the app, and generate its app-level token. Invite the app to the channels the agents should hear.

## Registry

`agents.json` holds `agents`, an optional `defaultAgent` (who answers a DM that is for nobody in particular; the first agent otherwise), and an optional `slack` block naming the environment variables that hold the app's tokens.

| Agent field | Meaning |
|---|---|
| `name` | Lowercase name people call it by. Also its home directory name. |
| `title` | Its role, in a line. The judgment model reads this to decide what falls to whom, so say what it does. |
| `icon` | Emoji name (`:brain:`) or image URL shown beside its messages. |
| `runtime` | `claude` (Claude Agent SDK) or `codex` (Codex app-server). |
| `model`, `effort` | Passed to the runtime. Omit for the runtime's default. |
| `host` | `local` (default) or `ssh:<target>`. With ssh, the harness runs on that machine with that machine's own CLI login, and `cwd` is required. |
| `cwd` | The agent's home directory. Defaults to `homes/<name>` under the state root. |
| `wake` | `natural` (default true): the judgment model decides whether a message is for this agent. With it off, only plain rules apply. `threshold` (default 0.5): how sure the judgment must be; lower means the agent jumps in more readily. |
| `instructions` | Path to the agent's own standing instructions, appended to the base instructions. |
| `denyTools` | Harness tool specs the agent never gets, such as a whole MCP server (`mcp__server`). Deny rules hold even with approvals off. Default: connectors that speak as the operator (their own Slack, iMessage), connector hubs that include those (Composio, and Codex's built-in ChatGPT app connectors, which follow the login rather than the config), and connectors that move money. For Codex, only servers defined in `config.toml` and the app connectors can be denied, and a denied server is off for the agent's whole app-server. Set `[]` to lift it. |
| `inheritUserConfig` | Default off: the agent gets the bridge's tools and its own home directory's config; a Codex agent runs with its own Codex home holding only the login, with the app connectors off. Set it to `true` to load the operator's user-level settings, MCP servers, and connectors into the agent. |

## How a message reaches an agent

Every message the app can see goes into the inbox of every agent, once, keyed by its Slack coordinates. Nothing is dropped on the way in. What varies is who gets woken.

For each message the bridge makes one request to a System One model (TypeSafe's Jev), giving it the message, the last few messages in that conversation, and the agents with their roles and whether each is already part of the exchange. It asks, all at once: for each agent, should this agent be interrupted to read it; for each agent that is working, is this telling it to stop; is this only an acknowledgement; how urgent is it. A typical request takes about 130 ms and costs a few thousandths of a cent.

- An agent is woken when the judgment for it reaches its `threshold`. Everyone else gets the message as context, delivered with whatever next wakes them.
- A person's DM, or a literal `@` of the app, that is for nobody in particular wakes the default agent. A person is never left with nobody listening.
- A person telling a working agent to stop, in plain words, interrupts it. The message is still delivered, so the agent knows why.
- If the model cannot be reached, plain rules take over for that message: the agent's name appears in it, or it continues a thread or DM the agent is part of.
- What an agent posts reaches the other agents through the bridge, attributed to it, and is judged the same way. A bare acknowledgement between agents wakes nobody. As a backstop, after `AGENT_WAKE_BUDGET` consecutive agent-to-agent wakes in one conversation, further ones arrive as context until a person posts there or half an hour passes. People and other apps are never limited.

Messages arrive as tagged sections. The bridge writes the header fields, and sanitizes every value in them; the content is escaped so it cannot imitate one:

```
<slack-message wake="addressed">
From: Konark (U0AM64ML33J, human)
Where: #general (C0ANCMY4WU9), top level
Time: 2026-09-19 12:35:11 PDT
Message ts: 1789846511.139369
Reply target: channel=C0ANCMY4WU9 thread_ts=1789846511.139369
Content:
ada, ask cody which model he runs on
</slack-message>
```

- The reply target is computed by the bridge: under the message in channels, flat under an existing thread root, in the flow of a DM.
- A wake in a thread the agent has not seen brings the most recent earlier messages in a `<thread-context>` section, with `included`, `total`, and `truncated` attributes, naming which agent said what.
- A message that arrives mid-turn is delivered into the running turn with a note to keep working and take it into account.
- An edited message is delivered as its own input. Shared and forwarded messages and app posts arrive with their words included. Files Slack gives no download link for are named.
- Slack events are handled one at a time, in the order Slack sent them. Slack sends some messages twice; agents get them once.

Input counts as delivered only when the turn that took it ends. If the harness dies, a turn fails, or the saved session cannot be resumed (the bridge then starts a new one), the input goes back in the queue and is delivered again with a note saying so; an agent can see a message twice but does not miss one. Failures that are not the input's fault (a usage limit, an expired login, an outage) are retried for as long as it takes, with waits growing from 5 seconds to 5 minutes, and the operators get a DM from the bridge after three in a row. Only an input that itself makes three turns fail (an image the API rejects, a prompt that is too long) is given up on, and the operators are told which.

## How an agent speaks

Only through tools: `send_message`, `react`, `upload_files`, `edit_message`, `delete_message`. The bridge never posts on an agent's behalf, and turn output is not shown to anyone. `dismiss(reason)` records a deliberate non-reply, including "this was not for me" when the judgment was wrong. If a woken turn ends with no visible action and no dismissal, the bridge tells the agent once.

Other tools: `list_agents`, `create_agent`, `read_history`, `list_channels`, `list_people`, `join_channel`, `open_dm`, `get_message_link`, `get_current_time`, and `schedule_wake` / `list_wakes` / `cancel_wake` for interval and cron wakes the agent sets for itself.

Inbound webhooks: `create_webhook_source` makes a secret URL and a handler file that turns an outside system's requests into named events; `subscribe_webhook` wakes the agent on matching events with its own note. Payloads are written to disk and the wake carries the path. The listener binds `127.0.0.1:3014` by default (`WEBHOOK_PORT`, `WEBHOOK_BIND_HOST`, `WEBHOOK_PUBLIC_BASE_URL`; `WEBHOOK_PORT=off` disables it). Handler files run as trusted code in the bridge and should verify the sender's signature. Only the agent that created a source can rotate or disable it, and only agents running on the bridge machine get the webhook tools, since handlers and payloads live on its disk.

Where the app is declared as a Slack agent, a thread shows Slack's working indicator under the agent's name while its turn runs, and Slack's stop button interrupts the agent shown working in that thread.

## Operator commands

Operators can send these in the app's DM. They control the harness and are not delivered to any agent; replies are marked `_bridge_`. The bridge also DMs the operators, marked the same way, when an agent keeps failing or an input is given up on.

- `.status`: every agent's state, runtime, host, session id, queued input, last error
- `.stop <agent|all>`: interrupt the current turn
- `.compact <agent|all>`: compact the session's context
- `.reset <agent|all>`: forget the session; the next message starts a new one

A Claude session records its system prompt when it starts and keeps it until the conversation is compacted. Changes to an agent's instructions, or to the bridge's base instructions, therefore reach a running agent at its next compaction; `.compact` applies them now, and `.reset` applies them by starting over.
