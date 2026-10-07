# Provider manifest design

A manifest is a declarative capability map; code is still required for protocol-specific behavior.

## Manifest responsibilities

- identity
- class: cloud/local/gateway
- official sources
- auth schemes
- discovery endpoints
- model detail endpoints
- transport wires
- supported operations
- health probes
- error taxonomy
- rate-limit extraction
- lifecycle/deprecation extraction
- pricing source
- privacy boundary
- install capabilities
- runtime controls
- regional/account constraints
- model normalization rules

## Never put these in a manifest

- API keys
- user prompt data
- hardcoded secrets
- volatile health state
- learned performance scores
- user-specific cost budgets

Those belong to secure state stores.
