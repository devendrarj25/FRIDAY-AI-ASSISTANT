# Manual and Auto Operating Modes

## Purpose
Manual controls user-driven progression while assigned background work and notifications continue. Auto permits permitted autonomous execution through the same governance chain.

## Canonical flow
Mode + task risk + authority → allowed autonomy level → execution/approval behavior.

## Required contracts
Mode is an operating-axis field, not a replacement for Chat/Voice/Mobile modality.

## Failure and recovery
High-risk/owner-only actions remain approval-gated even in Auto. Auto cannot modify policy root.

## Implementation guidance
Extend assistant-mode, self autonomy and governance rather than duplicating modes.
