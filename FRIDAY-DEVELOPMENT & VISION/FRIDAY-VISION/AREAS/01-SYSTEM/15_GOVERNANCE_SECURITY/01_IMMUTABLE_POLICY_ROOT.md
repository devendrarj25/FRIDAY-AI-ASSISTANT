# Immutable Owner Policy Root

## Purpose
The owner policy is the highest application-level authority and must not be editable by models, skills, plugins, connectors, self-development or ordinary UI actions.

## Canonical flow
Boot → locate trusted policy → verify hash/signature/ACL → load read-only snapshot → every privileged action references verified policy version.

## Required contracts
Policy record includes version, hash, signature metadata, owner scope, safety rules, data boundaries, approval requirements and deny rules.

## Failure and recovery
Missing/invalid/tampered policy fails closed for privileged actions. A runtime config cannot silently replace it.

## Implementation guidance
Implement verification at boot and again at authority boundary; use OS filesystem ACL/read-only placement plus cryptographic integrity. Do not rely on “hidden file” or prompt text.
