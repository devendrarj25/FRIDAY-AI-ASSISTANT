#!/usr/bin/env bash
# FRIDAY - run one git network command with the workflow token, and nothing more.
#
# The workflows remove the credential the checkout leaves in .git/config before
# the repository's own code runs (npm ci, its scripts, its tests, the build),
# so that code never holds a token that can write. A later fetch, ls-remote or
# push authenticates here, for that one command only: the header lives on the
# command line of this process and is never written to disk or to the config.
#
#   ci-git.sh <git arguments...>     uses GH_TOKEN (or GITHUB_TOKEN) when set
#
# Without a token the command runs as plain git (a public repository can still
# be fetched). The exit code is git's.
set -euo pipefail

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$token" ]; then
  exec git "$@"
fi
server="${GITHUB_SERVER_URL:-https://github.com}"
auth=$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n\r')
exec git -c "http.${server}/.extraheader=AUTHORIZATION: basic ${auth}" "$@"
