# FRIDAY — READMEFIRST

**Read [AGENTS.md](AGENTS.md) first and follow it.** This file is the second
read: the map of the whole repository and the working flow, so a fix, an
upgrade, or a modification opens the right path and does not scan the tree.

This file, and the `FRIDAY-DEVELOPMENT & VISION/` folder it describes, are a
**removable layer** — except `AGENTS.md`, `AUDIT.md`, and `FRIDAY_STATE.md`,
which live at repo root and stay there (§2: the real test suite reads them
from root). Nothing under `src/`, `electron/`, `kernel/`, `core/`, or any
other product folder imports the removable layer. See "Before you delete
the working layer" at the end.

---

## 1. Two layers, one repo

| Layer | Where | What it's for |
|---|---|---|
| **Official product** | Everything in repo root *except* `FRIDAY-DEVELOPMENT & VISION/` and this file | The real, shipping FRIDAY app. This is what stays when the working layer is deleted. |
| **Working / Vision layer** | `FRIDAY-DEVELOPMENT & VISION/` | Docs, contracts, and roadmap for *working on and upgrading* FRIDAY. Nothing here is shipped. |

**Rule:** product code changes happen only in the official-product folders
below. The working layer is read for guidance, and updated with the outcome
of a task (change ledger, audit, state) — it is never itself the product.

---

## 2. Official product — root folder map

| Path | Role |
|---|---|
| `AGENTS.md` | Session rules — **read this first, always**, before this file. Root-level because the project's own test suite (`core/__tests__/version-sync.test.ts` and others) reads it from here — this is not optional placement. |
| `AUDIT.md` | Verification evidence, what's proven vs. not. Same reason: read by the real test suite from repo root. |
| `FRIDAY_STATE.md` | Current facts: version, snapshot, decisions, gaps, next priorities. |
| `CLAUDE.md` | One-line import file that points to `AGENTS.md` for tools that expect it. Never a second hand-maintained copy. |
| `src/` | React UI, renderer logic, `src/lib/friday/*` (brain, models, self) |
| `electron/` | Windows main process — windows, IPC, updates, toolchains, routers |
| `kernel/` | Python FastAPI kernel — tools, memory, STT, devices, routing |
| `core/` | Contracts + Vitest suite (not shipped inside the EXE) |
| `agents/` | Agent manifests (runtime capability, governed by root `AGENTS.md` for AI-tool conduct and by `docs/FRIDAY_FEATURES.md` for the agent inventory — see §4) |
| `skills/`, `tools/`, `plugins/`, `modules/`, `workflows/` | Capability trees, packed as `extraResources` |
| `config/` | Version identity, toolchain floors, kernel YAML |
| `scripts/` | Setup, pack, docs-engine, release engines |
| `builder/`, `installer/`, `updater/` | Build, packaging, and update-channel logic |
| `docs/` | Official documentation set — index at `docs/README.md` |
| `memory/`, `database/`, `brain-data/`, `conversations/` | Persisted data / stores |
| `models/`, `system/`, `resources/`, `public/` | Model assets, system files, static resources |
| `testing/`, `debug/`, `temporary/`, `backup/`, `releases/` | Test fixtures, debug aids, scratch/backup, published release artifacts |
| `.github/` | CI workflows |

Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Full doc index:
[docs/README.md](docs/README.md) and the map in [README.md](README.md) §4.

---

## 3. Working / Vision layer — what's inside `FRIDAY-DEVELOPMENT & VISION/`

`AGENTS.md`, `AUDIT.md`, and `FRIDAY_STATE.md` are **not** in this folder —
see §2. This folder holds only the disposable planning/workbench material:

| Path | Role |
|---|---|
| Product, technical, and UI contracts | Absorbed into `src/lib/friday/flow-chart.ts`, `docs/FRIDAY_FEATURES.md`, `src/lib/friday/navigation.ts`, and `docs/FRIDAY_CHANGE_CONTROL.md`. The copies in this folder were removed. |
| `config/friday-version.json` | The only product version. The old document manifest was removed. |
| `FRIDAY-DEVELOPMENT/` | **Task workbench** — how to safely make a change *right now*. Entry: `docs/FRIDAY_CHANGE_CONTROL.md`, then `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md` |
| `FRIDAY-VISION/` | Absorbed. The area folder was removed after the plans lived in the product. |

