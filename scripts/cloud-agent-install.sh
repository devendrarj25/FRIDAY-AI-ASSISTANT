#!/usr/bin/env bash
# Cloud Agent bootstrap only. Does not change FRIDAY UI, capabilities, or features.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-path.sh
source "$(dirname "$0")/cloud-agent-path.sh"

friday_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "[friday] root is required to run: $*" >&2
    return 1
  fi
}

version_ge() {
  [[ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

friday_use_supported_node

if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12, 10) else 1)' 2>/dev/null; then
  echo "[friday] installing Python >= 3.12.10"
  friday_sudo apt-get update
  friday_sudo apt-get install -y --no-install-recommends software-properties-common ca-certificates gnupg
  friday_sudo add-apt-repository -y ppa:deadsnakes/ppa
  friday_sudo apt-get update
  friday_sudo apt-get install -y --no-install-recommends python3.13 python3.13-venv python3.13-dev build-essential
  friday_sudo ln -sfn /usr/bin/python3.13 /usr/local/bin/python3
  friday_sudo ln -sfn /usr/bin/python3.13 /usr/local/bin/python
  hash -r || true
fi

export PATH="/usr/local/bin:${PATH}"
hash -r || true
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12, 10) else 1)'; then
  echo "[friday] Python $(python3 --version 2>/dev/null || echo unknown) is below 3.12.10" >&2
  exit 1
fi
echo "[friday] using Python $(python3 --version) from $(command -v python3)"

sqlite_now="$(python3 -c 'import sqlite3; print(sqlite3.sqlite_version)' 2>/dev/null || echo 0)"
if ! version_ge "$sqlite_now" "3.45.3"; then
  echo "[friday] building SQLite >= 3.45.3 (python reports ${sqlite_now})"
  friday_sudo apt-get update
  friday_sudo apt-get install -y --no-install-recommends build-essential
  sqlite_tmp="$(mktemp -d)"
  curl -fsSL -o "${sqlite_tmp}/sqlite.tar.gz" "https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz"
  tar -xzf "${sqlite_tmp}/sqlite.tar.gz" -C "$sqlite_tmp"
  (
    cd "${sqlite_tmp}/sqlite-autoconf-3530400"
    ./configure --prefix=/usr/local
    make -j"$(nproc)"
    friday_sudo make install
  )
  friday_sudo ldconfig
  rm -rf "$sqlite_tmp"
  sqlite_now="$(python3 -c 'import sqlite3; print(sqlite3.sqlite_version)' 2>/dev/null || echo 0)"
  if ! version_ge "$sqlite_now" "3.45.3"; then
    echo "[friday] SQLite still ${sqlite_now} after install" >&2
    exit 1
  fi
fi
echo "[friday] SQLite ${sqlite_now}"

git_now="$(git --version | awk '{print $3}')"
if ! version_ge "$git_now" "2.49.0"; then
  echo "[friday] installing Git >= 2.49.0 (found ${git_now})"
  friday_sudo apt-get update
  friday_sudo apt-get install -y --no-install-recommends software-properties-common ca-certificates gnupg
  friday_sudo add-apt-repository -y ppa:git-core/ppa
  friday_sudo apt-get update
  friday_sudo apt-get install -y git
  git_now="$(git --version | awk '{print $3}')"
  if ! version_ge "$git_now" "2.49.0"; then
    echo "[friday] Git still ${git_now}" >&2
    exit 1
  fi
fi
echo "[friday] Git ${git_now}"

npm ci
npm run setup:python
npm run setup:electron
npm run init:runtime
