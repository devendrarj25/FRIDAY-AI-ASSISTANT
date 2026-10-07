# Recovery Architecture

Recovery must work when the normal app cannot start.

## Recovery entry
A minimal updater/recovery executable/process should be able to:
- inspect transaction journal
- detect incomplete update
- restore last known good application payload
- validate registry/manifests
- repair missing official files
- launch diagnostics
- roll back a failed migration

## Last-known-good
Persist a small verified record:
`version + artifact hash + health result + migration state`.

## Do not
Rely on the main FRIDAY UI to repair a broken main FRIDAY UI.
