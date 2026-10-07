# User Component Preservation

This is a hard safety rule:

> Official update packages are not authoritative for user-owned components.

If a user installed `MyAgent` and the new official release does not contain it, the updater must leave it untouched.

If an official component has the same display name as a user component, identity is determined by component ID and ownership, not display name or directory name.

If a user component becomes incompatible:
- preserve files
- preserve registry record
- mark incompatible/disabled
- offer upgrade/repair
- do not silently uninstall