### SHA policy (standing rule — read before adding any hash anywhere in this layer)
This project has **one** authoritative SHA-256: the hash of the whole
main/release FRIDAY ZIP, kept alongside that ZIP when one is published —
never duplicated per-file, per-folder, per-tree, or per-archive inside
`FRIDAY-DEVELOPMENT & VISION/`. Manifests, indexes, and inventories in this
layer describe files by **path and byte size**, not by content hash. A
historical archive's name, date, or file count may stay as provenance; its
SHA-256 must not — remove it, don't relocate it into a new field. This does
**not** apply to operational SHA verification actually used by FRIDAY's own
runtime/update/security code (e.g. `SHA256SUMS.txt` in a real release, a
capability-package schema's `sha256` field) — that's real product behavior
and out of scope for this rule; don't touch it under this policy.

### 3a. `FRIDAY-DEVELOPMENT/` — 14 numbered areas
| # | Folder | Covers |
|---|---|---|
| 00 | adopted | The read-first order, the plane map, and the master laws now live in `docs/FRIDAY_CHANGE_CONTROL.md` and `src/lib/friday/flow-chart.ts`. The folder was removed after those tests passed. |
| 01 | `01_SOURCE_ROUTING` | `TASK_TO_AREA_ROUTER.md` still classifies a task. The owner catalog was removed; the live files are the catalog. |
| 02 | adopted | Durable task runtime and the event envelope now live in `src/lib/friday/self/run-receipt.ts`. The folder was removed after those tests passed. |
| 03 | adopted | Context budgets and policy routing live in `src/lib/friday/brain/context-engine.ts` and `electron/model-router.cjs`. |
| 04 | adopted | Bounded agents, handoff packets, and serialized writes live in `src/lib/friday/self/agent-scheduler.ts`. |
| 05 | adopted | Capability phases live in `src/lib/friday/self/run-receipt.ts`. The planner loads a tool shortlist. |
| 06 | adopted | Memory tiers, clashes, and retrieval order live in `src/lib/friday/self/memory-engine.ts`. |
| 07 | adopted | Evidence and stale observations live in the task graph and `src/lib/friday/self/computer-use.ts`. |
| 08 | adopted | Evaluation scores and trace spans live in `src/lib/friday/self/run-receipt.ts`. |
| 09 | adopted | Approval grants and the peer-connection rule live in `src/lib/friday/self/run-receipt.ts`. |
| 10 | `10_DEVELOPMENT_WORKFLOW` | `FAST_SAFE_CHANGE_WORKFLOW.md` remains until this folder is removed. The change gate is `docs/FRIDAY_CHANGE_CONTROL.md`. |
| 11 | adopted | Source versus build validation and the tool floor live in `docs/FRIDAY_CHANGE_CONTROL.md` and `config/toolchain-versions.json`. |
| 12 | adopted | Changes stay on the existing owners. A paper design does not delete a working path. |
| 13 | adopted | The research decisions are in `docs/FRIDAY_CHANGE_CONTROL.md`. Freshness of the 2026-09 list is unverified. |
| 14 | `14_TEMPLATES` | `TASK_PACKET_TEMPLATE.md` remains until this folder is removed. The packet is in `docs/FRIDAY_CHANGE_CONTROL.md`. |

### 3b. `FRIDAY-VISION/`
The area plans now live in the product owners: the cognitive runtime, the memory fabric, the task graph, the desktop loop, the capability registry, chat, Auto voice, and the companion snapshot. The `FRIDAY-VISION/` folder was removed after those tests passed. A later upgrade is recorded in `FRIDAY_STATE.md` and the owning product document.

### How the two connect
- **Doing a task today** → `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`
  classifies it and sends you to the real source owner.
- **Planning a major/future upgrade** → `FRIDAY_STATE.md` and the owning product document.
  There is no vision corpus left to search.

---

## 4. Mandatory session order (every task)

Rules live in `AGENTS.md`. This section only names the path. The canonical
workflow is [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md)
(the TASK→ROUTE→OWNER→...→PASS/BLOCK gate and the task packet). The copies
under `FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md`
and `FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md`
remain until that folder is removed. For anything beyond a one-line fix, fill
in TASK_ID, CANONICAL_OWNER, ALLOWED_FILES, FORBIDDEN_FILES, DIRECT_DEPENDENCIES,
AFFECTED_BOUNDARIES, REQUIRED_TESTS, ROLLBACK_PLAN, and EVIDENCE.

1. **`AGENTS.md`** (repo root) — first. Follow it.
2. **This file** (`READMEFIRST.md`) — the map and the working flow.
3. The workflow file and the task packet named above.
4. **`FRIDAY_STATE.md`** (repo root) — current facts, when the task needs them.
5. Classify the task with **`FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`**.
6. Open only the owner named by that router.
7. For a future/major upgrade, read `FRIDAY_STATE.md` and the owning product document. The vision folder was removed.
8. Implement in the real product folder (§2). Depth and the removal of finished plan entries are the rules in `AGENTS.md`.
9. Verify with the checks `AGENTS.md` names, then update `AUDIT.md` / `FRIDAY_STATE.md` (repo root) when a current fact changed. Fix indexes after a plan file or an empty folder is removed. A ledger line, if one is written, does not name a tool or a person other than `devendrarj25`. State PASS or BLOCK explicitly (see the workflow file) — a model's own claim that something works is not evidence; command output is.

**Never:** load the whole repository by default; create a second registry/owner for something that already has one; call a planned feature "done" without test/code evidence; edit pack/installer/update scripts without a real bug; leave a doc's fact out of sync with the change you just made; move `AGENTS.md`, `AUDIT.md`, or `FRIDAY_STATE.md` out of repo root — the real test suite reads them from there (see §2).

---

## 5. Before you delete the working layer

Deleting `FRIDAY-DEVELOPMENT & VISION/` (and, if you no longer want it, this
file) should leave a clean, complete, independent product — nothing else to
check. `AGENTS.md`, `AUDIT.md`, and `FRIDAY_STATE.md` already live at repo
root (§2), so the real test suite and `README.md`'s documentation map keep
working with no further action. The product, technical, and UI copies
that used to sit in this folder were removed after they lived in the product
documents. Nothing in `src/`, `electron/`, `kernel/`, or `core/` read them.
