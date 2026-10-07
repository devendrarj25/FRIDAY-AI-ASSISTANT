# Mobile Companion — Functional UI Architecture (No New Visual Design)

## Purpose
This document defines **what the Mobile Companion UI must contain and expose functionally**. It does not prescribe colors, typography, branding, animations, or a replacement visual design. The existing FRIDAY visual identity remains authoritative.

## Core rule
Mobile is a remote experience surface over the same FRIDAY runtime. The phone must never become a second Brain, Task Manager, Memory Store, Capability Registry, or Governance system.

## App shell
The mobile shell is a projection of canonical runtime state and should provide:

1. **Connection / FRIDAY status**
   - online/offline/reconnecting
   - connected FRIDAY instance identity
   - network path (local/private overlay/other approved path)
   - session expiry/re-auth state
   - last authoritative sync time/version

2. **Primary conversation surface**
   - conversation/task timeline
   - text input
   - voice input/output controls where enabled
   - attachment intake
   - active task indicator
   - response streaming
   - tool/progress/status events at appropriate detail

3. **Active work / Tasks**
   - running
   - waiting for user input
   - waiting for approval
   - paused
   - completed
   - failed / needs attention
   - recently completed
   - task detail with objective, progress, current step, evidence, artifacts, next required action

4. **Approvals / Governance**
   - exact action requesting approval
   - why it is required
   - affected resource
   - risk level
   - action arguments / scope summary
   - expiration
   - approve / reject / inspect
   - approval result
   - no blanket “approve all” authority escalation

5. **Artifacts / Results**
   - latest artifacts for a task
   - files, images, structured data, reports, links, previews
   - artifact version/status
   - provenance / generated-by-task relationship
   - open/share/export actions according to policy

6. **Activity / Live execution**
   - meaningful milestones, not fake spinner activity
   - current stage
   - waiting reason
   - tool/capability currently active when safe to expose
   - verification state
   - recoverable errors

7. **Devices / Remote Control**
   - authorized FRIDAY devices
   - device/session status
   - available capability scopes
   - remote screen/session view where enabled
   - remote input/control where enabled
   - explicit start/stop of remote control session
   - visible active-controller indicator

8. **Memory / Context inspection**
   - only the user-facing memory controls already permitted by FRIDAY policy
   - show relevant remembered facts/decisions when useful
   - correct/forget controls must route through canonical memory policy

9. **Notifications / Attention inbox**
   - approval required
   - task completed
   - task failed
   - important evidence arrived
   - connection/security event
   - proactive event only when interruption-value policy permits

10. **Settings / Account / Security**
    - device pairing
    - session/device revocation
    - notification preferences
    - voice preferences
    - network/connection configuration
    - privacy controls
    - diagnostics

## Mobile navigation model
The exact visual navigation remains compatible with the existing product design. Functionally, the information architecture must support:

`Home/Chat → Active Work → Approvals → Artifacts → Devices/Remote → Activity/Notifications → Settings`

A surface may combine or reorder these destinations without changing their underlying ownership.

## Mobile conversation states
Every conversation view must distinguish:
- composing
- submitted
- accepted
- processing
- streaming
- waiting for user
- waiting for approval
- paused
- completed
- failed
- canceled
- reconnecting / stale local view

The UI never invents state from local animations. It renders authoritative runtime state.

## Mobile task detail
A task detail screen should be able to answer, without opening the desktop:
- What did I ask FRIDAY to do?
- What is FRIDAY doing now?
- What has actually completed?
- What evidence proves it?
- What is waiting on me?
- What can I safely change/cancel/pause?
- What artifacts are ready?
- What happens next?

## Remote control UX contract
When remote control starts, the mobile UI must visibly indicate:
- target device
- active remote-control session
- current permission scope
- whether input/control is enabled
- whether FRIDAY or the human currently has interaction priority
- stop/revoke control action

Remote control must not silently grant shell, filesystem, credential, or unrestricted system authority.

## Reconnect UX
On disconnect:
- show connection state, not a false task failure
- preserve the last known authoritative snapshot locally for display
- disable unsafe duplicate mutation actions until authoritative state is revalidated
- reconnect using session identity
- reconcile version/cursor gaps
- apply authoritative snapshot/events
- re-enable actions only after capability/authority validation

## Accessibility and low-bandwidth behavior
The functional contract must support:
- text-first fallback
- reduced visual payloads
- artifact download/retrieval on demand
- progressive image/preview loading
- voice unavailable → text
- streaming unavailable → snapshot/polling/retrieval
- remote screen unavailable → task/status controls remain available

## Never do
- create local-only task truth
- mark a task complete because the client disconnected after a request
- replay a mutation blindly after reconnect
- infer approval from a previous UI state
- expose credentials merely because remote control is enabled
- create a second mobile-specific memory or planner
