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

What this gives up: agents have no `@` handle, no separate DM row, and no Slack profile. Instead, each thread in the app's DM is a private session with one agent: the first message picks the agent (by name, or the default agent), every later message in that thread goes to that agent whoever it names, the session's title starts with the agent's name, and no other agent can hear, read, or write there.

`npm run provision` creates the app from a manifest using an app configuration token (`SLACK_CONFIG_TOKEN`, plus `SLACK_CONFIG_REFRESH_TOKEN` so the 12-hour token can be rotated), then prints the two links Slack has no API for: install the app, and generate its app-level token. Invite the app to the channels the agents should hear. `npm run provision -- --update <app id>` pushes a changed manifest to the existing app; when scopes were added it prints the reinstall link (the bot token stays the same).

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
| `retired` | An agent that is stood down: it keeps its entry, home, and session but does not listen. `retiredReason` records why. |
| `inheritUserConfig` | Default off: the agent gets the bridge's tools and its own home directory's config; a Codex agent runs with its own Codex home holding only the login, with the app connectors off. Set it to `true` to load the operator's user-level settings, MCP servers, and connectors into the agent. |

## How a message reaches an agent

A message goes to the agents it is said to, and to nobody else. The bridge decides who; it never decides whether a message deserves a reply. That is the agent's call, because the agent has the context. A wasted turn in which an agent reads a thank-you and does nothing is cheap; an agent that was spoken to and never woke is not.

