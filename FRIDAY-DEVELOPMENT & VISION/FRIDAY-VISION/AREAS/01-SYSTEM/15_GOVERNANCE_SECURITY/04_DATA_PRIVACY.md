# Data Classification and Privacy

## Purpose
Classify data before storage, retrieval, model routing, connector calls and remote synchronization.

## Canonical flow
Data discovered → classify → allowed destinations → minimize → execute → retention/delete policy.

## Required contracts
Suggested classes: public, internal, personal, sensitive, secret/credential, protected policy.

## Failure and recovery
Unknown classification defaults to the safer boundary until resolved.

## Implementation guidance
Integrate privacy firewall, credentials, storage and provider routing.
