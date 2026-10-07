# Multimodal Generation Matrix

## Purpose
Define generation targets for text, Markdown, JSON, CSV, code, PDF, DOCX, XLSX, PPTX, SVG/diagrams, images, audio and video. Capability availability is runtime-discovered rather than hardcoded in the UI.

## Canonical flow
Request → output requirements → generator candidates → composition → validation → artifact.

## Required contracts
Each format has required validators and optional previewers. Multi-file jobs use a parent artifact bundle with child lineage.

## Failure and recovery
Missing generators fall back to compatible representations or report exactly what is unavailable.

## Implementation guidance
Do not add UI buttons for every format; surface results through the existing artifact/file experience.
