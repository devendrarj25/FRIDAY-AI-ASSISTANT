# Fast Safe Change Workflow

Read `../../../AGENTS.md`, then `../../../READMEFIRST.md`, then this file.

Validation gate this workflow implements:
`TASK → ROUTE → OWNER → DEPENDENCY CHECK → SCOPE CHECK → SECURITY/BOUNDARY CHECK → FOCUSED TESTS → REGRESSION TESTS → DIFF/EVIDENCE → PASS/BLOCK`

Fill in `14_TEMPLATES/TASK_PACKET_TEMPLATE.md` as you go through Steps 1–4 —
it's the record of what this gate checked, not extra paperwork.

### Step 1 — classify
Use `01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`. Write `TASK_ID` and
`REQUEST` in the task packet.

### Step 2 — route
Find the canonical owner and source card. Write `CANONICAL_OWNER`.

### Step 3 — narrow context
Read owner + direct dependencies + tests + applicable contract. Write
`ALLOWED_FILES` (start narrow) and `FORBIDDEN_FILES` (locked paths, and
anything clearly outside this task).

### Step 4 — inspect (dependency + scope check)
Search callers, imports, interfaces and state transitions. Write
`DIRECT_DEPENDENCIES`. If this reveals a file genuinely needed beyond the
original `ALLOWED_FILES`, add it there explicitly — don't edit outside the
declared list silently. Confirm the live source file and its tests
before writing anything new — a duplicate registry, router, memory store,
authority, or task system is a scope failure, not a style choice.

### Step 5 — implement
Make the smallest coherent change.

### Step 6 — focused verification
Run unit/type/schema tests for the touched area. Write `REQUIRED_TESTS` and
their result.

### Step 7 — boundary verification (security/boundary check)
If a contract crosses areas, test both sides. Fill `AFFECTED_BOUNDARIES` in
the task packet. **If more than one boundary is affected, this is a
high-impact change** — do the cross-boundary impact analysis, add the extra
tests each boundary needs, and get explicit owner approval before landing
if security/authority is one of the boundaries crossed.

### Step 8 — regression
Run broader tests only when the change surface warrants it. If Step 4 or
Step 5 touched a file or area beyond the original target, treat that file's
own tests as part of this change too — verify it still passes, not just the
original target. A change that fixes one place while quietly breaking
another has not landed safely.

### Step 9 — record (diff/evidence)
Update change ledger and affected contracts. Fill `EVIDENCE` in the task
packet with the actual commands run and their actual output/counts — not a
description of what should have happened.

### Step 10 — stop
Do not refactor unrelated areas merely because they were visible.

### Step 11 — report (PASS/BLOCK)
State PASS or BLOCK explicitly, then tell the owner what changed, what was
checked (tests/lint/typecheck run, with real results), and what was
found/fixed — in a few lines. A model's own claim that something works is
not evidence; the command output from Steps 6–9 is. BLOCK and say why
rather than reporting PASS on a hope. Do not attach logs, screenshots,
recordings, or other proof artifacts unless the owner asks for them; the
change ledger (Step 9) is where the full evidence lives.
