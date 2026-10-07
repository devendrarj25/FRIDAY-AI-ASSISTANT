# Chat Context, Retrieval and Memory

Context assembly uses the Brain package's attention/context compiler and the existing retrieval/memory/knowledge systems.

Priority order:
1. current user instruction and explicit constraints;
2. active task/goal/commitments;
3. verified results from the current run;
4. recent conversation state;
5. relevant semantic/episodic/procedural memory;
6. broader knowledge retrieval.

Long-term memory is selective. Do not persist every token. Store durable preferences, facts, decisions, task outcomes and useful learned procedures only when memory policy allows.

Every recalled item should retain provenance/freshness/confidence so conflicting memories can be reconciled rather than silently averaged.
