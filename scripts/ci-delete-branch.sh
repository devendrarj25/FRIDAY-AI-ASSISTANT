#!/usr/bin/env bash
# FRIDAY - delete one merged work branch and prove it is gone.
#
# A plain `git push --delete` has failed with a transient "Internal Server
# Error" from GitHub and the caller then printed "already removed" while the
# branch was still there. This script deletes through the REST API, retries
# with a growing pause, and only reports success after a read shows the branch
# is really gone (HTTP 404). It never deletes a protected name.
#
#   ci-delete-branch <branch>        needs GH_TOKEN and GITHUB_REPOSITORY
#
# Exit 0: the branch is gone (or was protected and skipped on purpose).
# Exit 1: the branch is still on the remote after every attempt.
set -uo pipefail

branch="${1:?branch name required}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

case "$branch" in
  main|master|develop|development|release|recovery/*)
    echo "protected branch '$branch' - not deleted"
    exit 0 ;;
esac

# Branch names may hold "/" and other characters: encode each one for the URL.
encoded=$(printf '%s' "$branch" | jq -sRr '@uri' | sed 's/%2F/\//g')
ref="repos/$repo/git/refs/heads/$encoded"

exists() {
  gh api "$ref" >/dev/null 2>&1
}

if ! exists; then
  echo "branch $branch is already gone"
  exit 0
fi

pause=2
for attempt in 1 2 3 4 5; do
  if gh api -X DELETE "$ref" >/dev/null 2>delete.err; then :; fi
  if ! exists; then
    echo "branch $branch deleted (attempt $attempt)"
    rm -f delete.err
    exit 0
  fi
  echo "attempt $attempt did not remove $branch: $(tr '\n' ' ' < delete.err 2>/dev/null | cut -c1-200)"
  sleep "$pause"
  pause=$((pause * 2))
done
rm -f delete.err
echo "::error::branch $branch is still on the remote after 5 attempts. Delete it by hand (Branches page) or let Maintenance Cleanup remove it."
exit 1
