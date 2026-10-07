# Canonical Handoff and Surface Parity Contract

## Handoff envelope
Every cross-surface continuation carries conversation/task/generation/trace IDs, current verified checkpoint, surface identity, mode/policy version, capability version and event cursor where relevant.

## Receiving surface
The receiving surface rehydrates from FRIDAY authority. It may use the prior surface's presentation hints, but never treats rendered UI as canonical truth.

## Voice ↔ Chat ↔ Mobile
- Chat can hand to Voice without creating a new conversation.
- Voice can hand to Mobile without losing task/generation identity.
- Mobile can approve or steer work started on desktop.
- Mobile Voice and Mobile Chat use the same task truth.
- Artifact links remain stable across surfaces.

## Presentation parity
A capability may appear as a rich card in Chat, concise speech in Voice and a compact card/timeline in Mobile. These are projections of the same result layers: truth, explanation, structured data, artifact, evidence and action state.

## Barge-in and handoff
Barge-in stops active speech presentation and invalidates the speech generation. It does not cancel durable execution unless the user explicitly issues a task mutation.
