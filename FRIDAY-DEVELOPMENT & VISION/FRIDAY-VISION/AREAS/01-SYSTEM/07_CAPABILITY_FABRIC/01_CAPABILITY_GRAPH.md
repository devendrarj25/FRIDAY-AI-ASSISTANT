# Capability Graph

## Purpose
Represent tools, skills, workflows, agents, modules, connectors and external services as typed capabilities with dependencies and health.

## Canonical flow
Discover → validate manifest → register → dependency check → health probe → route → execute → measure → retire/upgrade.

## Required contracts
Capability metadata: stable ID, version, owner, input/output schema, modalities, side effects, permissions, dependencies, resource cost, health and fallback alternatives.

## Failure and recovery
Broken dependency marks capability degraded instead of deleting it from the registry.

## Implementation guidance
Extend existing capability-registry, capability seed/trees and specialized routers.
