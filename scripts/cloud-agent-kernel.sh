#!/usr/bin/env bash
# Existing kernel entry for Cloud Agent terminals. Same FastAPI process as desktop.
set -euo pipefail

cd "$(dirname "$0")/.."

export FRIDAY_WORKSPACE_ROOT="${FRIDAY_WORKSPACE_ROOT:-$PWD/.friday-dev}"
export FRIDAY_DATA_DIR="${FRIDAY_DATA_DIR:-$FRIDAY_WORKSPACE_ROOT/data}"

exec .venv/bin/python kernel/main.py
