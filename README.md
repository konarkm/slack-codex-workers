# slack-codex-workers

Slack-first bridge for running many Codex app-server workers behind one Slack bot identity.

## What It Does

- Registered Slack channels act as workstream homes.
- `#general` is bootstrapped as the root workstream home on startup.
- Every top-level Slack message in a registered workstream channel creates a distinct Codex worker thread.
- Replies inside that Slack thread steer the active turn or start the next turn.
- Interleaved Codex progress gets rendered back into the Slack thread as:
  - streamed assistant messages
  - a mutable worklog message for tool/command/MCP activity
- The final completion message always mentions the root human owner.
- Admin DMs provide a control surface for defaults and bridge operations.
- Each spawned worker writes a durable local request item and later response items inside its workstream.

## Current Scope

Implemented in this repo:

- single-workspace Bolt Socket Mode bridge
- SQLite persistence for workstream registry, worker mappings, DM sessions, defaults, cached channels, durable inbound message state, attachment metadata, registrations, pending wakes, and webhook events
- one shared `codex app-server` subprocess
- root workstream bootstrap under `WORKSPACE_ROOT`
- explicit workstream scaffolding under nested directories with `WORKSTREAM.md`, `AGENTS.md`, and local `.slack-workers/`
- canonical workstream item landing for new public work
- durable heartbeat / cron / webhook registrations with wake-self delivery and scheduled workstream spawns
- authenticated webhook ingress with durable raw payload storage and event dedupe
- worker dynamic tools:
  - `slack_list_channels`
  - `slack_spawn_worker`
  - `slack_create_workstream`
  - `slack_upload_files`
  - `get_current_time`
  - `get_webhook_mailbox`
  - `set_heartbeat`
  - `set_cron`
  - `set_webhook`
  - `disable_registration`
  - `list_registrations`
  - `get_registration`
  - `list_wake_deliveries`
- admin DM dynamic tools:
  - `slack_create_workstream`
  - `slack_upload_files`
  - `get_current_time`
  - `get_webhook_mailbox`
  - `rotate_webhook_secret`
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
  - `/workstream-create <slug> [parent=<path>] [description...]`
- image and file attachment ingestion

Not implemented yet:

- parent worker wait/watch loop for child workers
- webhook/upload retention cleanup and broader repair tooling
- richer admin/operator-wide inspection and control-plane tools
- multi-workspace OAuth install flow
- HTTP health/readiness endpoints

## Requirements

- Node 24+
- local `codex` binary on `PATH`, or `CODEX_BIN` set explicitly
- Slack app configured for Socket Mode

Required Slack bot scopes for the default bootstrap and workstream-creation path:

- `app_mentions:read`
- `channels:history`
- `channels:join`
- `channels:manage`
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
- `WORKSPACE_ROOT`: canonical workspace root. Codex runs here, and bridge state defaults under `WORKSPACE_ROOT/.slack-workers/`
- `CODEX_CWD`: legacy alias for `WORKSPACE_ROOT`; still accepted for compatibility, but `WORKSPACE_ROOT` is the preferred env var
- `DATABASE_PATH`: optional SQLite override. Default: `WORKSPACE_ROOT/.slack-workers/bridge/bridge.sqlite`
- `SUPERVISOR_RESTART_ENABLED`: set automatically by `./scripts/launch.sh`; only override it if you know what you are doing
- `ATTACHMENT_STORAGE_DIR`: optional attachment storage override. Default: `WORKSPACE_ROOT/.slack-workers/bridge/attachments`
- `ATTACHMENT_MAX_BYTES`: per-file cap in bytes
- `ATTACHMENT_TOTAL_MAX_BYTES`: total cap per Slack message in bytes; set to `off` for no total cap
- `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`: timeout per file download
- `ATTACHMENT_RETENTION_MS`: reserved for future retention cleanup; currently a no-op and should stay `off`/`null`
- `SLACK_UPLOAD_TIMEOUT_MS`: timeout for outbound Slack file upload calls
- `SLACK_UPLOAD_MAX_FILES`: max files accepted by one `slack_upload_files` tool call
- `WORKSPACE_TIMEZONE`: timezone used for cron registrations. Defaults to the host timezone and falls back to `UTC` if invalid
- `WEBHOOK_PORT`: local port for authenticated webhook ingress. Default: `3014`
- `WEBHOOK_PATH`: base webhook path. Default: `/webhooks`
- `WEBHOOK_BODY_MAX_BYTES`: max accepted webhook request body size
- `WEBHOOK_BODY_READ_TIMEOUT_MS`: max time to wait for an authenticated webhook request body before returning `408`. Default: `30000`
- `WEBHOOK_PAYLOAD_STORAGE_DIR`: optional raw webhook payload storage override. Default: `WORKSPACE_ROOT/.slack-workers/bridge/webhooks`
- `WEBHOOK_SHARED_SECRET`: optional bootstrap secret for the shared webhook mailbox; if unset, the bridge generates and persists one on first boot
- `WEBHOOK_PREVIOUS_SHARED_SECRET`: optional bootstrap fallback secret accepted during an initial 24-hour overlap window when mailbox state is first created; it is not reapplied after persisted mailbox state exists
- `WEBHOOK_PUBLIC_BASE_URL`: external base URL used when the bridge reports the mailbox endpoint to agents, for example `https://hooks.example.com`

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
  - root workstream request/response items: `WORKSPACE_ROOT/.slack-workers/{active,archive}/`
  - root local read-only projections such as registrations: `WORKSPACE_ROOT/.slack-workers/registrations.json`
  - SQLite and other bridge infra: `WORKSPACE_ROOT/.slack-workers/bridge/`
  - SQLite: `WORKSPACE_ROOT/.slack-workers/bridge/bridge.sqlite`
  - downloaded Slack files: `WORKSPACE_ROOT/.slack-workers/bridge/attachments/`
