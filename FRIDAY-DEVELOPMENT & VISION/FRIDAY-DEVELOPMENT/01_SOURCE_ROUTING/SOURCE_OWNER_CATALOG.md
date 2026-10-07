# Source Owner Catalog

Human-readable view of [`SOURCE_OWNERSHIP_MAP.json`](SOURCE_OWNERSHIP_MAP.json) (same folder) — read the JSON when you need the full caller/test lists; this file is for scanning by eye.

All paths below were verified to exist in this checkout when generated (2026-09-16). Caller counts are a grep-by-module-name heuristic, not a real import-graph resolver — confirm by opening the file before relying on a caller list.

## Locked — do not modify without a real bug

**Concept:** UI organization, EXE install/update/uninstall, GitHub Actions, Official Publish, and project independence guarantees.

**Files:** `electron/update-safety.cjs`, `src/lib/friday/navigation.ts`

**If you must touch one of these, re-run:** `core/__tests__/project-independence.test.ts`, `ui-live-honesty.test.ts`, `navigation-registry.test.ts`, `safe-update.test.ts`, `github-release-installer.test.ts`, `clean-install-contract.test.ts`

Source of this rule: AGENTS.md -> 'Locked (do not edit unless a real bug is found)'

## Do-not-modify zones (task-gated, not file-gated)

- installer/
- updater/
- builder/
- .github/workflows/
- unless the task is specifically about build, packaging, installer, or release workflows (AGENTS.md).

## Config owners

| Concern | Owning file |
|---|---|
| version identity | `config/friday-version.json` |
| kernel config | `config/*.yaml (kernel/ reads these at boot)` |
| electron-builder config | `electron-builder.yml (or package.json build field) -- treat as part of the locked packaging surface` |

## Brain / Cognition

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `src/lib/friday/brain-engine.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/cross-mode-sync.test.ts`<br>`core/__tests__/round-closeout-integration.test.ts`<br>`core/__tests__/routing-task.test.ts` | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/cross-mode-sync.test.ts` |
| `src/lib/friday/brain/core-brain.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/capability-registry.test.ts`<br>`core/__tests__/core-brain.test.ts`<br>`core/__tests__/flow-conformance.test.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/capability-registry.test.ts` |
| `src/lib/friday/brain/orchestrator.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/model-live-health.test.ts`<br>`core/__tests__/orchestrator-efficiency.test.ts`<br>`core/__tests__/skill-forge-reuse.test.ts`<br>`core/__tests__/turn-trace.test.ts` | `core/__tests__/check-contract.test.ts`<br>`core/__tests__/ci-workflows.test.ts`<br>`core/__tests__/model-live-health.test.ts` |
| `src/lib/friday/brain/context-engine.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/conversation-continuity.test.ts`<br>`core/__tests__/conversation-intelligence.test.ts`<br>`core/__tests__/conversation-state.test.ts` | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/conversation-continuity.test.ts`<br>`core/__tests__/conversation-intelligence.test.ts` |
| `src/lib/friday/brain/retrieval.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/freshness-contradiction-retrieval.test.ts`<br>`core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/intelligence-quality.test.ts`<br>`core/__tests__/library-chat.test.ts` | `core/__tests__/freshness-contradiction-retrieval.test.ts`<br>`core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/intelligence-quality.test.ts` |
| `src/lib/friday/brain/knowledge-base.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/freshness-contradiction-retrieval.test.ts`<br>`core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/intelligence-quality.test.ts` | `core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/core-brain.test.ts`<br>`core/__tests__/freshness-contradiction-retrieval.test.ts` |
| `src/lib/friday/brain/knowledge-graph.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/knowledge-engine.test.ts`<br>`core/__tests__/knowledge-ingest.test.ts`<br>`core/__tests__/pre-intelligence.test.ts` | `core/__tests__/intelligence-audit.test.ts`<br>`core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/knowledge-engine.test.ts` |
| `src/lib/friday/brain/knowledge-ingest.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/knowledge-ingest.test.ts`<br>`core/__tests__/pre-intelligence.test.ts`<br>`src/lib/friday/brain/core-brain.ts` | `core/__tests__/intelligence-next.test.ts`<br>`core/__tests__/knowledge-ingest.test.ts`<br>`core/__tests__/pre-intelligence.test.ts` |

