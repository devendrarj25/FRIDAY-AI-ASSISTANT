#!/usr/bin/env bash
# FRIDAY - start one existing workflow and wait for its real outcome.
#
# Official Publish does not call this script. A nested workflow_dispatch runs
# as github-actions[bot], and workflow execution protections refuse that actor
# before any job exists. Official Publish calls the existing workflows with
# workflow_call in the same run. This helper remains for a manual shell, and
# it still fails closed when the run does not succeed.
#
#   ci-workflow-run <workflow.yml> [--ref <ref>] [-f key=value ...]
#
# It fails when the run fails, is cancelled, never starts or never finishes.
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "usage: ci-workflow-run <workflow.yml> [--ref <ref>] [-f key=value ...]"
  exit 0
fi

workflow="${1:?workflow file required}"
shift
ref="main"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift 2 ;;
    -f) args+=(-f "$2"); shift 2 ;;
    *) echo "::error::unknown argument $1"; exit 1 ;;
  esac
done

# Identify the new run by id, not by clock. GitHub's createdAt can be a second
# behind the runner, and a timestamp window then either misses the new run or
# latches onto the previous one.
known=$(gh run list --workflow "$workflow" --event workflow_dispatch --limit 30 \
  --json databaseId --jq '[.[].databaseId | tostring] | join(",")')
echo "starting $workflow on $ref"
gh workflow run "$workflow" --ref "$ref" "${args[@]}"

run_id=""
for _ in $(seq 1 30); do
  sleep 6
  run_id=$(gh run list --workflow "$workflow" --event workflow_dispatch --limit 20 \
    --json databaseId,createdAt \
    | jq -r --arg known "$known" '
        ($known | split(",") | map(select(length > 0))) as $old
        | [ .[] | select((.databaseId | tostring) as $id | ($old | index($id)) | not) ]
        | sort_by(.createdAt) | last | .databaseId // ""
      ')
  [ -n "$run_id" ] && break
done
[ -n "$run_id" ] || { echo "::error::$workflow did not start."; exit 1; }
echo "run: $(gh run view "$run_id" --json url -q .url)"

status=""
conclusion=""
for _ in $(seq 1 720); do
  read -r status conclusion < <(gh run view "$run_id" --json status,conclusion \
    -q '[.status, (.conclusion // "")] | @tsv')
  [ "$status" = "completed" ] && break
  sleep 10
done

if [ "$status" != "completed" ]; then
  echo "::error::$workflow (run $run_id) did not finish in time."
  exit 1
fi
if [ "$conclusion" != "success" ]; then
  echo "::error::$workflow (run $run_id) finished with: $conclusion"
  gh run view "$run_id" || true
  if [ "$conclusion" = "startup_failure" ]; then
    echo "::error::$workflow never queued a job. If the annotation says the actor is not allowed to trigger Actions workflows, the run was started by github-actions[bot]. Call the workflow with workflow_call from the run the owner started."
  fi
  exit 1
fi
echo "$workflow completed successfully (run $run_id)"
