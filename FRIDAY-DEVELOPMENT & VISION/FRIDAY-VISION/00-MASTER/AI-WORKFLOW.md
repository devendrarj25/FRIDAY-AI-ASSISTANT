# FRIDAY VISION — AI Narrow-Context Workflow

## Purpose
Save context/tokens while improving accuracy.

### 1. Identify
Read `INDEX.md`, then `AREA-DEPENDENCY-MAP.md`.

### 2. Route
Use `FILE-ROUTING-MAP.md` to select exact source owners.

### 3. Inspect
Read:
- the relevant area plan,
- primary owner files,
- direct callers/imports/interfaces,
- affected tests,
- adjacent-area contracts only when dependency impact exists.

Do not ingest the whole repository by default.

### 4. Plan
Record current behavior, exact owners, contracts, compatibility/migration impact, tests, security/rollback impact and documentation impact.

### 5. Implement
Modify the smallest correct owner set. Extend existing registries/routers/managers instead of creating duplicates.

### 6. Verify
Run focused tests, then cross-area tests, then full release gates when appropriate.

### 7. Sync
Update this planning workspace when architecture changes. The repository remains authoritative for actual implementation.
