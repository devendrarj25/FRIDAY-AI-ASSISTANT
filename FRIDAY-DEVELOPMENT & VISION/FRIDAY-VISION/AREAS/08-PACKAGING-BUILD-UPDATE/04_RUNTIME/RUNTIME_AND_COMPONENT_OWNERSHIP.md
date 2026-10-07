# Runtime and Component Ownership

Every runtime/component is independently versioned and tracked.

FRIDAY version:
`1.2.14.50`

Example user components:
- `com.dev.agent.research@3.4.1`
- `com.dev.skill.pdf@2.7.0`
- `runtime.custom-python@3.13.7`

A FRIDAY update does not imply an update of user components.

If an official update makes a user component incompatible, preserve it and mark it `incompatible`/`disabled`, offering upgrade/repair options. Never silently delete it.

Runtime activation must be selected through the registry, not by hard-coded random paths.
