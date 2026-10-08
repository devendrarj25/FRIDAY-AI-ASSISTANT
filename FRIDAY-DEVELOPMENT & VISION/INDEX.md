# INDEX — FRIDAY-DEVELOPMENT & VISION

Repo-root order is [`../AGENTS.md`](../AGENTS.md), then [`../READMEFIRST.md`](../READMEFIRST.md).
This file only indexes what's inside this folder. `AGENTS.md`, `AUDIT.md`,
and `FRIDAY_STATE.md` are **not** here — they live at repo root (the real
test suite reads them from there) — see `../AGENTS.md`, `../AUDIT.md`,
`../FRIDAY_STATE.md`.

## Files here
| File | Purpose |
|---|---|
| [`PRD.md`](PRD.md) | Product requirements for the next-level upgrade |
| [`TRD.md`](TRD.md) | Technical architecture / implementation constraints |
| [`UI-UX-Design-Document.md`](UI-UX-Design-Document.md) | UI/UX preservation + interaction contract |
| [`README.md`](README.md) | Short intro to this layer |

## Subfolders
| Folder | Use for |
|---|---|
| [`FRIDAY-DEVELOPMENT/`](FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md) | A task you're doing **right now** — routes to the exact real-code owner |
| [`FRIDAY-VISION/`](FRIDAY-VISION/AREAS/01-SYSTEM/README.md) | Area plans that are not landed yet |

## Picking the right one
Start with `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`.
If the task is "fix/add something in the current app," it resolves entirely
inside `FRIDAY-DEVELOPMENT/`. If it needs a design that doesn't exist yet in
the current app, `FRIDAY-DEVELOPMENT`'s router will tell you to also check
`FRIDAY-VISION/AREAS/` for the target spec — read
only the one matching area under `FRIDAY-VISION/AREAS/`, not the whole tree.

## Keeping this layer duplicate-free
- Product contracts still in this folder (`PRD.md`, `TRD.md`,
  `UI-UX-Design-Document.md`) live **only here** — there is no second copy
  in `docs/`. If one is ever copied elsewhere, delete the copy and link
  back to this one instead.
- `FRIDAY-DEVELOPMENT/` owns "how to work on FRIDAY today." `FRIDAY-VISION/`
  owns "where FRIDAY is going." Don't add a second router, a second
  task-classification table, or a second source-owner catalog in either —
  extend the existing one.
- **No per-file/folder/tree SHAs anywhere in this layer.** See the SHA
  policy in [`../READMEFIRST.md`](../READMEFIRST.md) §3. Manifests and
  indexes here describe files by path and byte size, not content hash.
