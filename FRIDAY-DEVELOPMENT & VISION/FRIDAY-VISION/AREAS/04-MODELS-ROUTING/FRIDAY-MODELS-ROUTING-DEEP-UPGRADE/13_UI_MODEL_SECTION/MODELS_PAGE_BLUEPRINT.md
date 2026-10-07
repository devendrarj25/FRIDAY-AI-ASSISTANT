# Models section UI blueprint

## Header

`Models` | `Providers` | `Downloads` | `Routing` | `Health` | `Diagnostics`

## Mode selector

- Auto
- Local Only
- Cloud Only
- Multi
- Manual

## Provider cards

Each card shows:

- provider name;
- cloud/local/gateway;
- connection state;
- authenticated;
- catalogue freshness;
- available model count;
- current health;
- latency;
- last error;
- key source (never secret).

## Model explorer

Filters:

- local/cloud
- provider
- capability
- context
- speed
- quality
- price
- status
- installed/not installed
- loaded/unloaded

## Model detail drawer

Show:

- identity
- native ID
- deployment
- capabilities with evidence
- lifecycle
- context/output limits
- pricing
- performance
- runtime/quantization
- install state
- official source links
- “Use this model”
- “Add to Multi”
- “Set as Auto preference”

## Routing preview

Before a manual test, show:

`Task → candidates → rejected reasons → selected route → fallback chain`

This is one of the most important debugging tools for FRIDAY.
