# Handoff and Parallelism

Use specialists when decomposition reduces total work.

Safe parallelism:
- independent read-only research;
- independent candidate generation;
- isolated workspace changes;
- independent verification.

Serialize:
- conflicting writes;
- migrations;
- shared mutable registry updates;
- destructive actions;
- final state commits.

Every handoff returns:
- result;
- evidence;
- confidence;
- unresolved issues;
- artifacts;
- verification state.
