# ARTIFACT PROVENANCE

Every artifact:
artifact_id, type, content_hash, size, creator, task_id, parent_refs, source_refs,
created_at, sensitivity, retention, location, transformations, verification_status.

Transformation edge:
input artifacts → capability → output artifact + evidence.

This enables reproducibility, audit, citations, safe memory extraction and feature debugging.
