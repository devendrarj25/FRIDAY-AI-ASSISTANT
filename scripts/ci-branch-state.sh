#!/usr/bin/env bash
# FRIDAY - collect what branch cleanup needs to decide, as three JSON files in the current directory.
#
#   branches.json    [{ "name", "sha", "merged" }] for every branch on origin; merged is true when the tip is an
#                    ancestor of origin/main (a normal merge)
#   open-prs.json    [{ "headRefName" }] for every open pull request: live work, never deleted
#   merged-prs.json  [{ "headRefName", "headRefOid", "isCrossRepository" }] for pull requests merged into main, so a
#                    squash- or rebase-merged branch (never an ancestor of main) is still recognised: its tip is
#                    exactly the head commit that was merged
#
# The decision itself is scripts/merge-engine.cjs `cleanup`; nothing here deletes anything.
# Needs a full clone (fetch-depth 0), jq, and GH_TOKEN + GITHUB_REPOSITORY for gh.
set -euo pipefail

git fetch origin --prune --quiet

: > branches.ndjson
while read -r ref sha; do
  name="${ref#refs/remotes/origin/}"
  [ "$name" = "HEAD" ] && continue
  merged=false
  git merge-base --is-ancestor "$sha" origin/main 2>/dev/null && merged=true
  jq -nc --arg name "$name" --arg sha "$sha" --argjson merged "$merged" \
    '{name: $name, sha: $sha, merged: $merged}' >> branches.ndjson
done < <(git for-each-ref --format='%(refname) %(objectname)' refs/remotes/origin)
jq -s '.' branches.ndjson > branches.json
rm -f branches.ndjson

# Open pull requests pin their head branch: cleanup must never delete a branch Safe Merge / FRIDAY Release is still
# working on, or one the owner is still reviewing.
gh pr list --state open --limit 200 --json headRefName > open-prs.json
gh pr list --state merged --base main --limit 300 --json headRefName,headRefOid,isCrossRepository > merged-prs.json

echo "branches: $(jq 'length' branches.json), open pull requests: $(jq 'length' open-prs.json), merged pull requests read: $(jq 'length' merged-prs.json)"
