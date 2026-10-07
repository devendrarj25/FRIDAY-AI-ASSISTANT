#!/usr/bin/env bash
# Shared Node selection for Cloud Agent install and start.
# Does not change FRIDAY UI, capabilities, or features.
# Cloud Agent PATH often prefers /exec-daemon/node, which is below the 22.19 floor.

friday_need_node() {
  local bin="${1:-node}"
  command -v "$bin" >/dev/null 2>&1 || return 1
  "$bin" -e "
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
"
}

friday_use_supported_node() {
  if [[ -x /usr/bin/node ]] && friday_need_node /usr/bin/node; then
    export PATH="/usr/bin:${PATH}"
  elif [[ -d "${HOME}/.nvm/versions/node" ]]; then
    local newest
    newest="$(ls -d "${HOME}/.nvm/versions/node"/v22.*/bin 2>/dev/null | sort -V | tail -n1 || true)"
    if [[ -n "${newest}" ]] && friday_need_node "${newest}/node"; then
      export PATH="${newest}:${PATH}"
    fi
  fi
  hash -r || true

  if ! friday_need_node node; then
    echo "[friday] installing Node.js 22 (>=22.19 required by undici@8)"
    local SUDO=""
    if command -v sudo >/dev/null 2>&1; then SUDO=sudo; fi
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
    export PATH="/usr/bin:${PATH}"
    hash -r || true
  fi

  if ! friday_need_node node; then
    echo "[friday] Node $(node -v 2>/dev/null || echo unknown) is too old; need >=22.19.0" >&2
    return 1
  fi

  local bin dir dest
  bin="$(command -v node)"
  dir="$(dirname "$bin")"
  # Agent shells prepend /usr/local/cargo/bin and /exec-daemon after rc files.
  # Linking the supported Node into those directories makes later commands
  # resolve node/npm to >=22.19 without another PATH edit.
  for dest in /usr/local/bin /usr/local/cargo/bin; do
    [[ -d "$dest" ]] || continue
    if [[ -w "$dest" ]]; then
      ln -sfn "$bin" "${dest}/node"
      [[ -x "${dir}/npm" ]] && ln -sfn "${dir}/npm" "${dest}/npm"
      [[ -x "${dir}/npx" ]] && ln -sfn "${dir}/npx" "${dest}/npx"
    elif command -v sudo >/dev/null 2>&1; then
      sudo ln -sfn "$bin" "${dest}/node"
      [[ -x "${dir}/npm" ]] && sudo ln -sfn "${dir}/npm" "${dest}/npm"
      [[ -x "${dir}/npx" ]] && sudo ln -sfn "${dir}/npx" "${dest}/npx"
    fi
  done
  export PATH="/usr/local/bin:${PATH}"
  hash -r || true

  echo "[friday] using Node $(node -v) from ${bin}"
}
