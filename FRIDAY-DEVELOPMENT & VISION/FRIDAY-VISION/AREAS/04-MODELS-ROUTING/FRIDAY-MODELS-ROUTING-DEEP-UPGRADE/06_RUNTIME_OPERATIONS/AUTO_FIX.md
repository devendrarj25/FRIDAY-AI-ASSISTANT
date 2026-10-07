# Auto-fix / self-healing

FRIDAY's model layer may automatically repair:

- stale provider endpoint cache;
- provider cooldown after successful recovery probe;
- malformed local registry entry;
- interrupted download;
- missing local model registration;
- stale alias pointing at a retired model;
- incompatible local runtime port discovered by health probe;
- broken model card cache;
- duplicate provider records.

## Never auto-fix

- rotate credentials without authorization;
- change privacy mode;
- upload local model weights;
- silently enable a paid provider;
- delete user-selected models;
- silently replace a manually pinned model when fallback is disabled.
