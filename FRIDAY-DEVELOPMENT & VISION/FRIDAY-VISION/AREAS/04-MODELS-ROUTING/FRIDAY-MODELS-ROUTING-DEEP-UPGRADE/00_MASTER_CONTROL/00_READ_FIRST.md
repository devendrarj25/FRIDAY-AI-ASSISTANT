# FRIDAY Models + Providers + Routing — Deep Upgrade Package

## Mission

Upgrade only the **Models / AI Providers / Model Lifecycle / Routing** section of the existing FRIDAY project.

Do **not** rebuild FRIDAY's brain, system, chat, voice or mobile companion. Integrate with those existing contracts.

## Deliverable

The implementation must make FRIDAY capable of:

- discovering real local and cloud providers;
- discovering models from official provider surfaces;
- understanding model metadata and capability evidence;
- downloading/installing local models through the correct runtime;
- connecting to cloud models through the provider's real documented wire;
- operating in Auto, Local Only, Cloud Only and Multi modes;
- manually selecting one or more models;
- automatically selecting one or more models;
- composing model ensembles and pipelines;
- automatically refreshing catalogues and runtime state;
- automatically recovering from transient failures;
- falling back without violating privacy, mode or capability constraints;
- learning from verified latency, reliability and task outcomes;
- remaining extensible when a provider or model appears tomorrow.

## Key architectural decision

**A provider is not a model, a model is not a runtime, a runtime is not a protocol, and a protocol is not a capability.** Keep these as separate resources.

## Evidence rule

Never claim a capability merely because a model name contains `vision`, `reasoning`, `pro`, `coder`, etc. Name heuristics are last-resort evidence only.
