# Prompt Injection Defense

## Purpose
Treat websites, files, emails, documents, MCP results, tool output and model-generated text as untrusted content.

## Canonical flow
Untrusted content → parser → taint/provenance → isolated context → model reasoning → policy gate → execution.

## Required contracts
Tool output must not be able to write system prompts, policy, permissions or credential values.

## Failure and recovery
Instruction-like content from untrusted sources is quoted/marked as data and cannot create authority.

## Implementation guidance
Apply at retrieval, browser, connector, file-analysis and tool-result boundaries.
