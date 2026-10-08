# Task → Area Router

Use the first matching category. The product owner is the read-next path.
The numbered development folders for these areas were removed after the
tests passed.

| Task signal | Primary area | Read next |
|---|---|---|
| model/provider/fallback/cost/latency | Intelligence | `electron/model-router.cjs` |
| memory/knowledge/recall/personalization | Memory | `src/lib/friday/self/memory-engine.ts` |
| agent/delegation/handoff/worker | Agents | `src/lib/friday/self/agent-scheduler.ts` |
| tool/skill/plugin/module/connector | Capability | `kernel/tools.py` and `src/lib/friday/self/run-receipt.ts` |
| browser/screen/device/app action | Execution | `src/lib/friday/self/computer-use.ts` |
| permission/approval/privacy/secret | Security | `src/lib/friday/self/run-receipt.ts` |
| task/resume/retry/checkpoint | Task Runtime | `src/lib/friday/self/task-graph.ts` |
| UI/chat/voice/realtime interaction | Experience | the existing chat and Auto session |
| build/installer/update/uninstall | Lifecycle | `docs/FRIDAY_CHANGE_CONTROL.md` |
| test/regression/release | Quality | `docs/FRIDAY_CHANGE_CONTROL.md` |
| self-learning/evolution | Improvement | `src/lib/friday/self/run-receipt.ts` |

Never infer ownership from filenames alone. Confirm the existing owner and tests.

A major upgrade refreshes the research notes in `docs/FRIDAY_CHANGE_CONTROL.md`
before designing. Don't design from memory.
