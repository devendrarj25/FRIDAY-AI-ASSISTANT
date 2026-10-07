# Install Manager — Production Model

## Pipeline
`discover → inspect manifest → resolve dependencies → download → verify → stage → install → health-check → register → activate`.

## Download
- resumable where useful
- bounded retries
- timeout/backoff
- checksum verification
- size limits
- source allowlist
- cancellation

## Staging
Never install directly into an active component directory.
Use a transaction staging directory, then atomic rename/swap where possible.

## Dependencies
Build a dependency graph and detect:
- missing dependency
- version conflict
- architecture conflict
- circular dependency
- incompatible FRIDAY version

## Repair
A component can be re-verified and repaired from its recorded source/manifest.

## Uninstall
Only remove files owned by the component according to its manifest.
Do not delete shared dependencies until reference counting/usage policy allows it.
