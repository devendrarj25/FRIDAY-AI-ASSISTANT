# One Brain Contract

## Purpose
Chat, Voice and Mobile are experience endpoints over the same FRIDAY brain, task system, memory and governance. They are not separate assistants.

## Canonical flow
Endpoint input → shared turn envelope → common brain → shared task/execution → endpoint-specific rendering.

## Required contracts
Cross-endpoint messages share conversation/task IDs and preserve modality metadata.

## Failure and recovery
An endpoint disconnect never cancels durable work unless explicitly requested.

## Implementation guidance
Use existing cross-mode sync and companion architecture.
