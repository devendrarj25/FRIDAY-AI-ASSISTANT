# INDEX — FRIDAY-DEVELOPMENT & VISION

Repo-root order is [`../AGENTS.md`](../AGENTS.md), then [`../READMEFIRST.md`](../READMEFIRST.md).
This file only indexes what's inside this folder. `AGENTS.md`, `AUDIT.md`,
and `FRIDAY_STATE.md` are **not** here — they live at repo root (the real
test suite reads them from there) — see `../AGENTS.md`, `../AUDIT.md`,
`../FRIDAY_STATE.md`.

## Files here
| File | Purpose |
|---|---|
| [`ADOPTION_LEDGER.json`](ADOPTION_LEDGER.json) | One row per plan heading. A MISSING row is still open. |
| [`ledger-validator.cjs`](ledger-validator.cjs) | Checks that every open row still has its file and heading, and that every closed row cites a real test. |
| [`PRD.md`](PRD.md) | Product requirements that are still open |
| [`TRD.md`](TRD.md) | Technical constraints that are still open |
| [`UI-UX-Design-Document.md`](UI-UX-Design-Document.md) | UI contract that is still open |
| [`README.md`](README.md) | Short intro to this layer |

## Subfolders
| Folder | Use for |
|---|---|
| [`FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`](FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md) | Classify a task. Stays until this folder is empty. |
| [`FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md`](FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md) | Fast-safe change steps. Stays until this folder is empty. |
| [`FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md`](FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md) | Task packet. Stays until this folder is empty. |
| [`FRIDAY-VISION/AREAS/01-SYSTEM/`](FRIDAY-VISION/AREAS/01-SYSTEM/README.md) | System plans, `02_TARGET_SYSTEM` through `25_DOCUMENT_CONTROL`. |
| [`FRIDAY-VISION/AREAS/04-MODELS-ROUTING/`](FRIDAY-VISION/AREAS/04-MODELS-ROUTING/FRIDAY-MODELS-ROUTING-DEEP-UPGRADE/README.md) | Model federation plans. |
| [`FRIDAY-VISION/AREAS/05-AUTONOMY-LEARNING-EVOLUTION/`](FRIDAY-VISION/AREAS/05-AUTONOMY-LEARNING-EVOLUTION/FRIDAY-AUTONOMY-LEARNING-EVOLUTION-UPGRADE/README.md) | Autonomy plans, `00_MASTER` through `16_AGENT_HANDOFF`. |
| [`FRIDAY-VISION/AREAS/06-CAPABILITY-FEATURES/`](FRIDAY-VISION/AREAS/06-CAPABILITY-FEATURES/README.md) | Capability plans. Two packages share numbers; the README maps both. |
| [`FRIDAY-VISION/AREAS/07-INTERACTION/`](FRIDAY-VISION/AREAS/07-INTERACTION/README.md) | Chat, voice, mobile, and Manual/Auto plans. |

## Picking the right one
Start with `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`.
Open the one area under `FRIDAY-VISION/AREAS/` that owns the task. Read that
area's README, then the numbered folder the task names. A heading whose
ledger row is DONE, SUPERSEDED, or REJECT is already closed.

## Keeping this layer duplicate-free
- `PRD.md`, `TRD.md`, and `UI-UX-Design-Document.md` stay in this folder as the single copy.
- Adopted current-source snapshots and stale byte lists were removed. The repository is the inventory.
- Keep the existing folder numbers. Ledger rows resolve these paths.
- Where two folders share a number, both stay. The area README says which is which.
- This layer keeps no per-file SHA-256. See [`../READMEFIRST.md`](../READMEFIRST.md).
