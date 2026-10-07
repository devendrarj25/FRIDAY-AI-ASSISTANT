# Windows CMD Runbook

From a clean checkout:

```bat
npm ci --no-audit --no-fund
npm run check-engines
npm run verify:deps
npm run verify:version
npm run build:windows
```

The exact command names must follow the repository's actual package.json scripts. The key contract is that the local path invokes the same underlying release/build implementation as CI.

For a REBUILD, select rebuild intent without changing `config/friday-version.json`.
For an UPDATE, use the release engine to change the canonical version and synchronize all generated release-facing files.
