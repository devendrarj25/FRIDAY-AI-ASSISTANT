# Voice Experience Contract

## Purpose
Voice adds hearing/speaking and wake behavior over the same brain.

## Canonical flow
Audio capture → STT → turn envelope → common brain → response → TTS/character output.

## Required contracts
Audio provenance, transcript confidence, interruption/barge-in and endpoint state are typed.

## Failure and recovery
Low-confidence transcription may trigger clarification; audio failure can fall back to text/manual.

## Implementation guidance
Extend voice STT/audio/wake/state/character bridge.
