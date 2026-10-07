# FRIDAY VISION — Master Upgrade Plan Workspace

This is the single planning workspace for FRIDAY's area-specific upgrade blueprints.

**Source-of-truth rule:** the FRIDAY repository is authoritative for implementation. This folder is the architecture/planning layer that tells an AI or developer what to inspect and how the areas connect.

## Goals
- Keep all deep upgrade plans together.
- Connect areas through explicit dependency and ownership maps.
- Reduce context/token waste with narrow file routing.
- Prevent duplicate systems (registries, routers, installers, release engines).
- Make cross-area impacts visible before implementation.

## Working rule
`Master index → relevant area plan → exact source owners → direct dependencies → tests → implementation → verification`.

Do not read the entire repository for a localized change unless the dependency map shows a cross-cutting impact.
