# Live Interaction Presentation State

## Canonical live states
`idle → listening/composing → accepted → understanding → planning → executing → observing → verifying → composing_result → presenting → completed`

Side states:
- `waiting_input`
- `waiting_approval`
- `paused`
- `canceling`
- `reconnecting`
- `recovering`
- `failed`

## Surface behavior
### Chat
Shows meaningful progress and streamed response/artifact events.

### Voice
Maintains the live media loop while deeper work continues asynchronously. It may speak short preambles/status updates without waiting for the entire task.

### Mobile
Shows compact state transitions and can subscribe/reconnect to the same task stream.

## Event truth
A state transition is emitted by the runtime/event fabric. UI components consume it; they do not create authoritative state transitions.
