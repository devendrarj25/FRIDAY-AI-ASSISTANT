# Complete Mobile Remote Experience Contract

## 1. Experience promise

From a phone browser, the owner can open FRIDAY, establish a trusted session, and use FRIDAY as the same system they use on the PC.

The mobile surface exposes:

### Conversation
- conversation list/continuation
- new conversation
- text composer
- attachments
- image/media input
- streaming responses
- progress/status
- citations/source bundles
- structured results
- artifacts
- charts/images/diagrams
- retry/recover where semantically safe
- cancellation where supported
- task steering
- cross-surface handoff

### Voice
- microphone permission and state
- voice session start/stop
- listening/speaking state
- mute
- speaker/output state where browser permits
- barge-in/interruption
- realtime transcript
- spoken response
- visual response alongside speech
- camera controls where supported
- media/device selection where supported
- voice health/connection state
- graceful fallback to text when a media capability is unavailable

### Work
- running tasks
- waiting-for-input
- waiting-for-approval
- paused
- completed
- failed
- canceled
- evidence
- checkpoints
- artifacts
- task history
- task steering
- priority changes where policy allows

### Governance
- approval requests
- requested action
- risk/reason
- scope
- evidence/context
- approve
- reject
- defer
- revoke/stop where authorized
- approval result
- resume state

### Remote PC / FRIDAY control
- connected PC identity
- device/session state
- supported remote capabilities
- remote control session
- active-control ownership
- start/stop control
- screen/visual observation where implemented
- permitted application/device actions
- system status
- remote task initiation
- remote action evidence

### Session and security
- pair/connect
- QR or pairing code flow
- trusted-device state
- authentication
- session expiry
- re-authentication
- permission state
- capability scope
- revoke session/device
- disconnect
- connection diagnostics

## 2. Same working flow

A mobile instruction enters the same canonical turn gateway and brain/task system as desktop input. It must not be routed through a mobile-only planner.

`Mobile input → canonical turn → shared Brain → capability/task routing → governance → execution → verification → canonical result/event → mobile projection`

Voice follows the same shared turn/task truth, with a dedicated low-latency media path.

## 3. PC-touch-free operation

Normal supported operations must be executable from mobile without requiring a user to switch to the PC. Exceptions are limited to things the PC OS itself requires physically/local confirmation for, or actions deliberately blocked by governance/security policy.

The UI must state the exact blocker rather than pretending the action succeeded.

## 4. Output behavior

- short answer: compact rich response
- long answer/research: summary + expandable detail + sources/artifacts
- table/data: responsive data view
- image/diagram: visual preview
- generated file: artifact card and retrieval
- long task: live timeline + milestones
- approval: approval card with action/risk/evidence
- error: actionable recovery
- device action: result + evidence
- voice: spoken summary plus visual detail rather than reading large visual output verbatim

## 5. Surface parity

Parity means **semantic capability and task continuity**, not identical pixels.

Every capability that is mobile-compatible and policy-authorized should advertise:
- whether it is callable
- required input schema
- output schema
- permissions
- risk class
- streaming support
- artifact support
- mobile presentation hints
- browser/device prerequisites
- minimum protocol version

The mobile client renders these contracts through shared generic components.
