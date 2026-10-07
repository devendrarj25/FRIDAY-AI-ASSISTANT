# Protected Areas

Unless a requested capability explicitly requires a change, do not modify:

- `electron-builder.yml`
- `.github/workflows/`
- installer implementation
- release/update engine
- packaging scripts
- public artifact naming/version rules
- existing IPC security allowlists
- storage roots and backup semantics

If a required change touches one of these, the implementation must preserve the original contract and produce real build/install/release evidence.
