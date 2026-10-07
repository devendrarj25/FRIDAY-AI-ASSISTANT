# FRIDAY — Build, Release, Version & Update Guide

**Made by:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.0.0.2**

How CMD, TEST, and Official packs are produced and handed to GitHub Releases. Click-by-click: [RELEASE.md](../../../../../RELEASE.md). Version numbers: [VERSIONING.md](../../../../../VERSIONING.md). Workflow YAML: [FRIDAY_GITHUB_ACTIONS.md](../../../../../docs/FRIDAY_GITHUB_ACTIONS.md). This file is the documentation contract for packaging behaviour.

## 1. Three pack paths

| Path | Trigger | Output |
| --- | --- | --- |
| Local CMD | `scripts\build-windows.cmd` / `npm run build:win` | `release\FRIDAY-Setup-1.0.0.2.exe`, `FRIDAY-Portable-1.0.0.2.exe`, `win-unpacked\` |
| TEST | Actions → Test EXE Build | `FRIDAY-Test-Setup-<ver>.exe` as a prerelease |
| Official | Actions → Release / Build `publish` | Setup + Portable + `friday-update.json` + `SHA256SUMS.txt` + `latest.yml` |

All three call `scripts/electron-pack.cjs` with `electron-builder.yml`. Artifact names use the public four-part identity, not npm `1.0.0`. ExtraResources copy kernel + capability trees + scripts (except `cloud-agent-*`).

Local CMD step list: [INSTALL.md](../../../../../INSTALL.md). CMD does not run `npm test`; PR Validation / Test EXE / Official do.

## 2. Rebuild vs update vs auto

Official `mode`:

- **rebuild** — pack the **same version** again and replace GitHub assets.
- **update** — bump, open `release/v…` PR, then publish.
- **auto** — `scripts/release-engine.cjs` chooses from git vs current tag.

Handoff writes identity before pack. Installed apps verify SHA256 from `friday-update.json`.

## 3. Signing

Unsigned is the honest default (`signExecutable: false`). Optional Authenticode: [SECURITY.md](../../../../../SECURITY.md).
