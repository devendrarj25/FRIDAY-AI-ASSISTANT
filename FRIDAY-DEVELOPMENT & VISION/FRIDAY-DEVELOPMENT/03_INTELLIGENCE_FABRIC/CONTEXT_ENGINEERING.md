# Context Engineering Contract

FRIDAY treats context as a bounded runtime resource.

Build context in layers:
1. identity/policy;
2. current request;
3. task state;
4. minimal relevant memory;
5. source cards;
6. direct dependencies;
7. tools/capabilities needed now;
8. verification evidence.

Do not dump the whole repository, all memory, all tools or all agent definitions into every model turn.

Compress:
- stale history;
- redundant observations;
- completed tool results;
- superseded plans.

Preserve:
- unresolved constraints;
- authoritative facts;
- approvals;
- task checkpoints;
- evidence;
- failure lessons relevant to reuse.

This is the primary token/time optimization contract.
