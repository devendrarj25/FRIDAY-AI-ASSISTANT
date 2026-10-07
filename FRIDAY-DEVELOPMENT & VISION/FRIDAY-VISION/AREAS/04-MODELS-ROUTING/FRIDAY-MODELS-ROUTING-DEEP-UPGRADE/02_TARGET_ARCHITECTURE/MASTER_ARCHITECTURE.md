# Target architecture — FRIDAY Model Intelligence Fabric

FRIDAY should own a layered **Model Intelligence Fabric (MIF)**.

```text
FRIDAY Brain / Planner / Execution
            |
     Task Contract Compiler
            |
   Policy + Privacy Gate
            |
   Candidate Generator
            |
 Capability / Context / Tool Gate
            |
 Provider + Runtime Health Gate
            |
 Performance / Cost / Reliability Scorer
            |
 Diversity + Ensemble Planner
            |
       Route Plan
            |
 Transport / Protocol Adapter
            |
 Provider Runtime
            |
 Model / Agent / Endpoint
```

## Control plane vs data plane

### Control plane

Owns:

- provider manifests
- credentials references
- catalogue snapshots
- model cards
- capability evidence
- hardware inventory
- model installation state
- pricing/limits snapshots
- health state
- routing policies
- learned performance profiles
- deprecation migrations

### Data plane

Owns:

- prompt transformation
- request serialization
- streaming
- tool calls
- multimodal payloads
- model execution
- result normalization
- ensemble execution
- cancellation/timeouts

This separation prevents a provider outage from corrupting the catalogue and prevents catalogue refresh from changing an in-flight request.

## Resource graph

```text
Provider
  ├─ Account / Credential
  ├─ Protocol Adapter
  ├─ Catalogue Source(s)
  ├─ Runtime(s)
  └─ Model Endpoint(s)
        └─ Model
             ├─ Versions / aliases
             ├─ Capabilities
             ├─ Limits
             ├─ Pricing evidence
             ├─ Lifecycle
             ├─ Context/token rules
             ├─ Tool schema support
             ├─ Modality support
             └─ Runtime artifacts (local)
```

## Critical design rule

Do not make `model.id` the primary identity. Use a stable internal resource ID and retain provider-native identifiers as fields. The same model can appear through:

- direct vendor API;
- Azure/Microsoft Foundry;
- AWS Bedrock;
- Google Vertex AI;
- Hugging Face provider;
- OpenRouter;
- a local runtime;
- a self-hosted gateway.

FRIDAY should understand these as **deployments/endpoints of a model**, not as unrelated models.
