# FRIDAY — Security Policy

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Current shipping version: 1.1.4.6**

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
| 1.1.4.6 (current) | Yes |
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
exposes an allowlisted `window.friday` bridge. Every channel that bridge
calls has a handler in the main process. Chat and tools go through the
main process. Exec-tier kernel tools (`kernel/tools.py`) wait for desktop
approval. `config/kernel.yaml` sets `automation.auto_approve_exec: false`.

Each FRIDAY window sets `contextIsolation`, turns `nodeIntegration` off, and
sets `sandbox`. `no-sandbox` is only the boot self-test switch. The window
may navigate to `friday://app` or the dev-server origin
(`electron/navigation-policy.cjs`). A new window is denied and opened
outside the app. The session grants `media` and denies every other
permission. The packaged page sends a report-only Content-Security-Policy
(`electron/csp.cjs`). Enforcing mode stays off unless `FRIDAY_CSP_ENFORCE=1`.
Violations show in the Doctor.

The privacy firewall (`electron/privacy-firewall.cjs`) hard-stops SENSITIVE
data: secrets, keys, and identity or financial numbers. Other content may use
an already-connected provider.

The billing firewall (`electron/billing-firewall.cjs`) does not make a paid
model a silent default.

`kernel/env_guard.py` `guard_public_url` refuses a non-public address after
resolving the host. Production uses `socket.getaddrinfo`. A test passes a
fake resolver. The kernel suite refuses a public DNS lookup or a public
connect unless that test's node id is listed in `kernel/tests/NETWORK_ALLOW.txt`.

Publisher identity cannot be changed from Settings or chat
(`src/lib/friday/brain/identity.ts` `lockedIdentityFields`).

## Agent risks (OWASP Top 10 for Agentic Applications, December 2025)

Each risk has a control in this repository and a test that fails if the control goes. The titles of ASI01, ASI02,
ASI06, ASI09 and ASI10 were read from the OWASP project's published list on 2026-10-31; the titles of ASI03,
ASI04, ASI05, ASI07 and ASI08 are given from memory and were not re-read, so check them against the official page.

| Risk | Control | Test |
| --- | --- | --- |
| ASI01 Agent goal hijack | Text from a page, file, screen, mail or tool is data. Order-like lines are cut by the quarantined reader in the app and in the kernel before a model reads them; the approval gate and the argument policy stand behind it | `core/__tests__/quarantined-reader.test.ts`, `kernel/tests/test_quarantine.py`, `core/__tests__/turn-spine.test.ts` |
| ASI02 Tool misuse | Every tool call is checked against its schema, then against a deterministic argument policy, then needs a signed single-use authorization for anything above the safe tier | `kernel/tests/test_arg_policy.py`, `kernel/tests/test_authority.py` |
| ASI03 Identity and privilege abuse | An approval is bound to one action, one target and one argument hash, expires, is checked again right before the action and is used up | `core/__tests__/code-context.test.ts`, `core/__tests__/governance-gate.test.ts` |
| ASI04 Agentic supply chain | Installers are pinned to a published digest, advisories are audited, optional modules are recorded with their source | `core/__tests__/vendor-sources.test.ts`, `core/__tests__/advisory-audit.test.ts` |
| ASI05 Unexpected code execution | Code runs only in a scratch sandbox or after exec-tier approval; own-source changes are tried on a throwaway copy first | `kernel/tests/test_sandbox_runner.py`, `kernel/tests/test_dev_check.py` |
| ASI06 Memory and context poisoning | Writes pass admission (replay, poison, identity and sensitive-attribute rules); an old fact is invalidated with its reason, never silently overwritten; a forgotten fact stays forgotten in projections | `core/__tests__/memory-knowledge-fabric.test.ts`, `core/__tests__/memory-as-of.test.ts` |
| ASI07 Insecure inter-agent communication | A message between agents is data, length-capped, labelled as another agent's text, and the sender must be enrolled | `core/__tests__/agent-delegation.test.ts` |
| ASI08 Cascading failures | One repair per run, bounded retries, Stop everything halts all work, the failed turn says what happens next | `core/__tests__/verify-repair.test.ts`, `core/__tests__/failure-text.test.ts` |
| ASI09 Human-agent trust exploitation | She never claims to be human, labels what is verified and what is not, and reports a result only when a check passed | `core/__tests__/benchmark-bank.test.ts`, `core/__tests__/docs-honesty.test.ts` |
| ASI10 Rogue agents | Governance gates every self-change; the files that decide whether she may act are protected from self-development; changes are undoable | `core/__tests__/governance-gate.test.ts`, `core/__tests__/project-governance.test.ts` |

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
