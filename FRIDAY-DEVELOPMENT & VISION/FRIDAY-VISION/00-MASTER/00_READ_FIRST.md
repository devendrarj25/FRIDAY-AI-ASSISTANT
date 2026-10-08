# FRIDAY VISION — READ FIRST

FRIDAY VISION is the engineering control plane for upgrading FRIDAY as an AI-OS-like desktop system.

## What this folder is
- A connected set of area-specific architecture/upgrade blueprints.
- A routing system that tells an AI/developer what to inspect first.
- A contract and dependency map for cross-area changes.
- A place to record architectural decisions and implementation status.

## What this folder is NOT
- It is not the source-code authority.
- It is not a second copy of FRIDAY-main.
- It must not become a second implementation of a registry, router, brain, memory, updater, or installer.

## Source authority
1. Actual FRIDAY repository/source code is authoritative for implementation state.
2. FRIDAY VISION is authoritative for the approved target architecture until the repository implements and verifies it.
3. Tests and runtime evidence outrank assumptions in prose.

## Core product goal
FRIDAY should behave as a cohesive AI OS:
- one identity and context fabric
- one authority/security model
- one component registry
- one runtime/environment registry
- one model/provider routing layer
- one memory/knowledge fabric
- one capability fabric
- one lifecycle/update/recovery control plane
- multiple interaction surfaces over the same core

## Non-negotiable preservation rule
Official application payload may be replaced during an update.
User-owned components and user data must not be deleted or overwritten by an official update.

## Related
For a task that fixes or extends something that already exists in the
current app, don't start here — use
`../../../docs/FRIDAY_CHANGE_CONTROL.md` instead, which routes
straight to the real source owner with far less context. Come here only for
a future/major upgrade. Repo-root order is `../../../AGENTS.md`, then `../../../READMEFIRST.md`.