For each message the bridge makes one request to a System One model (TypeSafe's Jev), giving it the message, the recent messages in that conversation, and the agents with their roles and whether each is already part of the exchange. It asks, all at once: for each agent, is this said to that agent; is it an open ask put to the room with nobody named; for each agent that is working, is this telling it to stop; how urgent is it. A typical request takes about 130 ms and costs a few thousandths of a cent.

- An agent is woken when the judgment for it reaches its `threshold`. Names are not required: a reply in an exchange the agent is part of is said to that agent. After a restart the bridge reads the conversation's recent messages back from Slack, so the judgment sees what a person scrolling the channel would see, threads included.
- An open ask ("can someone…") wakes every agent. The bridge does not pick a taker: each agent is told who else the message woke, and they settle it between themselves (best role fit takes it and says so; a toss-up goes to the first name alphabetically; if nobody fits, that agent asks the person).
- A judgment that fails is asked again with doubling waits (800 ms per attempt, 3 s in all) before the plain rules take over. A rejected request (a bad key) is not retried.
- A woken agent gets the message together with what it missed in that thread, or on that channel's main line, since it last looked: at most `THREAD_CONTEXT_LIMIT` messages, newest first in priority, on a channel's main line nothing older than a day, each caught-up message cut at 1,500 characters with a pointer to `get_message`, a thread's opening message always kept, main-line messages marked when they have a thread under them. The first time, that means the latest messages. Reading the latest page with `read_history` also counts as having looked. Agents that were not woken get nothing; like people, they catch up when something pulls them in, and `read_history` reads further back.
- A person's DM, or a literal `@` of the app, that is for nobody in particular wakes the default agent. A person is never left with nobody listening.
- A person telling a working agent to stop, in plain words, interrupts it. The message is still delivered, so the agent knows why.
- If the model cannot be reached, plain rules take over for that message: the agent's name appears in it, or it continues a thread or DM the agent is part of.
- What an agent posts is judged the same way, so agents address each other by name. As a backstop against loops, after `AGENT_WAKE_BUDGET` consecutive agent-to-agent wakes in one conversation, further ones wake nobody until a person posts there or half an hour passes. People and other apps are never limited.
- A reaction on an agent's own message always reaches that agent, as a `<slack-reaction>` section naming the emoji and the message.

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

- The reply target is computed by the bridge: under the message, or flat under an existing thread root.
- What the agent missed arrives in a `<thread-context>` or `<channel-context>` section before the message, with `included`, `total`, and `truncated` attributes, naming which agent said what.
- A message that arrives mid-turn is delivered into the running turn with a note to keep working and take it into account.
- An edited message is delivered as its own input. Shared and forwarded messages and app posts arrive with their words included. Files Slack gives no download link for are named.
- Slack events are handled one at a time, in the order Slack sent them. Slack sends some messages twice; agents get them once.

Input counts as delivered only when the turn that took it ends. If the harness dies, a turn fails, or the saved session cannot be resumed (the bridge then starts a new one), the input goes back in the queue and is delivered again with a note saying so; an agent can see a message twice but does not miss one. Failures that are not the input's fault (a usage limit, an expired login, an outage) are retried for as long as it takes, with waits growing from 5 seconds to 5 minutes, and the operators get a DM from the bridge after three in a row. Only an input that itself makes three turns fail (an image the API rejects, a prompt that is too long) is given up on, and the operators are told which.

## How an agent speaks

Only through tools: `send_message`, `react`, `upload_files`, `edit_message`, `delete_message`. The bridge never posts on an agent's behalf, and turn output is not shown to anyone. `dismiss(reason)` records a deliberate non-reply, including "this was not for me" when the judgment was wrong. If a woken turn ends with no visible action and no dismissal, the bridge tells the agent once.

The bridge serves its tools to every agent over MCP from one server in the hub (`127.0.0.1:3015/mcp` by default; `TOOL_SERVER_PORT`, `TOOL_SERVER_BIND_HOST`, and `TOOL_SERVER_PUBLIC_URL` for agents on other machines). Each agent gets its own token and its own tool set, and every harness reads the catalog at session start, so a tool added to the bridge reaches a running agent at its next wake after a hub restart, on the same session. Codex takes the server as command-line overrides, never as a config file edit; the token travels in the process environment. Claude keeps every bridge tool in the prompt (`alwaysLoad`). Codex keeps MCP tools behind its tool search and offers no way around that, so a Codex agent's instructions tell it the bridge tools are core and to load the `mcp__bridge` set first on a fresh session and after a compaction; one search per session is the cost of never resetting an agent for a tool change.

Other tools: `list_agents`, `create_agent`, `update_agent` (repurpose: role, instructions, model, icon; the agent restarts with them, keeping its session), `retire_agent` (stops listening, keeps everything; an agent may retire itself, taking effect when its turn ends), `revive_agent`, `delete_agent` (roster entry, bridge records, and bridge-made home directory removed; an agent cannot delete itself), `whats_new` (counts of what has been said since the agent last looked, per conversation, with no content; asking clears them; kept from what the bridge saw while running, for 30 days), `read_history`, `get_message` (one message in full), `get_file` (downloads the files on a message the agent was not woken by), `list_channels`, `list_people`, `join_channel`, `open_dm`, `get_message_link`, `get_current_time`, `name_thread` (titles a thread; in the app's DM, titled threads show as named sessions in the person's sidebar), and `schedule_wake` / `list_wakes` / `cancel_wake` for interval and cron wakes the agent sets for itself.

`search_workspace` searches public channels and files as the person who last addressed the app (Slack grants a bot token search over public channels only). Any agent can use that token, whoever asked, which is one more reason the workspace must be one where everyone is trusted. Slack hands the app a search token only when someone @-mentions it or DMs it, and does not say how long the token lasts; without one the tool says so, and the agent asks the person to @-mention the app.

Inbound webhooks: `create_webhook_source` makes a secret URL and a handler file that turns an outside system's requests into named events; `subscribe_webhook` wakes the agent on matching events with its own note. Payloads are written to disk and the wake carries the path. The listener binds `127.0.0.1:3014` by default (`WEBHOOK_PORT`, `WEBHOOK_BIND_HOST`, `WEBHOOK_PUBLIC_BASE_URL`; `WEBHOOK_PORT=off` disables it). Handler files run as trusted code in the bridge and should verify the sender's signature. Only the agent that created a source can rotate or disable it, and only agents running on the bridge machine get the webhook tools, since handlers and payloads live on its disk.

Where the app is declared as a Slack agent, a thread shows Slack's working indicator under the agent's name from the moment a message is routed to it until its turn ends, and Slack's stop button interrupts the agent shown working in that thread. An agent can also mark a session `waiting` (on the person) or `done` with `mark_session`, which Slack shows in its session list. A DM carries what the person had open when they wrote it (`Viewing:`), so "what's going on here" works. When a person renames a session, the owning agent's name is kept in front. Opening the app's Messages tab shows suggested prompts built from the current roster.

## Operator commands

Operators can send these in the app's DM. They control the harness and are not delivered to any agent; replies are marked `_bridge_`. The bridge also DMs the operators, marked the same way, when an agent keeps failing or an input is given up on.

- `.status`: every agent's state, runtime, host, session id, queued input, last error
- `.stop <agent|all>`: interrupt the current turn
- `.compact <agent|all>`: compact the session's context
- `.reset <agent|all>`: forget the session; the next message starts a new one
- `.retire <agent>`, `.revive <agent>`, `.delete <agent>`: the same lifecycle changes an agent can make

A Claude session records its system prompt when it starts and keeps it until the conversation is compacted. Changes to an agent's instructions, or to the bridge's base instructions, therefore reach a running agent at its next compaction; `.compact` applies them now, and `.reset` applies them by starting over.