## Memory

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `src/lib/friday/self/memory-engine.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/conversation-continuity.test.ts`<br>`core/__tests__/conversation-intelligence.test.ts`<br>`core/__tests__/conversation-state.test.ts`<br>`core/__tests__/flow-conformance.test.ts` | `core/__tests__/conversation-continuity.test.ts`<br>`core/__tests__/conversation-intelligence.test.ts`<br>`core/__tests__/conversation-state.test.ts` |
| `src/lib/friday/self/memory-consolidate.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/freshness-contradiction-retrieval.test.ts`<br>`core/__tests__/knowledge-engine.test.ts`<br>`core/__tests__/memory-fabric.test.ts`<br>`src/lib/friday/brain/conversation-state.ts` | `core/__tests__/freshness-contradiction-retrieval.test.ts`<br>`core/__tests__/knowledge-engine.test.ts`<br>`core/__tests__/memory-fabric.test.ts` |
| `src/lib/friday/self/memory-teach.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/memory-section-closeout.test.ts`<br>`src/components/friday/MemoryConsole.tsx` | `core/__tests__/memory-section-closeout.test.ts` |
| `kernel/memory.py` | shipped (Python kernel, packed as sidecar) | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/conversation-continuity.test.ts`<br>`core/__tests__/conversation-intelligence.test.ts`<br>`core/__tests__/conversation-state.test.ts` | `core/__tests__/agent-router.test.ts`<br>`core/__tests__/agent-scheduler.test.ts`<br>`core/__tests__/brain-coordinators.test.ts` |

## Intelligence / Models

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `electron/model-router.cjs` | shipped (renderer/main process, packed into EXE) | `core/ai/index.ts`<br>`core/registry.ts`<br>`src/lib/friday/flow-chart.ts` | `core/__tests__/billing-policy.test.ts`<br>`core/__tests__/bounded-retry.test.ts`<br>`core/__tests__/manual-multi-routing.test.ts` |
| `electron/provider-registry.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/provider-registry.test.ts` |
| `electron/model-capabilities.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/model-routing.test.ts` |
| `src/lib/friday/models-engine.ts` | shipped (renderer/main process, packed into EXE) | `src/components/friday/ChatDock.tsx`<br>`src/components/friday/settings/SystemSettings.tsx`<br>`src/lib/friday/brain-engine.ts`<br>`src/lib/friday/brain/model-registry.ts` | `core/__tests__/first-run-bootstrap.test.ts`<br>`core/__tests__/main-window-live.test.ts`<br>`core/__tests__/provider-id-parity.test.ts` |
| `src/lib/friday/connectors.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/connector-router.test.ts`<br>`core/__tests__/connector-tools.test.ts`<br>`src/components/friday/AppShell.tsx`<br>`src/lib/friday/brain-engine.ts` | `core/__tests__/capability-live-sync.test.ts`<br>`core/__tests__/companion-live.test.ts`<br>`core/__tests__/composer-capabilities.test.ts` |

## Authority / Privacy

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `electron/tool-authority.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/owner-flow-chart.test.ts`<br>`core/__tests__/round-closeout-integration.test.ts` |
| `electron/privacy-firewall.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/owner-work.test.ts`<br>`core/__tests__/provider-auth-and-egress.test.ts` |
| `kernel/authority.py` | shipped (Python kernel, packed as sidecar) | `src/components/ui/alert.tsx`<br>`src/components/ui/badge.tsx`<br>`src/components/ui/button.tsx`<br>`src/components/ui/label.tsx` | `core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/experience-learning-loop.test.ts`<br>`core/__tests__/owner-flow-chart.test.ts` |
| `kernel/privacy.py` | shipped (Python kernel, packed as sidecar) | `kernel/router.py`<br>`kernel/tests/test_kernel_privacy.py`<br>`src/lib/friday/brain/workflow-introspection.ts`<br>`src/lib/friday/flow-chart.ts` | `core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/kernel-rpc-allowlist.test.ts`<br>`core/__tests__/knowledge-ingest.test.ts` |

## Execution / Runtime

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `electron/tools.cjs` | shipped (renderer/main process, packed into EXE) | `core/__tests__/modules-catalog.test.ts`<br>`core/registry.ts`<br>`kernel/tests/test_env_and_ssrf_guards.py`<br>`src/lib/friday/marketplace.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agents-page-customization.test.ts`<br>`core/__tests__/brain-section-closeout.test.ts` |
| `electron/readiness.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/ci-workflows.test.ts`<br>`core/__tests__/foundation-readiness.test.ts`<br>`core/__tests__/production-readiness.test.ts` |
| `electron/service-health.cjs` | shipped (renderer/main process, packed into EXE) | `src/routes/status.tsx` | `core/__tests__/boot-hardening.test.ts`<br>`core/__tests__/round-closeout-integration.test.ts`<br>`core/__tests__/service-health.test.ts` |
| `kernel/tools.py` | shipped (Python kernel, packed as sidecar) | `core/__tests__/modules-catalog.test.ts`<br>`core/registry.ts`<br>`kernel/tests/test_env_and_ssrf_guards.py`<br>`src/lib/friday/marketplace.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agents-page-customization.test.ts`<br>`core/__tests__/brain-section-closeout.test.ts` |
| `kernel/planner.py` | shipped (Python kernel, packed as sidecar) | `core/__tests__/core.test.ts`<br>`core/brain/decision/index.ts`<br>`core/brain/index.ts`<br>`core/brain/router/index.ts` | `core/__tests__/brain-coordinators.test.ts`<br>`core/__tests__/brain-section-closeout.test.ts`<br>`core/__tests__/capability-confidence-privacy.test.ts` |
| `electron/main.cjs` | shipped (renderer/main process, packed into EXE) | `core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/flow-conformance.test.ts`<br>`electron/sandbox-lab.cjs`<br>`src/lib/friday/brain/app-guide.ts` | `core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/agent-scheduler.test.ts`<br>`core/__tests__/agents-catalog.test.ts` |
| `electron/preload.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/auto-mode-local-stt.test.ts`<br>`core/__tests__/background-life.test.ts` |

## Registries / Discovery

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `core/registry.ts` | dev-only (Vitest contracts, not packed into EXE) | `core/__tests__/agent-router.test.ts`<br>`core/__tests__/agents-runtime-wiring.test.ts`<br>`core/__tests__/capability-confidence-privacy.test.ts`<br>`core/__tests__/capability-discovery.test.ts` | `core/__tests__/action-risk.test.ts`<br>`core/__tests__/agent-router.test.ts`<br>`core/__tests__/agents-runtime-wiring.test.ts` |
| `core/discovery.ts` | dev-only (Vitest contracts, not packed into EXE) | `agents/core/index.ts`<br>`agents/custom/index.ts`<br>`agents/installed/index.ts`<br>`agents/manifests/index.ts` | `core/__tests__/agents-catalog.test.ts`<br>`core/__tests__/agents-runtime-wiring.test.ts`<br>`core/__tests__/capability-discovery.test.ts` |
| `electron/capabilities.cjs` | shipped (renderer/main process, packed into EXE) | `builder/build-manager/index.ts`<br>`builder/dependency-manager/index.ts`<br>`builder/release-manager/index.ts`<br>`builder/source-manager/index.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/agent-router.test.ts` |
| `electron/skills.cjs` | shipped (renderer/main process, packed into EXE) | `core/__tests__/github-capability-import.test.ts`<br>`core/__tests__/ui-live-honesty.test.ts`<br>`core/registry.ts`<br>`src/lib/friday/marketplace.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/agent-router.test.ts` |
| `electron/agents.cjs` | shipped (renderer/main process, packed into EXE) | `core/registry.ts`<br>`src/routeTree.gen.ts`<br>`src/routes/agents.tsx`<br>`src/routes/n8n.tsx` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/agent-router.test.ts` |

