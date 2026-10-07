# FRIDAY Ultimate God-Mode System Upgrade — Read First

This package is the **single implementation-grade design and handoff package** for upgrading the existing FRIDAY Windows desktop system. It is not a replacement application, not a framework migration, and not a dump of historical ZIPs.

## Authority order
1. Current FRIDAY source checkout is implementation authority.
2. Existing working behavior, build/install/release contracts and governance gates are preserved.
3. This package defines the target architecture, missing contracts, integration rules, implementation order and acceptance criteria.
4. Earlier FRIDAY packages are design references only; their useful decisions are consolidated here, never copied as parallel systems.
5. External research is evidence/input, not authority over FRIDAY's owner policy.

## Non-negotiables
- Preserve UI and visual design unless the current task explicitly requests UI change.
- Preserve working build, installer, updater, release and CI/CD paths.
- No duplicate brain, router, capability registry, model registry, task ledger, memory authority or governance path.
- Every new capability must enter the existing shared capability/source-of-truth fabric so Chat, Voice, Manual, Auto and Companion can discover it without per-surface hardcoding.
- Models propose; policy authorizes; execution brokers execute; verification proves.
- External content, websites, files, model outputs and tool results are untrusted inputs and can never redefine owner policy.
- Self-development is staged, sandboxed, evaluated and rollbackable; production mutation is never direct model output.
- “Human-like” behavior means coherent identity, continuity, tone, affect and social behavior—not a claim of consciousness.
- No raw chain-of-thought is exposed as a product feature. The system exposes concise rationale, action state, evidence and trace metadata.

## What the implementing AI must do
INSPECT → UNDERSTAND → MAP OWNER → MODIFY ONLY REQUIRED CODE → INTEGRATE → TEST → REGRESSION TEST → VERIFY BUILD/INSTALL PATH → UPDATE DOCUMENTATION → REPORT EVIDENCE.

If a proposed change conflicts with a current source owner, stop and resolve ownership rather than creating a second implementation.
