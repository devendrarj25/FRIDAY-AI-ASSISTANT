# Definition of Done

- One canonical interaction contract is used by Chat, Voice and Mobile.
- Manual/Auto are explicit policy inputs and not separate engines.
- Same task ID remains valid across surfaces and restart.
- Voice has real streaming ASR/TTS, full duplex and stale-generation/barge-in protection.
- Mobile has authenticated scoped sessions, realtime events, reconnect/cursor reconciliation and remote approval/control.
- All mutations use the existing governance/authority chain.
- All meaningful completion claims have evidence.
- Existing registries and routers remain the single source of truth.
- No UI redesign was introduced.
- No build/installer/release behavior was changed unnecessarily.
- Targeted tests/typecheck/build/workflow evidence passes.
- Relevant documentation is updated to match the implemented reality.
