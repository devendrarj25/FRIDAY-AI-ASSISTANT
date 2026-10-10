# FRIDAY — Documentation Index

**Current shipping version: 1.0.1.2**
**Owner:** Devendra Singh Meena (`devendrarj25`)

📚 Every official document is listed once, under the question it answers. The table is generated from `scripts/docs-engine.cjs`. Do not hand-edit that table. After a document change, run `npm run docs:sync` then `npm run docs:check`.

One topic per file. If you need another topic, open its document. Do not paste its paragraphs here.

---
<!-- docs-engine: generated index. Edit scripts/docs-engine.cjs, not this. -->

## 1. Start here

| Document | Answers | For |
| --- | --- | --- |
| [README.md](../README.md) | What FRIDAY is, who owns it, how to get it, and which document to open next | everyone |
| [INSTALL.md](../INSTALL.md) | Published Setup and Portable, every owner-facing CMD/npm command, toolchain download fallbacks, isolated runtime layout, first-launch so Chat Manual/Auto/voice/local engines work, then upgrade and uninstall | owner |
| [docs/FRIDAY_USER_GUIDE.md](FRIDAY_USER_GUIDE.md) | How to use the running desktop app, section by section, plus troubleshooting | owner |
| [docs/FRIDAY_FEATURES.md](FRIDAY_FEATURES.md) | Every shipped capability, the file that implements it, and the test that covers it | owner, AI tools |
| [docs/FRIDAY_IMPORT_FORMAT.md](FRIDAY_IMPORT_FORMAT.md) | JSON manifests for importing a skill, tool, module, plugin, workflow or agent, and what Import & Build does next | owner, AI tools |

## 2. Architecture and data

| Document | Answers | For |
| --- | --- | --- |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Process layers, the allowlisted IPC surface, and how renderer, main, and kernel meet | developers, AI tools |
| [docs/FRIDAY_ARCHITECTURE_BASELINE.md](FRIDAY_ARCHITECTURE_BASELINE.md) | The locked folder and subsystem baseline the architecture audit enforces | developers, AI tools |
| [docs/FRIDAY_MASTER_FLOW.md](FRIDAY_MASTER_FLOW.md) | The owner operating loop and which live module owns each stage | developers, AI tools |
| [docs/FRIDAY_STORAGE_CONTRACT.md](FRIDAY_STORAGE_CONTRACT.md) | The single FRIDAY root, what Setup may replace, and what uninstall may delete | developers, AI tools |
| [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](FRIDAY_PROVIDERS_AND_SECRETS.md) | Local model engines, cloud providers, encrypted keys, billing firewall, and privacy egress | owner, developers |
| [docs/FRIDAY_MCP.md](FRIDAY_MCP.md) | How FRIDAY speaks MCP as a local server and as a client, including pairing, scopes, and the exposed tools | owner, developers |

## 3. Build, version, release and update

| Document | Answers | For |
| --- | --- | --- |
| [docs/FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md) | CMD, TEST, and Official packs, the TEST Windows identity, and how an installed copy chooses Stable or Test | owner |
| [VERSIONING.md](../VERSIONING.md) | The one public version, the npm encoding, counters that keep counting, and when a failed or auto run keeps its number | owner, AI tools |
| [RELEASE.md](../RELEASE.md) | Click-by-click Official, TEST, and local CMD release steps with pre-flight checks | owner |
| [docs/FRIDAY_GITHUB_ACTIONS.md](FRIDAY_GITHUB_ACTIONS.md) | Every repository workflow: filename, trigger, inputs, permissions, how to run it | owner, AI tools |

## 4. Repository governance

| Document | Answers | For |
| --- | --- | --- |
| [docs/FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md) | How a change reaches main, how Safe Merge, cleanup, and Repository Control behave, and why an official release stays a separate step | owner, AI tools |
| [docs/FRIDAY_CHANGE_CONTROL.md](FRIDAY_CHANGE_CONTROL.md) | How a change is classified, bounded, tested, and recorded, and which product module owns each development contract | owner, AI tools |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How a human contributor branches, verifies, and updates documents in the same PR | developers, AI tools |
| [SECURITY.md](../SECURITY.md) | Threat model, GitHub Secrets, workflow least privilege, and how to report a flaw | owner, developers |
| [LICENSE](../LICENSE) | Ownership, personal-use rights, contribution, no-redistribution and attribution terms | everyone |
| [CHANGELOG.md](../CHANGELOG.md) | Published What's New for each version, in plain language, on the current public line | everyone |
| [AUDIT.md](../AUDIT.md) | What is verified versus not, with the command or release that is the evidence | owner, AI tools |

## 5. Working sessions (humans and AI tools)

| Document | Answers | For |
| --- | --- | --- |
| [FRIDAY_STATE.md](../FRIDAY_STATE.md) | Live briefing for a new session: architecture snapshot, counts, decisions, next priorities | AI tools (current facts, after the session rules) |
| [AGENTS.md](../AGENTS.md) | The upgrade flow for AI tools: one pull request, keep what works, fix a locked-area bug without breaking it, same-change tests and docs, owner merges | AI tools |

## 6. Document roles

Every registered document is the **canonical** write-up for its topic unless
the table below says otherwise. Generated files are not registered. Per-release
notes keep the version they were published with.

| Role | Meaning | Documents |
| --- | --- | --- |
| history | Published What's New, in plain language, on the current public line; once published, a section is not rewritten | `CHANGELOG.md` |
| developer | Contributor, audit, and repository-governance procedure | `docs/FRIDAY_MERGE_FLOW.md`, `docs/FRIDAY_CHANGE_CONTROL.md`, `CONTRIBUTING.md`, `AUDIT.md` |
| session | Live working briefing for humans and AI tools | `FRIDAY_STATE.md`, `AGENTS.md` |
| legal | Licence and ownership terms | `LICENSE` |

Generated (not registered): `docs/README.md` (this index) and
`releases/notes/vX.Y.Z.md` (per-release What's New). Transient:
`release-notes.md` at the repo root during publish — never a committed document.

## 7. Release notes

`releases/notes/vX.Y.Z.md` holds the published What's New for each release; the
same body is prepended to [../CHANGELOG.md](../CHANGELOG.md) by the release
workflow. These files are generated per release and are deliberately not part
of the registry.

## 8. How this index stays true

This section and the documentation map in [../README.md](../README.md) are both
generated from the single registry in `scripts/docs-engine.cjs`. Adding, renaming
or removing a document means editing that registry and running `npm run docs:sync`;
`npm run docs:check` (and `core/__tests__/docs-registry.test.ts`) fail when a
Markdown file is unregistered, missing, thin, wrongly titled, or duplicated across
two documents. Version declarations are kept in step separately by
`scripts/release-engine.cjs`, which runs this engine on every release.

<!-- docs-engine: end generated index -->

