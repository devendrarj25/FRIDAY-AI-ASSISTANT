# Mobile Companion — Screen and Component Catalog

## 1. Global shell
- connection indicator
- FRIDAY identity/instance indicator
- notification entry
- current mode indicator (Manual/Auto)
- active task shortcut
- voice control shortcut where available

## 2. Conversation screen
### Required regions
- conversation history
- streaming response area
- attachment area
- input composer
- voice control
- task/progress strip when the turn becomes durable work
- artifact/result cards
- approval cards
- retry/reconnect state

### Result card types
- answer
- citation/source bundle
- image/visual
- chart/data
- generated file
- code/artifact
- task progress
- approval request
- warning/error
- device/control result

## 3. Task center
Each task row exposes status, last meaningful event, owner/FRIDAY action requirement, and latest artifact state.

Task detail exposes the full canonical task projection, not a locally reconstructed copy.

## 4. Approval center
Approval cards are immutable snapshots of the exact approval request until resolved/expired. Resolution returns to canonical runtime.

## 5. Artifact center
Artifacts are first-class outputs. The UI must support preview, open, retrieve, share/export if authorized, version navigation where supported, and provenance.

## 6. Device center
Shows authorized devices and capability scope. Device control starts an explicit session and ends/revokes it explicitly.

## 7. Activity center
Shows canonical events filtered to user-meaningful milestones. Raw diagnostics remain in diagnostics surfaces.

## 8. Notifications
Notifications are references to authoritative state. Tapping one must deep-link to the relevant task/approval/artifact/device state.

## 9. Settings
Settings change policy/configuration only through existing authoritative owners.

## UI state ownership
The mobile renderer owns presentation state only. Runtime state belongs to FRIDAY's shared state/event/task systems.
