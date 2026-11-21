#!/usr/bin/env bash
# FRIDAY - delete every branch whose work is already entirely in main, and say which.
#
# Used by Branch Cleanup (after an owner merge) and by Safe Merge (after a merge made by the workflow token, which does
# not start Branch Cleanup). The facts come from scripts/ci-branch-state.sh, the decision from
# `scripts/merge-engine.cjs cleanup`, the delete from scripts/ci-delete-branch.sh. Branches only: no release and no
# workflow run is ever planned here. A branch with an open pull request, with a commit main does not have, a protected
# name and recovery/* are never touched. Best effort: the merge already succeeded, so a sweep that cannot read GitHub
# or delete a branch ends with a warning and exit 0 (Maintenance Cleanup is the weekly net).
#
# Needs a full clone (fetch-depth 0), node, jq, GH_TOKEN and GITHUB_REPOSITORY.
set -uo pipefail

if ! bash scripts/ci-branch-state.sh; then
  echo "::warning::could not read the branches and pull requests; the sweep was skipped (Maintenance Cleanup does it weekly)."
  exit 0
fi

echo "[]" > releases.json
echo "[]" > runs.json
if ! node scripts/merge-engine.cjs cleanup \
  --branches branches.json --releases releases.json --runs runs.json \
  --open-prs open-prs.json --merged-prs merged-prs.json > plan.json; then
  echo "::warning::the cleanup plan could not be made; the sweep was skipped."
  exit 0
fi
cat plan.json

deleted=""
for branch in $(jq -r '.branches[]' plan.json); do
  case "$branch" in
    main|master|develop|development|release|recovery/*) continue ;;
  esac
  if bash scripts/ci-delete-branch.sh "$branch"; then
    deleted="$deleted $branch"
  else
    echo "::warning::$branch is fully in main but could not be deleted; Maintenance Cleanup will retry."
  fi
done

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
{
  echo "### Branches removed because their work is already in main"
  echo ""
  echo "${deleted:-none}"
} >> "$summary"
exit 0
