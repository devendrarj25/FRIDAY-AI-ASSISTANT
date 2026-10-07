# Knowledge Freshness

## Purpose
Separate durable facts from rapidly changing external information. Freshness requirements are determined by task type.

## Canonical flow
Claim → source → freshness class → expiry/refresh → verification → memory state.

## Required contracts
A claim stores freshness class such as static, slow-changing, dynamic or volatile plus required verification method.

## Failure and recovery
Dynamic claims trigger web/provider/device refresh when stale; offline mode reports stale status rather than presenting old data as current.

## Implementation guidance
Integrate with research, world model, browser and notification subsystems.
