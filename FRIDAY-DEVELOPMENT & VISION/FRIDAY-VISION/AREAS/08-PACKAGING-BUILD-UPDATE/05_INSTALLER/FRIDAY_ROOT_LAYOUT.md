# FRIDAY Managed Root Layout

Preferred logical layout:

```text
FRIDAY/
├── app/
│   ├── current/
│   ├── versions/
│   └── previous/
├── runtime/
│   ├── official/
│   └── user/
├── components/
│   ├── official/{agents,skills,tools,plugins,workflows}
│   └── user/{agents,skills,tools,plugins,workflows}
├── models/
├── packages/
├── downloads/
├── data/
│   ├── memory/
│   ├── knowledge/
│   ├── settings/
│   ├── projects/
│   └── user-data/
├── cache/
├── logs/
├── temp/
├── backups/
├── updater/
├── recovery/
├── registry/
└── manifests/
```

The implementation may adapt exact subpaths to Electron/Windows constraints, but ownership boundaries must remain.

Do not use symlinks/junctions as the primary correctness mechanism. Prefer explicit paths and a registry because they are easier to repair and uninstall safely.
