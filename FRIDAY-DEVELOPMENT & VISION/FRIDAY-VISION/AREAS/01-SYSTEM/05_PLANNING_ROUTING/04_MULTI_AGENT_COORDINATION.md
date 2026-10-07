# Agent Hierarchy and Coordination

## Purpose
Agents are specialized workers under one FRIDAY executive authority. They do not become independent policy authorities.

## Canonical flow
Executive → specialist assignment → shared task context → worker execution → evidence → executive verification → memory.

## Required contracts
Agent contracts define role, capabilities, allowed data, tools, budget, timeout, output schema and escalation rules.

## Failure and recovery
Agent disagreement becomes evidence for arbitration; it does not authorize conflicting actions.

## Implementation guidance
Use existing agent registry/router/runtime; add typed delegation envelopes.
