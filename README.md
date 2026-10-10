# FRIDAY — Personal AI Assistant

<p align="center">
  <img src="src/assets/friday-logo.png" alt="FRIDAY" width="220" />
</p>

<p align="center">
  <strong>FRIDAY - AI ASSISTANT</strong><br />
  A Private, Autonomous and Self Learning OS Based on Local & Cloud Models
</p>

<p align="center">
  A private, local-first AI work desk for Windows.<br />
  Owner and publisher: Devendra Singh Meena (devendrarj25)
</p>

FRIDAY runs on your PC. Chat, voice, models, and your files stay in one folder you choose. It is an Electron desktop app with a React window and a local Python service. It is not a hosted product.

## What you can do

| | |
| --- | --- |
| 💬 Chat | Manual and Auto, with the model you pick |
| 🎙️ Voice | Wake word, speech to text, and spoken replies in Auto |
| 🧩 Flow Studio | A live chart of a chat, a voice session, or a diagram you attach |
| 🧠 Models | Local engines and cloud providers, with paid models off until you allow them |
| 📦 Install | A Windows Setup and a portable app, plus in-app update and rollback |

How to use the open app: [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md). What ships, and where it lives in the tree: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## Get FRIDAY

Install the published Windows build, or pack from this checkout. Both paths are [INSTALL.md](INSTALL.md).

An installed copy updates only from a verified release installer. A source archive is for development, not for replacing the packaged app.

## Documentation

Each topic has one document. Open that document for the detail, and follow its links for anything else. The map below is generated. Do not edit it by hand.

### Documentation map (one canonical document per topic)

<!-- docs-engine: generated map. Edit scripts/docs-engine.cjs, not this. -->

| Topic | Document |
| --- | --- |
| Full documentation index (every document, what it answers) | [docs/README.md](docs/README.md) |
| Install, local CMD pack, first-launch, upgrade, uninstall | [INSTALL.md](INSTALL.md) |
| Using Chat, Voice, Models, and every sidebar section | [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) |
| Feature catalog with implementation and test map | [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md) |
| Capability import JSON format | [docs/FRIDAY_IMPORT_FORMAT.md](docs/FRIDAY_IMPORT_FORMAT.md) |
| Architecture layers and IPC | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Architecture baseline and drift detectors | [docs/FRIDAY_ARCHITECTURE_BASELINE.md](docs/FRIDAY_ARCHITECTURE_BASELINE.md) |
| Master operating flow | [docs/FRIDAY_MASTER_FLOW.md](docs/FRIDAY_MASTER_FLOW.md) |
| Storage root, install, update, uninstall | [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md) |
| Providers, credentials, billing and privacy firewalls | [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md) |
| MCP server, MCP client, pairing, and scopes | [docs/FRIDAY_MCP.md](docs/FRIDAY_MCP.md) |
| Build paths, TEST identity, and Stable versus Test updates | [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md) |
| Version scheme and bump rules | [VERSIONING.md](VERSIONING.md) |
| Release runbook | [RELEASE.md](RELEASE.md) |
| GitHub Actions catalog | [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md) |
| Repository workflow: branch, merge, cleanup, and revert | [docs/FRIDAY_MERGE_FLOW.md](docs/FRIDAY_MERGE_FLOW.md) |
| Change control, task packet, and development contracts | [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md) |
| Contributor workflow and documentation contract | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security policy and reporting | [SECURITY.md](SECURITY.md) |
| Licence and ownership terms | [LICENSE](LICENSE) |
| Changelog of published versions | [CHANGELOG.md](CHANGELOG.md) |
| Verification evidence and open limitations | [AUDIT.md](AUDIT.md) |
| Cross-session project state briefing | [FRIDAY_STATE.md](FRIDAY_STATE.md) |
| AI session protocol and landing bar | [AGENTS.md](AGENTS.md) |

<!-- docs-engine: end generated map -->

## Version

Linux checks in this checkout are not a Windows install. CMD pack, install, and publish stay **NOT VERIFIED** until they are run. Evidence: [AUDIT.md](AUDIT.md) and [FRIDAY_STATE.md](FRIDAY_STATE.md).

The public version is read from `config/friday-version.json`. `npm run typecheck` prints that version before the checker. npm's own `friday@…` line is the three-part encoding those tools require. Policy: [VERSIONING.md](VERSIONING.md). Publish steps: [RELEASE.md](RELEASE.md).

## Licence

Terms: [LICENSE](LICENSE). How to change the tree: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

---

## 9. What is new in 1.0.1.2

<!-- release-engine: generated section. Summary plus links only - the full
     write-up lives in the changelog and the release notes. -->

Released October 6, 2026 on the Stable channel - Flow Studio, voice controls, and a clearer brain.

- Full detail for this release: **[releases/notes/v1.0.1.2.md](releases/notes/v1.0.1.2.md)**
- Changelog for the current public line: **[CHANGELOG.md](CHANGELOG.md)**
