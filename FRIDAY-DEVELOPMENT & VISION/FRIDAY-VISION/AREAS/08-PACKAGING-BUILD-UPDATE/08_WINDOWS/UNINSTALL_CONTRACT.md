# Uninstall Contract

Provide two explicit modes:

## Uninstall application, keep FRIDAY data
Remove application/integration artifacts while preserving the FRIDAY data/component ecosystem for reinstall/recovery, according to the chosen root retention policy.

## Uninstall + Remove All FRIDAY Data
After explicit confirmation:
1. stop FRIDAY processes/services started by FRIDAY
2. close update transactions
3. verify FRIDAY root ownership/manifest
4. remove FRIDAY-managed application, runtimes, components, models, packages, downloads, data, cache, logs, updater and recovery content
5. remove FRIDAY-created shortcuts/uninstall integration
6. verify the root is gone or report exactly what remains and why

Never perform a recursive delete outside the verified FRIDAY root merely because a path contains a string such as `FRIDAY`.
