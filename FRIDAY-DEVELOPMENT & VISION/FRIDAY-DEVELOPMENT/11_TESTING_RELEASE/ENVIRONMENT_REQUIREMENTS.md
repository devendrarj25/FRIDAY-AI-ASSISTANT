# Clean Validation Environment Requirements

Single source of truth for these numbers is
[`config/toolchain-versions.json`](../../../config/toolchain-versions.json)
(repo root `config/`) — read it, don't hardcode a copy that can drift. At
the time this was written:

| Tool | Minimum |
|---|---|
| Node.js | 22.19.0 |
| npm | 10.9.0 |
| Python | 3.12.10 |
| SQLite | 3.45.3 |
| Git | 2.49.0 |
| PowerShell | 7.5.0 |
| Electron | 43.0.0 |

CI derives Node/npm from this same file automatically
(`.github/actions/friday-node`) — never hardcode a Node version in a
workflow.

## Clean-environment validation sequence (SOURCE_READY — see `VALIDATION_STATES.md`)

```
npm ci            # or `npm install` if a lockfile-strict install isn't available
npm run typecheck
npm run lint
npm test          # npx vitest run
```

For anything touching `kernel/`, also run the Python test suite with a
Python meeting the minimum above (`npm run test:kernel` or the repo's
pytest entrypoint).

## What a failure here means — and what it doesn't
- **Dependency install fails** (network blocked, registry unreachable,
  incompatible Node/npm/Python on the machine) → environment problem.
  Report it as an environment limitation, not as "the ZIP/source is
  broken." Say what was missing (tool, version, network) so the owner can
  fix the actual cause.
- **`npm ci`/`npm install` succeeds but a test needs something a sandbox
  doesn't have** (real `git` history, real outbound network, a specific
  OS binary) → also an environment limitation, not a source defect — name
  the missing capability specifically instead of a generic "test failed."
- **A test fails after a real, successful clean install with all tools
  present** → this is a real signal. Investigate and fix, or report as a
  genuine BLOCK with the actual error.

## What not to do
Do not edit application source, tests, or configuration just to make a
clean-environment run pass when the actual cause is a missing tool or
sandbox limitation. Fixing the environment description (this file) or
skipping/marking a test as environment-dependent (with a comment saying
why) is correct; silently changing behavior to dodge a failure is not.
