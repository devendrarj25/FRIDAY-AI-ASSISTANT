# Multimodal Fusion

## Purpose
Combine text, image, audio and video evidence into one task context without losing modality provenance.

## Canonical flow
Modality adapters → normalized evidence units → temporal/spatial alignment → fusion → reasoning → cited result.

## Required contracts
Each evidence unit retains source artifact, timestamp/page/frame/region when applicable and confidence.

## Failure and recovery
If a modality is unsupported, the planner can route to extraction/transcoding or continue with an explicitly reduced evidence set.

## Implementation guidance
Use current model capability registry to select multimodal models/adapters.
