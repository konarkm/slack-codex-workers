#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${ROOT_DIR}/.run"
LOCK_FILE="${LOCK_DIR}/service.lock"
RESTART_EXIT_CODE=42

mkdir -p "${LOCK_DIR}"

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "slack-codex-workers is already running" >&2
    exit 1
  fi
fi

cd "${ROOT_DIR}"

while true; do
  set +e
  node dist/index.js
  exit_code=$?
  set -e
  if [[ ${exit_code} -ne ${RESTART_EXIT_CODE} ]]; then
    exit ${exit_code}
  fi
  echo "bridge requested restart; relaunching..." >&2
done
