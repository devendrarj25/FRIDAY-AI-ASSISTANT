# Computer Use Patterns

## Best-practice hierarchy
1. Native API / OS accessibility tree / structured DOM.
2. Deterministic automation APIs.
3. DOM or accessibility selectors.
4. Vision grounding.
5. Raw coordinate clicks as last resort.

## Control loop
`Observe → Ground → Risk classify → Plan → Act → Observe → Verify`

## Safety
- isolate sessions
- expire credentials
- constrain domains/apps
- confirm irreversible actions
- detect prompt injection
- preserve screenshots/accessibility evidence
- record exact action sequence
- support takeover and cancel

## Reliability
Use self-healing only inside bounded action templates. Cache successful deterministic steps. Re-plan only when the environment diverges.
