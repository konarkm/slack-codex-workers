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
  - `slack_upload_files`
- channel-thread commands:
  - `/help`
  - `/status`
  - `/health`
  - `/model`
  - `/effort`
  - `/compact`
  - `/stop`
  - `/recover`
- admin DM commands:
  - `/help`
  - `/status`
  - `/health`
  - `/model`
  - `/effort`
  - `/compact`
  - `/stop`
  - `/recover`
  - `/restart <codex|bridge|both>`
  - `/restart-now`
  - `/restart-cancel`
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
- `files:write`
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
- `CODEX_CWD`: canonical workspace root. Codex runs here, and bridge state defaults under `CODEX_CWD/.slack-codex-workers/`
- `DATABASE_PATH`: optional SQLite override. Default: `CODEX_CWD/.slack-codex-workers/bridge.sqlite`
- `SUPERVISOR_RESTART_ENABLED`: set automatically by `./scripts/launch.sh`; only override it if you know what you are doing
- `ATTACHMENT_STORAGE_DIR`: optional attachment storage override. Default: `CODEX_CWD/.slack-codex-workers/attachments`
- `ATTACHMENT_MAX_BYTES`: per-file cap in bytes
- `ATTACHMENT_TOTAL_MAX_BYTES`: total cap per Slack message in bytes; set to `off` for no total cap
- `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`: timeout per file download
- `ATTACHMENT_RETENTION_MS`: reserved for future retention cleanup; currently a no-op and should stay `off`/`null`
- `SLACK_UPLOAD_TIMEOUT_MS`: timeout for outbound Slack file upload calls
- `SLACK_UPLOAD_MAX_FILES`: max files accepted by one `slack_upload_files` tool call

## Run

```bash
npm install
./scripts/launch.sh
```

That is the preferred path for local use and dogfooding. It:
- loads `.env`
- verifies required env vars and the local `codex` binary
- keeps one bridge instance running
- enables queued `/restart` support automatically
- runs `tsx src/index.ts` in dev mode so queued restarts actually relaunch the bridge cleanly

If you want file-watch autoreload without the restart queue semantics, use:

```bash
npm run dev
```

For a supervised production build:

```bash
./scripts/launch.sh --prod
```

## Behavior Notes

- The server repo is just the bridge code. Runtime state lives under the configured workspace root:
  - SQLite: `CODEX_CWD/.slack-codex-workers/bridge.sqlite`
  - downloaded Slack files: `CODEX_CWD/.slack-codex-workers/attachments/`
- You can override those paths explicitly, but the default mental model is “all session state belongs to the workspace.”

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
- `slack_upload_files` uploads one or more local files from allowed roots into the current Slack conversation; worker threads upload into the active thread, and admin DMs upload into the DM conversation.
- `slack_list_channels` and child-worker posting only use channels the bot is already a member of.
- `/status` and `/health` are available in worker threads and admin DMs. Thread commands report thread-specific state; DM commands report bridge-wide state.
- Thread `/model` and `/effort` set thread-local overrides. DM `/model` and `/effort` set the global defaults used by any thread that does not have an override.
- `/restart <codex|bridge|both>` queues a restart request and waits for the runtime to become idle.
- `/restart-now` forces the currently queued restart immediately.
- `/restart-cancel` clears the currently queued restart.
- `/restart bridge` and `/restart both` only work properly under the launcher/supervisor path because they exit with code `42` and rely on `./scripts/launch.sh` to relaunch the bridge.
- `/recover` is recovery-only; it is available only when the thread or admin DM is blocked or live Codex reconciliation shows the backing thread is missing.
