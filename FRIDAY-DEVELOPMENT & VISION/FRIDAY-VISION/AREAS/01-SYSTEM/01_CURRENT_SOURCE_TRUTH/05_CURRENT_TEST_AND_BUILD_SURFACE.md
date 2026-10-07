# Current Test and Build Surface

The current repository already contains targeted tests for startup, navigation, conversation intelligence, phone parity, wake word, STT, provider dispatch, capability runtime wiring, connectors, browser observation, terminal/sandbox, tasks/doctor/logs, project workspaces, companion live state, safe update and clean install contracts.

Existing build scripts include web build, desktop build, NSIS, portable packaging, ZIP packaging, typecheck, Vitest, kernel pytest, dependency verification, build verification, boot verification, environment verification and install readiness.

These are protected regression surfaces. The upgrade should add only the minimum new tests needed to prove each new contract.