## Browser / Environment

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `src/lib/friday/browser-engine.ts` | shipped (renderer/main process, packed into EXE) | `core/__tests__/full-spectrum-upgrade.test.ts`<br>`core/__tests__/turn-trace.test.ts`<br>`src/components/friday/SelfCore.tsx`<br>`src/lib/friday/brain/core-brain.ts` | `core/__tests__/full-spectrum-upgrade.test.ts`<br>`core/__tests__/turn-trace.test.ts` |
| `electron/sandbox.cjs` | shipped (renderer/main process, packed into EXE) | `core/__tests__/sandbox-command.test.ts`<br>`electron/main.cjs`<br>`electron/sandbox-lab.cjs`<br>`plugins/index.ts` | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/app-guide.test.ts`<br>`core/__tests__/autonomous-core.test.ts` |
| `electron/sandbox-lab.cjs` | shipped (renderer/main process, packed into EXE) | `core/__tests__/sandbox-command.test.ts`<br>`src/lib/friday/sandbox-agent.ts`<br>`src/lib/friday/sandbox-awareness.ts`<br>`src/routes/sandbox.tsx` | `core/__tests__/connector-tools.test.ts`<br>`core/__tests__/sandbox-command.test.ts`<br>`core/__tests__/sandbox-lab.test.ts` |

## Lifecycle

| File | Runtime boundary | Callers (sample) | Tests (sample) |
|---|---|---|---|
| `scripts/release-engine.cjs` | build-time only (not packed into EXE) | _none found_ | `core/__tests__/check-contract.test.ts`<br>`core/__tests__/ci-workflows.test.ts`<br>`core/__tests__/docs-honesty.test.ts` |
| `electron/mcp-client.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | _none found by name-grep_ |
| `electron/capability-verify.cjs` | shipped (renderer/main process, packed into EXE) | _none found_ | `core/__tests__/agent-forge.test.ts`<br>`core/__tests__/agent-pack-import.test.ts`<br>`core/__tests__/capability-verify.test.ts` |

## Before changing any anchor above

1. Open `SOURCE_OWNERSHIP_MAP.json` for that file's full caller/test list (this page only samples up to 4/3).
2. Actually search the repo yourself for imports/callers/tests — the grep behind this file is name-based and can miss or over-match.
3. Confirm whether a more specific owner exists for the exact behaviour you're changing (this catalog is anchor-level, not exhaustive of every file in the subsystem).
4. If the file is 🔒 locked or under a do-not-modify zone, see `AGENTS.md` before editing.
5. After the change, update `FRIDAY_STATE.md` / `AUDIT.md` in the same change if it affects what they claim (per `AGENTS.md`'s same-change documentation rule).
