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
| `PRD.md` / `TRD.md` / `Backend-Schema.md` / `UI-UX-Design-Document.md` | Product/technical/UI/data contracts for the next-level upgrade |
| `DOCUMENT-MANIFEST.json` | Provenance of the four contract docs above |
| `README.md` | This layer's own short intro |
| `FRIDAY-DEVELOPMENT/` | **Task workbench** — how to safely make a change *right now*. Entry: `FRIDAY-DEVELOPMENT/00_MASTER/00_READ_FIRST.md` |
| `FRIDAY-VISION/` | **Long-term architecture corpus** — where FRIDAY is headed, for major/future upgrades. Entry: `FRIDAY-VISION/00-MASTER/00_READ_FIRST.md` |

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
| 00 | `00_MASTER` | Entry point + `DEVELOPMENT_MASTER_CONTRACT.md` (architecture law) |
| 01 | `01_SOURCE_ROUTING` | `TASK_TO_AREA_ROUTER.md` (classify a task) + `SOURCE_OWNER_CATALOG.md`/`SOURCE_OWNERSHIP_MAP.json` (real file anchors, callers, tests, locked files) |
| 02 | `02_RUNTIME_CONTRACTS` | Durable task runtime, event contract |
| 03 | `03_INTELLIGENCE_FABRIC` | Context engineering, model routing contract |
| 04 | `04_AGENT_RUNTIME` | Agent runtime contract, handoff/parallelism |
| 05 | `05_CAPABILITY_FABRIC` | Capability contract, tool discovery |
| 06 | `06_MEMORY_KNOWLEDGE` | Memory contract, retrieval/context policy |
| 07 | `07_EXECUTION_VERIFICATION` | Evidence contract, world-state freshness |
| 08 | `08_OBSERVABILITY_EVALUATION` | Evaluation contract, tracing/telemetry |
| 09 | `09_SECURITY_GOVERNANCE` | Approval contract, security invariants |
| 10 | `10_DEVELOPMENT_WORKFLOW` | Fast/safe change workflow, change ledger, AI handoff template |
| 11 | `11_TESTING_RELEASE` | Test strategy, regression matrix, release gates |
| 12 | `12_MIGRATION_ROADMAP` | No-big-bang rule, phased implementation |
| 13 | `13_RESEARCH` | Primary research + synthesis |
| 14 | `14_TEMPLATES` | Contract-change and source-card templates |

### 3b. `FRIDAY-VISION/` — same shape as before
`00-MASTER` (entry, contracts, context router, dependency/file-routing maps)
→ `01-ARCHITECTURE` → `02-LIFECYCLE` → `03-BUILD` → `04-OPERATIONS` →
`05-IMPLEMENTATION` → `06-RESEARCH`, plus `AREAS/01-SYSTEM` …
`AREAS/08-PACKAGING-BUILD-UPDATE` for the deep per-system target specs. Every
folder in this tree has its own `INDEX.md` — open that before opening the
files inside it.

### How the two connect
- **Doing a task today** → `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`
  classifies it and sends you to one numbered area + the real source owner.
- **Planning a major/future upgrade** → `FRIDAY-VISION/00-MASTER/03_AI_CONTEXT_ROUTER.md`
  runs the same kind of classify-then-narrow search over the vision corpus.
- Either path can hand off to the other: a vision target you're about to
  implement becomes a `FRIDAY-DEVELOPMENT` task; a development contract that
  needs a long-term redesign gets logged as a vision gap.

---

## 4. Mandatory session order (every task)

Rules live in `AGENTS.md`. This section only names the path. The workflow
itself is
`FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md`
(the 11-step TASK→ROUTE→OWNER→...→PASS/BLOCK gate). For anything beyond a
one-line fix, open that file and fill in
`FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md`
(TASK_ID, CANONICAL_OWNER, ALLOWED_FILES, FORBIDDEN_FILES, DIRECT_DEPENDENCIES,
AFFECTED_BOUNDARIES, REQUIRED_TESTS, ROLLBACK_PLAN, EVIDENCE) as you go.

1. **`AGENTS.md`** (repo root) — first. Follow it.
2. **This file** (`READMEFIRST.md`) — the map and the working flow.
3. The workflow file and the task packet named above.
4. **`FRIDAY_STATE.md`** (repo root) — current facts, when the task needs them.
5. Classify the task with **`FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`**.
6. Open only the matching numbered area + the exact source owner from `SOURCE_OWNER_CATALOG.md`.
7. For a future/major upgrade only, also open the one matching `FRIDAY-VISION` target file — not the whole tree.
8. Implement in the real product folder (§2). Depth and the removal of finished plan entries are the rules in `AGENTS.md`.
9. Verify with the checks `AGENTS.md` names, then update `AUDIT.md` / `FRIDAY_STATE.md` (repo root) when a current fact changed. Fix indexes after a plan file or an empty folder is removed. A ledger line, if one is written, does not name a tool or a person other than `devendrarj25`. State PASS or BLOCK explicitly (see the workflow file) — a model's own claim that something works is not evidence; command output is.

**Never:** load the whole repository by default; create a second registry/owner for something that already has one; call a planned feature "done" without test/code evidence; edit pack/installer/update scripts without a real bug; leave a doc's fact out of sync with the change you just made; move `AGENTS.md`, `AUDIT.md`, or `FRIDAY_STATE.md` out of repo root — the real test suite reads them from there (see §2).

---

## 5. Before you delete the working layer

Deleting `FRIDAY-DEVELOPMENT & VISION/` (and, if you no longer want it, this
file) should leave a clean, complete, independent product — nothing else to
check. `AGENTS.md`, `AUDIT.md`, and `FRIDAY_STATE.md` already live at repo
root (§2), so the real test suite and `README.md`'s documentation map keep
working with no further action. `PRD.md`, `TRD.md`, `Backend-Schema.md`,
`UI-UX-Design-Document.md` inside the folder are working contracts only —
nothing in `src/`, `electron/`, `kernel/`, or `core/` reads them.
