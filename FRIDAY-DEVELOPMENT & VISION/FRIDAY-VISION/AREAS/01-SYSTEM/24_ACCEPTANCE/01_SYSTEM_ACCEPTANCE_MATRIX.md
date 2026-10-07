# System Acceptance Matrix

| Area | Must prove |
|---|---|
| Chat | Typed request reaches shared brain and returns response/artifact/activity without UI task ownership |
| Voice | STT → shared brain → TTS works and shares task/memory IDs with Chat |
| Companion | Same task visible remotely; reconnect resumes from cursor/checkpoint |
| Manual | User remains required for configured approvals; background work continues |
| Auto | Permitted tasks progress without UI clicking; gated actions still stop for approval |
| Routing | Model/capability failure triggers bounded fallback or escalation |
| Memory | A verified cross-session fact is retrievable with provenance |
| Artifact | At least one generated file is validated and traceable to source task |
| File analysis | Uploaded file is parsed/understood with source references |
| Computer use | Browser/desktop action uses broker, risk and verification |
| Policy | Tampered/missing policy blocks privileged action |
| Self-repair | Synthetic fault produces diagnosis + bounded repair evidence |
| Self-development | Candidate change is sandboxed, tested, built and can be rolled back |
| Observability | Trace IDs connect turn → task → model/tool → result |
| Recovery | Restart resumes a durable task without unsafe duplicate side effect |
| Build | Existing build/install/release path remains functional |
