#!/usr/bin/env bash
# Runs the agent hub and keeps it running. --prod builds first and runs the compiled output.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="dev"
if [[ "${1:-}" == "--prod" ]]; then
  MODE="prod"
fi

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

export AGENTS_STATE_ROOT="${AGENTS_STATE_ROOT:-${HOME}/.slack-agents}"
if [[ ! -f "${AGENTS_FILE:-${AGENTS_STATE_ROOT}/agents.json}" ]]; then
  echo "no agent registry at ${AGENTS_FILE:-${AGENTS_STATE_ROOT}/agents.json}; copy agents.example.json there and edit it" >&2
  exit 1
fi

mkdir -p "${AGENTS_STATE_ROOT}"
# Two hubs on one state root would each take half the Slack events and deliver every input twice.
# mkdir is atomic everywhere; macOS has no flock.
LOCK_DIR="${AGENTS_STATE_ROOT}/launcher.lock"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  other="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [[ -n "${other}" ]] && kill -0 "${other}" 2>/dev/null; then
    echo "the agent hub is already running (pid ${other})" >&2
    exit 1
  fi
  echo "removing a stale launcher lock" >&2
fi
echo $$ > "${LOCK_DIR}/pid"
trap 'rm -rf "${LOCK_DIR}"' EXIT

cd "${ROOT_DIR}"
if [[ "${MODE}" == "prod" ]]; then
  npm run build
fi

# A crash restarts the hub after a pause; agents resume their sessions and queued input. A clean exit stops the loop.
while true; do
  set +e
  if [[ "${MODE}" == "prod" ]]; then
    node dist/agents/main.js
  else
    npx tsx src/agents/main.ts
  fi
  code=$?
  set -e
  if [[ ${code} -eq 0 ]]; then
    exit 0
  fi
  echo "agent hub exited with code ${code}; restarting in 5s" >&2
  sleep 5
done
