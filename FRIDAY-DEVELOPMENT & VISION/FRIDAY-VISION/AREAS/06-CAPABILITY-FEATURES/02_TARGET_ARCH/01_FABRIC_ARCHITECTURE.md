# Target Architecture

```text
                   ┌──────────────────────────────────────┐
                   │             EXPERIENCE               │
                   │ Chat • Voice • Desktop • Mobile      │
                   │ Notifications • Dashboard • API      │
                   └──────────────────┬───────────────────┘
                                      │ Intent / Events
                   ┌──────────────────▼───────────────────┐
                   │         INTENT + CONTEXT PLANE        │
                   │ identity • session • memory • project │
                   └──────────────────┬───────────────────┘
                                      │ requirements
                   ┌──────────────────▼───────────────────┐
                   │          CAPABILITY BROKER            │
                   │ discover • qualify • score • explain │
                   └──────────────────┬───────────────────┘
                                      │ plan
                   ┌──────────────────▼───────────────────┐
                   │          FEATURE COMPOSER             │
                   │ chain • parallel • DAG • delegation   │
                   └──────────────────┬───────────────────┘
                                      │ execution plan
                   ┌──────────────────▼───────────────────┐
                   │          TRUST / POLICY               │
                   │ permissions • risk • approval         │
                   │ sandbox • secrets • budget            │
                   └──────────────────┬───────────────────┘
                                      │ authorized calls
        ┌─────────────────────────────▼─────────────────────────────┐
        │                     EXECUTION FABRIC                       │
        │ tools • skills • agents • workflows • connectors          │
        │ browser • desktop • terminal • files • APIs • devices    │
        │ local/cloud workers • MCP • A2A                           │
        └─────────────────────────────┬─────────────────────────────┘
                                      │ events/artifacts
                   ┌──────────────────▼───────────────────┐
                   │      OBSERVE / VERIFY / LEARN         │
                   │ telemetry • evidence • evals          │
                   │ memory • lessons • capability health │
                   └──────────────────┬───────────────────┘
                                      │
                              feedback to broker
```

## Canonical rule
Every executable operation is represented as a capability invocation with policy, evidence, telemetry and lifecycle state.
