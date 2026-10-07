# Master Contracts

FRIDAY VISION uses a small number of cross-area contracts.

## Identity
Every durable entity has a stable ID:
- task
- run
- component
- runtime
- model/provider
- memory item
- project
- capability
- artifact

Names are display metadata, not identity.

## Ownership
Every installable component has:
- `owner`: official | user | imported | managed
- `source`
- `version`
- `path`
- `contentHash`
- `compatibility`
- `dependencies`
- `permissions`
- `status`
- `installedAt`
- `lastVerifiedAt`

## Authority
Actions pass through:
`request → capability check → policy → risk classification → approval if required → execution → evidence`.

## Lifecycle
`discovered → planned → staged → installed → verified → active → disabled → removed`.

Never jump from download directly to active.

## State separation
- application state: replaceable
- user component state: preserved
- user data: preserved
- caches/temp: disposable
- recovery evidence: protected until transaction commit