- You can override those paths explicitly, but the default mental model is “all session state belongs to the workspace.”

- Root `WORKSTREAM.md` and `AGENTS.md` are scaffolded at startup if missing.
- On first bootstrap, the bridge sends each configured admin DM a direct link to the root `#general` workstream so they can join it and start the first top-level thread.
- If legacy default state still lives under `WORKSPACE_ROOT/.slack-codex-workers/` and no explicit path overrides are set, startup migrates it once to `WORKSPACE_ROOT/.slack-workers/`.
- Child workstreams are created explicitly via bridge-owned creation paths and get their own visible directory plus local `.slack-workers/active`, `.slack-workers/archive`, and `registrations.json`.
- Channel roots only create workers in registered workstream-home channels.
- Channel roots create workers keyed by `(teamId, channelId, rootTs)`.
- Each worker keeps a durable workstream request item; completion appends a response item instead of depending only on Slack thread history.
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
- `get_current_time` returns the current UTC time, the configured workspace timezone, and the current local time in that timezone.
- `slack_list_channels` only returns registered workstream channels.
- `slack_spawn_worker` only targets registered workstream channels.
- `slack_create_workstream` is available to workers and the admin DM. It is intended to be used after explicit user approval in the conversation, not behind a separate permission layer.
- `get_webhook_mailbox` returns the shared webhook mailbox URL, current shared secret, accepted auth headers, and the JSON body shape for configuring external systems.
- `rotate_webhook_secret` is available only in the admin DM and rotates the organization-wide shared webhook secret while keeping the previous secret valid for 24 hours.
- `set_heartbeat` only works in a public worker thread and always targets the current worker with `wake_self`.
- `set_cron` and `set_webhook` default to `target='self'`; `target='workstream'` creates future public work in the current workstream.
- `set_cron` expects a 5-field numeric cron string and uses `WORKSPACE_TIMEZONE` when evaluating schedules.
- `list_wake_deliveries` returns runtime wake delivery records in scope, including queued, delivered, failed, and quarantined entries.
- Webhook ingress listens at `WEBHOOK_PATH`, requires either `Authorization: Bearer <secret>` or `x-bridge-webhook-secret`, rate-limits repeated auth failures per client, times out slow authenticated request bodies, and accepts JSON shaped like `{ source, event, id?, match?, payload? }`.
- `/status` and `/health` are available in worker threads and admin DMs. Thread commands report thread-specific state; DM commands report bridge-wide state.
- Thread `/model` and `/effort` set thread-local overrides. DM `/model` and `/effort` set the global defaults used by any thread that does not have an override.
- `/workstream-create` is available in worker threads and admin DMs for explicit bridge-owned creation.
- `/restart <codex|bridge|both>` queues a restart request and waits for the runtime to become idle.
- `/restart-now` forces the currently queued restart immediately.
- `/restart-cancel` clears the currently queued restart.
- `/restart bridge` and `/restart both` only work properly under the launcher/supervisor path because they exit with code `42` and rely on `./scripts/launch.sh` to relaunch the bridge.
- `/recover` is recovery-only; it is available only when the thread or admin DM is blocked or live Codex reconciliation shows the backing thread is missing.
