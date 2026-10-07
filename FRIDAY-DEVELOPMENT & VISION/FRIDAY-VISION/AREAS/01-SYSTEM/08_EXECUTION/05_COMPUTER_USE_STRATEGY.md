# Computer Use Strategy — Tiered and Windows-First

Use the cheapest reliable control surface first:

**Tier 0 — direct API / integration**: deterministic and fastest.

**Tier 1 — Windows UI Automation / accessibility tree**: inspect controls by semantic identity; preferred for native Windows apps.

**Tier 2 — browser DOM/page semantics**: role/name/label/state-aware browser interaction.

**Tier 3 — deterministic keyboard/mouse macros**: only where semantics are unavailable; verify after each meaningful action.

**Tier 4 — screenshot + vision model**: for UIA/DOM-blind or visually complex surfaces.

**Tier 5 — hybrid visual + accessibility loop**: vision locates, accessibility executes, verification confirms.

Each action has a target, precondition, action, expected observation, timeout, cancellation token, risk class and verification predicate. FRIDAY should learn which tier works for each environment, but must fall back to re-observation when the environment changes.

User-activity yield is mandatory for non-urgent foreground actions: if the owner is actively using the target window, queue/duck/pause unless the task has explicit foreground authority.
