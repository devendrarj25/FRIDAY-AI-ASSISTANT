# Artifact Fabric

## Purpose
Make generated files first-class results. FRIDAY can create, transform, analyze, validate, preview and deliver artifacts without making the chat renderer responsible for file truth.

## Canonical flow
Intent → artifact plan → generator/transformer → workspace → validation → metadata/provenance → preview → delivery → retention.

## Required contracts
Artifact envelope includes ID, type, MIME, path/storage handle, source inputs, generator capability, version, checksum, size, sensitivity, validation status and lineage.

## Failure and recovery
Invalid artifacts are quarantined and regenerated/repaired; a failed preview never means the artifact is valid.

## Implementation guidance
Integrate with attachments/library/workspace/storage and existing output surfaces.
