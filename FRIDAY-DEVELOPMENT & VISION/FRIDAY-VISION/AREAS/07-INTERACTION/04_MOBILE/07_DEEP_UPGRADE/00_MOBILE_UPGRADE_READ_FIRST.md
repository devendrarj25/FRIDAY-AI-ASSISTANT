# Mobile Companion Deep Upgrade — Read First

This addendum deepens the existing Mobile Companion architecture. It does **not** replace, remove, or downgrade any existing Mobile, Chat, Voice, Manual, Auto, security, output, task, event, or governance design.

## Product intent

The Mobile Companion is a **complete mobile-optimized FRIDAY experience surface** over the same authoritative FRIDAY runtime. It is not a limited notification viewer and it is not a second FRIDAY implementation.

The mobile surface must allow the owner to perform the full set of **compatible and authorized** Chat and Voice interactions, inspect and steer work, approve gated actions, consume artifacts/results, manage the remote session, and control permitted FRIDAY/PC capabilities without physically touching the PC.

## Visual rule

Mobile is not required to look pixel-identical to desktop. The FRIDAY identity, semantics, information hierarchy, interaction meaning, and state vocabulary remain consistent; layout, navigation, density, touch targets, panels, sheets, and presentation adapt to the phone.

This is a functional architecture requirement, not a request to redesign the existing FRIDAY visual identity.

## Non-negotiables

- One Brain.
- One task truth.
- One capability registry.
- One governance/authority path.
- One event fabric.
- One memory/knowledge truth.
- One execution authority.
- Chat, Voice, and Mobile are surfaces.
- Manual and Auto are operating modes.
- Mobile does not duplicate runtime logic.
- Mobile does not invent completion from UI state.
- A browser permission grant never grants PC authority.
- A network connection never grants action authority.
- Refresh/reconnect never blindly replays mutations.
- Remote commands retain the same risk and approval semantics as desktop commands.
- New compatible capabilities should become discoverable through the authoritative capability/contract system without a bespoke mobile feature implementation.
- Unsupported browser/OS capabilities must be explicitly detected and degraded; they must never be reported as working.
- The build/installer/release system is outside scope unless implementation evidence proves a required dependency.
