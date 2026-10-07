# FRIDAY Managed Storage Layout

The goal is a coherent FRIDAY-owned ecosystem.

```text
FRIDAY/
├─ app/                 # replaceable official application payload
├─ runtime/
│  ├─ official/
│  └─ user/
├─ components/
│  ├─ official/
│  └─ user/
├─ models/
├─ packages/
├─ downloads/
├─ data/
│  ├─ memory/
│  ├─ knowledge/
│  ├─ settings/
│  ├─ projects/
│  └─ user-data/
├─ cache/
├─ temp/
├─ logs/
├─ backups/
├─ updater/
├─ recovery/
├─ registry/
└─ manifests/
```

## Ownership
`app/` and `components/official/` can be replaced by official releases.
`components/user/`, `runtime/user/`, models explicitly owned by the user, and `data/` are preserved.

## External OS state
Any unavoidable Windows integration (shortcuts, uninstall registration, file associations, service/task registration) must be created through a tracked manifest and removed by the same owner.
