#!/usr/bin/env bash
# Per-boot Cloud Agent start. Does not change FRIDAY UI or features.
# Starts the existing Vite renderer and FastAPI kernel when they are not already up.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-path.sh
source "$(dirname "$0")/cloud-agent-path.sh"
friday_use_supported_node

mkdir -p temporary/downloads

export FRIDAY_WORKSPACE_ROOT="${FRIDAY_WORKSPACE_ROOT:-$PWD/.friday-dev}"
export FRIDAY_DATA_DIR="${FRIDAY_DATA_DIR:-$FRIDAY_WORKSPACE_ROOT/data}"

if [[ ! -d node_modules ]]; then
  echo "[friday] node_modules missing — run the install script first" >&2
  exit 1
fi

if [[ ! -x .venv/bin/python ]]; then
  echo "[friday] .venv missing — run the install script first" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "[friday] tmux is required to start the renderer and kernel" >&2
  exit 1
fi

start_session() {
  local name="$1"
  shift
  if tmux has-session -t "$name" 2>/dev/null; then
    echo "[friday] ${name} already running"
    return 0
  fi
  tmux new-session -d -s "$name" -c "$PWD" \
    -e "PATH=${PATH}" \
    -e "FRIDAY_WORKSPACE_ROOT=${FRIDAY_WORKSPACE_ROOT}" \
    -e "FRIDAY_DATA_DIR=${FRIDAY_DATA_DIR}" \
    -- "$@"
  echo "[friday] started ${name}"
}

start_session dev npm run dev
start_session kernel bash scripts/cloud-agent-kernel.sh

wait_http() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 90); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then
      echo "[friday] ready ${url}"
      return 0
    fi
    sleep 2
  done
  echo "[friday] timed out waiting for ${url}" >&2
  return 1
}

wait_http "http://127.0.0.1:8765/health"
wait_http "http://127.0.0.1:8080/"
echo "[friday] environment ready (renderer :8080, kernel :8765)"
