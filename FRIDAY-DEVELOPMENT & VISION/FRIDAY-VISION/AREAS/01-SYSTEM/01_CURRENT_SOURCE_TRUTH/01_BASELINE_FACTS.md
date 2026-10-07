# Source Baseline Facts

## CURRENT (this checkout, right now)
File count, extensions, and per-subsystem breakdown are machine-generated in
[`CURRENT_SOURCE_INVENTORY.json`](CURRENT_SOURCE_INVENTORY.json)'s `current`
section — read that for real numbers. As of its last regeneration: **2527
files** (excluding `node_modules/`, `.git/`, and the disposable
`FRIDAY-DEVELOPMENT & VISION/` layer itself). Regenerate it (same script,
noted inside the JSON) whenever the product source tree changes; don't
hand-edit a count here or there.

The current project is a Windows Electron + React desktop system with a
Python/FastAPI kernel. The authoritative architecture documentation states
that renderer calls are brokered through Electron preload/IPC, the kernel
exposes loopback health/bridge surfaces, and `src/lib/friday/brain-engine.ts`
→ `src/lib/friday/brain/core-brain.ts` is the intelligence path.
`kernel/router.py` is the model router, not the HTTP router.

The source already contains substantial foundations: brain routing,
capability registry, model registry, orchestration, agents, workflows,
tools, memory/knowledge, task graph/ledger/background work, sandboxing,
governance, companion, voice, browser, devices, doctor/health,
self-management and build/release controls. The upgrade must therefore be
an **integration and contract-hardening program**, not a greenfield
rewrite.

## HISTORICAL (source-reference only — do not use for current facts)
This project's development/vision layer was originally built from a single
uploaded archive, kept here for provenance, not as a description of this
checkout:

- Source archive: `FRIDAY-AI-ASSISTANT-main(6).zip`
- Archive entries: 3799. Regular files in that archive's inventory: 2770.

That count is **not** the current file count (see CURRENT above) — the
checkout has grown/changed since that archive was taken. Full historical
detail: `CURRENT_SOURCE_INVENTORY.json`'s `historical` section.
