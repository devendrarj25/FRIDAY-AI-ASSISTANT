# FRIDAY — Capability Import Format

**Current shipping version: 1.0.1.2**

📥 JSON packs accepted by **Add from file** / **From GitHub** on Skills, Tools, Modules, Plugins, Workflows, and Agents (`src/components/friday/CapabilityImport.tsx`). Using those pages: [FRIDAY_USER_GUIDE.md](FRIDAY_USER_GUIDE.md). Catalog of what already ships: [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md).

Writer: `electron/capabilities.cjs` (`resolveTree`, `installPack`). Shape gate: `electron/pack-shape.cjs`. Per-tree collect/heal: `electron/skill-pack.cjs`, `electron/tool-pack.cjs`, `electron/agent-pack.cjs`, `electron/module-pack.cjs`, `electron/plugin-pack.cjs`, `electron/workflow-pack.cjs`. Enable only after `electron/capability-verify.cjs`. Trees and `segment` names: `electron/friday-contract.cjs` `TREES`.

## 1. Envelope

A payload may be one object, an array, or `{ "packs": [ … ] }`. Destination is `<FRIDAY_ROOT>/<tree>/<segment>/<slug>/`. Default `segment` when omitted: skills `custom`, tools `custom`, agents `custom`, modules `custom`, plugins `installed`, workflows `saved`, models `local`.

`resolveTree(pack, hint)` order: declared `tree` / `kind` / `type`, then pack-shape detection, then the page hint. A Skills page refuses a tool-shaped pack instead of rewriting it.

## 2. Manifest files

| Tree | Manifest | Code next to it |
| --- | --- | --- |
| skills | `skill.json` | `skill.mjs` (ESM `run`) |
| tools | `tool.json` | `index.cjs` (`run`) |
| agents | `manifest.json` or `agent.json` | optional files listed on the pack |
| modules | `manifest.json` or `module.json` | `main.py` (`register` / `run` / `self_test`) |
| plugins | `plugin.json` | `index.cjs` with `hooks` |
| workflows | `workflow.json` | `steps` (or `nodes`) in the JSON |
| models | `model.json` | none required |

Shared fields: `id` or `slug`, `name`, `description` or `summary`, optional `permissions`, `risk` (`safe` default), optional `selfTest` `{ export, input }`. Heal never sets `enabled: true`.

## 3. Extra sources (same writer)

Zip, folder, and git clone on a type-specific page still call `installPack()`. Skills extra: `skill.json` / `skill.mjs` only. Tools extra: `tool.json` / `index.cjs`. Agents extra: agent `manifest.json` (`goal` / `persona` / `role` / `agents`). Modules extra: `entry` + `permissions`. Plugins extra: `hooks`. Workflows extra: `steps`.

IPC used by Import (quoted in `electron/main.cjs`): `capabilities:install-file`, `capabilities:install-github`.
