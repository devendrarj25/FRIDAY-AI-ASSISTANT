# FRIDAY — Security Policy

**Current shipping version: 1.0.1.2**

**Owner:** Devendra Singh Meena (`devendrarj25`). Official repository:
https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This file says which line receives fixes, what the app refuses to do, which
GitHub secret names exist, and how to report a flaw in private. How a provider
key is stored is [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md).

## Supported versions

Only the current public line receives security fixes. Older builds are not
maintained. When a fix ships, it ships in that current line.

| Version | Security fixes |
| --- | --- |
| 1.0.1.2 (current) | Yes |
| Older releases | No |

## Scope

FRIDAY is one owner's Windows app. The useful report is a flaw in this
repository: the desktop bridge, secret storage, update checks, workflow
permissions, or a kernel tool that runs without the approval the code
requires. A missing feature, a design choice recorded in
[FRIDAY_STATE.md](FRIDAY_STATE.md), and a public issue that describes an
exploit are outside this policy.

## What the app keeps closed

The renderer does not spawn arbitrary processes. `electron/preload.cjs`
exposes an allowlisted `window.friday` bridge. Chat and tools go through the
main process. Exec-tier kernel tools (`kernel/tools.py`) wait for desktop
approval. `config/kernel.yaml` sets `automation.auto_approve_exec: false`.

The privacy firewall (`electron/privacy-firewall.cjs`) hard-stops SENSITIVE
data: secrets, keys, and identity or financial numbers. Other content may use
an already-connected provider.

The billing firewall (`electron/billing-firewall.cjs`) does not make a paid
model a silent default.

Publisher identity cannot be changed from Settings or chat
(`src/lib/friday/brain/identity.ts` `lockedIdentityFields`).

## GitHub Secrets

| Name | Use |
| --- | --- |
| `WINDOWS_SIGNING_CERTIFICATE_BASE64` | Authenticode when Official / Test EXE signing is enabled |
| `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` | PFX password for that certificate |

Do not put tokens in Markdown, workflow logs, or chat. Workflows use least privilege per job (`permissions:` in each YAML). Auto-merge is disabled.
Dependabot and Safe Merge both wait for an explicit owner action.

## Update integrity

A GitHub release update checks SHA256 against `friday-update.json` and
`SHA256SUMS.txt` before install. Rollback is described in
[docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md) and
`electron/update-safety.cjs`. User data under the FRIDAY root is not deleted
by an update.

## Reporting

Do not file a public GitHub issue for a live vulnerability. Do not include a
proof of concept in a public place.

Use the private report form:
https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/security/advisories/new

That form asks for a summary, what is affected, how to reproduce it, and the
impact. The owner reads it. A fix, when one is made, ships on the current
line. The report itself stays private. If the form is unavailable, still do
not open a public issue. The non-sensitive hardening form under
`.github/ISSUE_TEMPLATE/` is only for work that is not an exploitable flaw.
