# Context Packet Rules

A coding agent should receive a compact packet:

1. task statement;
2. relevant source card;
3. canonical owner file(s);
4. direct dependency files;
5. relevant tests;
6. applicable contract;
7. known constraints;
8. expected verification.

## Context budget policy
- Prefer summaries/indexes over whole repositories.
- Read full files only when they are owners or directly edited.
- Read adjacent files only for imports, contracts, types, lifecycle or tests.
- Stop exploration once ownership and dependency closure are established.
- Re-open broader context only when validation reveals an unexpected coupling.

## Routing confidence
`exact > high > medium > broad-search`

If confidence is low, search before editing.
