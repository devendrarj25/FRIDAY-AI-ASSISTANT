# Universal File Analysis Pipeline

## Purpose
Analyze uploaded or discovered files through type detection, extraction, OCR/transcription, structural parsing, semantic understanding and provenance-aware synthesis.

## Canonical flow
Ingest → hash → classify → safe parse → extract text/structure/media → multimodal model analysis → cross-file linking → findings → answer/artifact.

## Required contracts
Analysis records file hash, parser/version, extracted segments, confidence and source locations.

## Failure and recovery
Malformed or malicious files are isolated; parser failures fall back to safer extractors. Untrusted file instructions never become system instructions.

## Implementation guidance
Extend attachments/import engine/library and brain research/knowledge ingest.
