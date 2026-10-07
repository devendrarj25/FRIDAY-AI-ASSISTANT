# Cross-Modal Handoff and Steering

## Example
User starts: Chat → “research this and prepare a report.”
Then: Voice → “continue but skip the vendor comparison.”
Then: Mobile → inspect progress and approve an external upload.
Then: Chat → open the finished artifact.

All four actions operate on the same conversation/task state.

## Steering command semantics
- `inspect`: read authoritative state/evidence
- `pause`: stop at the next safe checkpoint
- `resume`: continue from verified checkpoint
- `cancel`: cancel task according to cancellation policy
- `approve/reject`: resolve exact pending approval
- `prioritize`: update scheduling priority
- `redirect`: append/replace objective constraints subject to governance
- `request_artifact`: retrieve latest verified artifact

## Continuity rule
A new modality does not imply a new task. A new task is created only when the runtime determines the objective is materially distinct or the user explicitly asks for separation.

## Voice-to-mobile and mobile-to-chat
The event fabric is the bridge. Surfaces do not send hidden direct messages to each other; they subscribe to canonical runtime events.
