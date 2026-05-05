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
- The final completion message mentions the root human owner by default, unless the worker explicitly opts out for that turn.
- Admin DMs provide a control surface for defaults and bridge operations.
- Each spawned worker writes one durable local request item and, at most once, one durable terminal response item inside its workstream.

## Current Scope

Implemented in this repo:

- single-workspace Bolt Socket Mode bridge
- SQLite persistence for workstream registry, worker mappings, DM sessions, defaults, cached channels, durable inbound message state, attachment metadata, registrations, pending wakes, and webhook events
- one shared `codex app-server` subprocess
- root workstream bootstrap under `WORKSPACE_ROOT`
- explicit workstream scaffolding under nested directories with `WORKSTREAM.md`, `AGENTS.md`, and local `.slack-workers/`
- canonical workstream item landing for new public work
- durable heartbeat / cron / webhook registrations with wake-self delivery, steer-style webhook delivery, and scheduled workstream spawns
- raw webhook ingress with source-specific secret routes, durable raw request storage, normalized event dedupe, and agent-authored handler modules
- worker dynamic tools:
  - `slack_list_channels`
  - `list_workstreams`
  - `slack_spawn_worker`
  - `slack_create_workstream`
  - `slack_upload_files`
  - `get_current_time`
  - `get_current_slack_thread_link`
  - `create_webhook_source`
  - `list_webhook_sources`
  - `get_webhook_source`
  - `list_webhook_registrations`
  - `disable_webhook_source`
  - `rotate_webhook_source_route`
  - `set_notification`
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
  - `create_webhook_source`
  - `list_webhook_sources`
  - `get_webhook_source`
  - `list_webhook_registrations`
  - `disable_webhook_source`
  - `rotate_webhook_source_route`
  - `list_registrations_admin`
  - `get_registration_admin`
  - `disable_registration_admin`
  - `list_wake_deliveries_admin`
  - `archive_workstream_admin`
- channel-thread commands:
  - `.help` / `/help`
  - `.status` / `/status`
  - `.health` / `/health`
  - `.model` / `/model`
  - `.effort` / `/effort`
  - `.compact` / `/compact`
  - `.stop` / `/stop`
  - `.recover` / `/recover`
  - `.workstream-create <slug> [parent=<path>] [channel=<name>] [description...]` / `/workstream-create <slug> [parent=<path>] [channel=<name>] [description...]`
- admin DM commands:
  - `.help` / `/help`
  - `.status` / `/status`
  - `.health` / `/health`
  - `.model` / `/model`
  - `.effort` / `/effort`
  - `.compact` / `/compact`
  - `.new-thread` / `/new-thread`
  - `.stop` / `/stop`
  - `.recover` / `/recover`
  - `.restart <codex|bridge|both>` / `/restart <codex|bridge|both>`
  - `.restart-now` / `/restart-now`
  - `.restart-cancel` / `/restart-cancel`
  - `.workstream-create <slug> [parent=<path>] [channel=<name>] [description...]` / `/workstream-create <slug> [parent=<path>] [channel=<name>] [description...]`
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

## Trust Model

This bridge is designed for a trusted local machine and workspace. Codex worker and admin threads currently run from `WORKSPACE_ROOT` with non-interactive approval and full local filesystem access, not a filesystem sandbox limited to that directory. Only connect it to Slack workspaces and admin users you trust, and treat local files, webhook handlers, and uploaded artifacts as accessible to the running workers.

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
- `SHOW_SLACK_WORKLOG`: when enabled, stream completed tool/worklog items like `Run command: ...` into Slack. Default: off, so only assistant messages and final responses are shown.
- `WORKSPACE_TIMEZONE`: timezone used for cron registrations. Defaults to the host timezone and falls back to `UTC` if invalid
- `WEBHOOK_PORT`: local port for webhook ingress. Default: `3014`
- `WEBHOOK_BIND_HOST`: bind host for webhook ingress. Default: `127.0.0.1`
- `WEBHOOK_PATH`: base webhook path prefix used for source-specific secret routes. Default: `/webhooks`
- `WEBHOOK_BODY_MAX_BYTES`: max accepted webhook request body size
- `WEBHOOK_BODY_READ_TIMEOUT_MS`: max time to wait for a webhook request body before returning `408`. Default: `30000`
- `WEBHOOK_TRUST_LOOPBACK_PROXY`: when enabled, trust `CF-Connecting-IP` and then `X-Forwarded-For` only if the immediate peer is loopback. Recommended for local `cloudflared` on the same machine.
- `WEBHOOK_PAYLOAD_STORAGE_DIR`: optional raw request and normalized webhook event storage override. Default: `WORKSPACE_ROOT/.slack-workers/bridge/webhooks`
- `WEBHOOK_PUBLIC_BASE_URL`: external base URL used when the bridge reports source public URLs to agents, for example `https://hooks.example.com`

## Run

This project is currently run from source and is not packaged for npm distribution.

