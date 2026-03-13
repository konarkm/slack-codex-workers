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
- SQLite persistence for worker mappings, DM sessions, defaults, cached channels, durable inbound message state, and attachment metadata
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
  - `/recover`
  - `/restart <codex|bridge|both>`
- image and file attachment ingestion

Not implemented yet:

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
- `chat:write.customize`
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
- `SUPERVISOR_RESTART_ENABLED`: set to `1` only when launching under `scripts/run.sh` or another restart-capable supervisor
- `ATTACHMENT_STORAGE_DIR`: local directory for downloaded Slack files
- `ATTACHMENT_MAX_BYTES`: per-file cap in bytes
- `ATTACHMENT_TOTAL_MAX_BYTES`: total cap per Slack message in bytes
- `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`: timeout per file download
- `ATTACHMENT_RETENTION_MS`: reserved for future retention cleanup; currently a no-op and should stay `off`/`null`

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

For supervisor-backed bridge restarts:

```bash
npm run build
npm run start:supervised
```

## Behavior Notes

- Channel roots create workers keyed by `(teamId, channelId, rootTs)`.
- Thread replies from humans become `username: message` turn input.
- If a worker turn is active, replies go through `turn/steer`.
- If no turn is active, replies start a fresh turn on the same worker.
- DM conversations are linear and use one Codex admin thread per admin user.
- Child workers inherit the root human owner for final mentions.
- Worker-authored messages use a stable per-thread Slack identity chosen from a curated name and emoji pool.
- If persisted active-turn state is stale after restart, the bridge clears it and posts a visible system note before continuing.
- If the backing Codex thread is missing, the Slack thread or admin DM enters recovery-required mode until `/recover` is used.
- If Codex is still running but the bridge lost the turn id during a crash/restart window, the thread enters a temporary blocked state and polls until the turn settles or recovery is required.
- Normal user messages sent while a thread is blocked or recovery-required are rejected and must be resent after the thread becomes usable again.
- Attachment-only messages are supported; images are passed as images and other files are stored locally with file-path notes.
- `slack_list_channels` and child-worker posting only use channels the bot is already a member of.
- `/restart bridge` and `/restart both` only work when `SUPERVISOR_RESTART_ENABLED=1` and the process is launched under a supervisor that restarts on exit code `42`.
- `/recover` is recovery-only; it is available only when the thread or admin DM is blocked or live Codex reconciliation shows the backing thread is missing.
