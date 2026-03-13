# slack-codex-workers

Slack-first bridge for running many Codex app-server workers behind one Slack bot identity.

## What It Does

- Every top-level Slack channel message creates a distinct Codex worker thread.
- Replies inside that Slack thread steer the active turn or start the next turn.
- Interleaved Codex progress gets rendered back into the Slack thread as:
  - streamed assistant messages
  - a mutable worklog message for tool/command/MCP activity
- The final completion message always mentions the root human owner.
- Admin DMs provide a control surface for defaults and bridge operations.

## Current Scope

Implemented in this repo:

- single-workspace Bolt Socket Mode bridge
- SQLite persistence for worker mappings, DM sessions, defaults, cached channels, and message dedupe
- one shared `codex app-server` subprocess
- dynamic tools:
  - `slack_list_channels`
  - `slack_spawn_worker`
- channel-thread commands:
  - `/help`
  - `/model`
  - `/effort`
  - `/compact`
- admin DM commands:
  - `/help`
  - `/status`
  - `/model`
  - `/effort`
  - `/compact`
  - `/restart <codex|bridge|both>`
- image and file attachment ingestion

Not implemented yet:

- worker rehydration of in-flight turns after bridge restart
- parent worker wait/watch loop for child workers
- multi-workspace OAuth install flow
- HTTP health/readiness endpoints

## Requirements

- Node 24+
- local `codex` binary on `PATH`, or `CODEX_BIN` set explicitly
- Slack app configured for Socket Mode

Recommended Slack bot scopes:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `users:read`

## Configuration

Copy `.env.example` to `.env` and set values:

```bash
cp .env.example .env
```

Key variables:

- `SLACK_BOT_TOKEN`: bot token
- `SLACK_APP_TOKEN`: Socket Mode app token
- `SLACK_ADMIN_USER_IDS`: comma-separated Slack user IDs allowed to use DM admin controls
- `SLACK_ALLOWED_TEAM_ID`: optional hard guard for one workspace
- `CODEX_CWD`: repo/project directory Codex should operate in by default
- `DATABASE_PATH`: SQLite path

## Run

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

## Behavior Notes

- Channel roots create workers keyed by `(teamId, channelId, rootTs)`.
- Thread replies from humans become `username: message` turn input.
- If a worker turn is active, replies go through `turn/steer`.
- If no turn is active, replies start a fresh turn on the same worker.
- DM conversations are linear and use one Codex admin thread per admin user.
- Child workers inherit the root human owner for final mentions.