```bash
npm ci
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
- Each worker keeps a durable workstream request item; the first `completed` or `failed` outcome writes one durable response item instead of depending only on Slack thread history.
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
- `get_current_slack_thread_link` is worker-only and returns JSON containing the exact permalink for the current public Slack thread root plus `team_id`, `channel_id`, and `root_ts`.
- `slack_list_channels` only returns registered workstream channels.
- `list_workstreams` returns active registered workstreams as `path (#channel, channel_id)` and is the preferred discovery surface for visible child work.
- `slack_spawn_worker` targets workstreams, not Slack channels. Omit `workstream` to target the current workstream, or pass a canonical workstream relative path such as `customers/ef`.
- `slack_create_workstream` is available to workers and the admin DM. It is intended to be used after explicit user approval in the conversation, not behind a separate permission layer.
- `create_webhook_source`, `list_webhook_sources`, `get_webhook_source`, `disable_webhook_source`, and `rotate_webhook_source_route` manage workspace-global raw webhook source definitions. Each source has one source name, one secret route, and one handler file.
- `list_webhook_registrations` lists all registrations in the workspace that currently depend on one webhook source so agents can preserve existing event names, normalized match fields, and delivery behavior before changing a shared handler contract.
- `set_notification(enabled: true|false)` is worker-only and turn-scoped. Final worker replies mention the root owner by default; workers should call `set_notification(enabled: false)` only when they are still progressing autonomously and there is nothing the human needs to notice or do yet. Heartbeat/cron/webhook-driven work should lean toward opting out only while it is still progressing independently without user-relevant outcomes.
- `set_heartbeat` only works in a public worker thread and always targets the current worker with `wake_self`.
- `set_cron` defaults to `target='self'`.
- `set_webhook` defaults to `target='self'` and `deliveryMode='queue'`.
- `set_webhook(target='self')` accepts `deliveryMode='queue' | 'steer'`. Queue creates separate wake work; steer forwards matching events into the current turn with app-server `turn/steer` when a turn is active and starts a fresh turn when idle.
- `set_webhook(target='workstream')` creates future public work in the current workstream and only supports queue-style delivery.
- When visible child work is spawned into a workstream, the root Slack post includes the scheduled or delegated title plus the full AI input body for that spawned worker.
- When `target='self'` wake work is actually delivered to a worker, the bridge posts a system message in the Slack thread showing the exact wake input sent to Codex.
- `set_cron` expects a 5-field numeric cron string and uses `WORKSPACE_TIMEZONE` when evaluating schedules.
- `list_wake_deliveries` returns runtime wake delivery records in scope, including queued, delivered, failed, and quarantined entries.
- Webhook ingress listens under `WEBHOOK_PATH`, resolves requests by source-specific secret route tokens, rate-limits repeated handler auth failures per client, times out slow request bodies, and hands raw request bodies plus best-effort parsed JSON to the source handler.
- For a local Cloudflare Tunnel deployment, prefer `WEBHOOK_BIND_HOST=127.0.0.1`, set `WEBHOOK_PUBLIC_BASE_URL` to the public hostname, and enable `WEBHOOK_TRUST_LOOPBACK_PROXY=1` so auth throttling can key off Cloudflare-forwarded client IPs only when the immediate peer is local.
- `/status` and `/health` are available in worker threads and admin DMs. Thread commands report thread-specific state; DM commands report bridge-wide state.
- Dot-command aliases such as `.status`, `.health`, `.restart`, and `.workstream-create` are supported everywhere the slash commands are supported. In the Slack client, dot commands are the most reliable form because some slash commands collide with Slack's built-in command UI. If you still prefer slash commands, a leading space also works because the bridge trims message text before parsing.
- Thread `/model` and `/effort` set thread-local overrides. DM `/model` and `/effort` set the global defaults used by any thread that does not have an override.
- `/workstream-create` is available in worker threads and admin DMs for explicit bridge-owned creation. `slug` defines the canonical workstream path segment. `channel=<name>` optionally sets the explicit Slack channel name; if omitted it defaults to `slug`. Both may only use letters, numbers, hyphen, or underscore, and the runtime normalizes them to lowercase.
- `/workstream-archive` is available in the admin DM to archive a child workstream, disable its registrations, quarantine pending wakes, and remove it from live routing while keeping the local scaffold on disk.
- `/restart <codex|bridge|both>` queues a restart request and waits for the runtime to become idle.
- `/restart-now` forces the currently queued restart immediately.
- `/restart-cancel` clears the currently queued restart.
- `/restart bridge` and `/restart both` only work properly under the launcher/supervisor path because they exit with code `42` and rely on `./scripts/launch.sh` to relaunch the bridge.
- `/new-thread` immediately attaches the admin DM to a fresh backing Codex thread while preserving the DM's current settings; use it after deploys when you want a fresh admin tool surface.
- `/recover` is recovery-only; it is available only when the thread or admin DM is blocked or live Codex reconciliation shows the backing thread is missing.
