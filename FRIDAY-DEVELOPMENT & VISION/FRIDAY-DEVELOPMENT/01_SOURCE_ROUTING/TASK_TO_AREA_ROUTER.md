# Task → Area Router

Use the first matching category; if multiple categories match, load the listed cross-area contract.

| Task signal | Primary area | Read next |
|---|---|---|
| model/provider/fallback/cost/latency | Intelligence | `03_INTELLIGENCE_FABRIC/*` |
| memory/knowledge/recall/personalization | Memory | `06_MEMORY_KNOWLEDGE/*` |
| agent/delegation/handoff/worker | Agents | `04_AGENT_RUNTIME/*` |
| tool/skill/plugin/module/connector | Capability | `05_CAPABILITY_FABRIC/*` |
| browser/screen/device/app action | Execution | `07_EXECUTION_VERIFICATION/*` |
| permission/approval/privacy/secret | Security | `09_SECURITY_GOVERNANCE/*` and `src/lib/friday/self/run-receipt.ts` |
| task/resume/retry/checkpoint | Task Runtime | `src/lib/friday/self/task-graph.ts` and `src/lib/friday/self/run-receipt.ts` |
| UI/chat/voice/realtime interaction | Experience | existing `UI-UX-Design-Document.md` + runtime contract |
| build/installer/update/uninstall | Lifecycle | `11_TESTING_RELEASE/*` |
| test/regression/release | Quality | `11_TESTING_RELEASE/*` |
| self-learning/evolution | Improvement | `08_OBSERVABILITY_EVALUATION/*` + `12_MIGRATION_ROADMAP/*` |

Never infer ownership from filenames alone. Confirm the existing owner and tests.

**Major/future-upgrade task** (not a routine fix — see `12_MIGRATION_ROADMAP/`)
→ before designing anything, refresh `13_RESEARCH/PRIMARY_RESEARCH_URLS.md`
against its listed official sources and fold real findings into
`13_RESEARCH/RESEARCH_SYNTHESIS_2026.md` and the relevant
`FRIDAY-VISION/AREAS/*` target spec. Don't design "latest and
future-proof" from memory.
