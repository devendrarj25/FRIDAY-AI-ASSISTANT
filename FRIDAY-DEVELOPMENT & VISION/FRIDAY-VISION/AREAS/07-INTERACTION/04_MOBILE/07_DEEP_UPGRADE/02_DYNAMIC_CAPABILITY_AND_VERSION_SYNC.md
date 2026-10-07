# Dynamic Capability, Feature and Version Synchronization

## Goal

Installing/upgrading FRIDAY on the PC must not require a manual mobile UI rewrite for every normal capability addition.

The PC runtime remains authoritative.

## Handshake

On connect/reconnect the mobile client negotiates:

1. protocol version
2. runtime/build identity
3. capability catalog version
4. schema/contract versions
5. event cursor/version
6. feature flags
7. permission model version
8. presentation primitive versions
9. supported transports
10. browser/device capability profile

## Runtime snapshot

The server returns an authoritative snapshot containing:
- FRIDAY instance identity
- current runtime state
- current modes
- active conversation/task references
- capability catalog digest/version
- available compatible capabilities
- permission requirements
- current policy version
- current event cursor
- artifact references
- connection/session state

The snapshot is a synchronization primitive, not a replacement for the canonical source of truth.

## Refresh

A browser refresh:
1. creates/revalidates the session
2. negotiates protocol/schema compatibility
3. fetches current snapshot
4. resumes event streaming from the last known cursor when possible
5. reconciles missed events
6. rehydrates active tasks/conversations
7. refreshes capability/presentation metadata
8. renders the current state

It must not:
- duplicate tasks
- repeat mutations
- assume previous UI state is authoritative
- silently drop newer runtime state

## New FRIDAY capability

When an installed FRIDAY update adds a compatible capability:
- capability registry changes on the PC
- mobile discovers the new catalog/version
- generic mobile renderer exposes it if its contract is supported
- permission/risk requirements are shown
- execution still goes through central authority

A bespoke mobile implementation is only required for a genuinely new interaction primitive or protocol that the existing generic renderer cannot represent.

## Version compatibility

Use explicit compatibility states:
- `compatible`
- `compatible_with_degraded_presentation`
- `requires_client_upgrade`
- `requires_server_upgrade`
- `unsupported`

Never execute an unknown action merely because it appeared in metadata.

## Feature flags

Feature flags are runtime policy/configuration, not a second capability registry. They must reference authoritative capability IDs and schema versions.

## Cache policy

Cached catalog/state is useful for fast shell startup, but it is marked stale until validated against the connected runtime. Mutating actions require fresh authority validation.
