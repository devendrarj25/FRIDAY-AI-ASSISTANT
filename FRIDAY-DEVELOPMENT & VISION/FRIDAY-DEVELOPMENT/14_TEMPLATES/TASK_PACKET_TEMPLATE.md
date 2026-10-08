# Task Packet

Fill this in before touching any file — for any task, not only large ones.
It exists so an AI works from a declared, bounded scope instead of reading
the whole repository to "figure out" what's relevant. See
`FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md`
Steps 1–3 for how to derive each field.

```
TASK_ID:              <short slug, e.g. voice-interim-transcript-2026-09-18>
REQUEST:              <what the owner actually asked for, in one or two lines>
CANONICAL_OWNER:      <the live source file that already owns this behavior>
ALLOWED_FILES:        <every file you expect to edit — start narrow, add to
                        this list only when Step 4 (inspect) proves a real
                        need, never edit outside it silently>
FORBIDDEN_FILES:      <locked files (AGENTS.md's locked-path list) and
                        anything outside this task's boundary — name them
                        explicitly if the task is anywhere near them>
DIRECT_DEPENDENCIES:  <callers/importers of ALLOWED_FILES — from
                        SOURCE_OWNERSHIP_MAP.json's callers_sample, verified
                        by your own search, not assumed>
AFFECTED_BOUNDARIES:  <which subsystems this crosses — Runtime / Build /
                        Installer / Updater / Memory / Model routing /
                        Tools-Agents-Capabilities / UI. More than one =
                        high-impact, see CROSS_BOUNDARY note below>
REQUIRED_TESTS:       <the specific test files this task must keep green —
                        not "run everything," name them>
ROLLBACK_PLAN:        <how to undo this change if it's wrong — usually
                        "revert this diff," but say so explicitly, and say
                        more if the change touches data/migrations>
EVIDENCE:             <filled in AFTER the change: which commands you ran,
                        pass/fail counts, and what you found — not a claim
                        of success without a command behind it>
```

## Cross-boundary rule
If `AFFECTED_BOUNDARIES` lists more than one subsystem, treat this as a
**high-impact change**: do the dependency/impact analysis for each boundary
crossed, add the tests each boundary would otherwise not exercise, and — if
the crossing touches security/authority — get the owner's explicit go-ahead
before landing, not after.

## What "done" means
`EVIDENCE` is populated with real command output/counts, `REQUIRED_TESTS`
are green, nothing outside `ALLOWED_FILES` changed without being added to
that list first, and the change ledger entry exists. A model's own
description of what it did is not evidence — the command output is.
