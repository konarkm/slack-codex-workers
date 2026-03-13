#!/usr/bin/env bash
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

CODEX_CWD="${CODEX_CWD:-${ROOT_DIR}}"
CODEX_BIN="${CODEX_BIN:-codex}"
STATE_DIR="${CODEX_CWD}/.slack-codex-workers"
LOCK_DIR="${STATE_DIR}"
LOCK_FILE="${LOCK_DIR}/launcher.lock"
RESTART_EXIT_CODE=42

required_vars=(SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ADMIN_USER_IDS CODEX_CWD)
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env var: ${name}" >&2
    exit 1
  fi
done

mkdir -p "${STATE_DIR}" "${STATE_DIR}/attachments"

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "codex binary not found: ${CODEX_BIN}" >&2
  exit 1
fi
"${CODEX_BIN}" --version >/dev/null

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "slack-codex-workers is already running" >&2
    exit 1
  fi
fi

cd "${ROOT_DIR}"
export SUPERVISOR_RESTART_ENABLED=1
export LAUNCH_MODE="${MODE}"
export CODEX_CWD
export CODEX_BIN

if [[ "${MODE}" == "prod" ]]; then
  npm run build
fi

while true; do
  set +e
  if [[ "${MODE}" == "prod" ]]; then
    node dist/index.js
  else
    npm run dev:run
  fi
  exit_code=$?
  set -e
  if [[ ${exit_code} -ne ${RESTART_EXIT_CODE} ]]; then
    exit ${exit_code}
  fi
  echo "bridge requested restart; relaunching..." >&2
done
