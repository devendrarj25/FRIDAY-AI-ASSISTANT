# BROWSER CAPABILITY MODEL

Browser capabilities should expose:
session, profile, tabs, navigation, DOM, accessibility tree, network state,
downloads, uploads, auth handoff, screenshots, page extraction, page diff,
browser storage boundaries and takeover.

Prefer persistent named sessions with explicit credential scope.
Do not expose raw cookies/passwords to model context.
