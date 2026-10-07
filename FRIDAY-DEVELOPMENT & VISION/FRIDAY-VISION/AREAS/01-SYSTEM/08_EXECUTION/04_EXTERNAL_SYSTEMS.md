# External Systems and Connectors

## Purpose
Connect APIs, MCP servers, A2A agents and plugins through explicit contracts and scoped credentials.

## Canonical flow
Discover endpoint → authenticate → capability manifest → policy scope → invoke → validate response → record provenance.

## Required contracts
Credential references are handles, not prompt text. Connector outputs are untrusted data.

## Failure and recovery
Auth failure, schema drift and remote compromise suspicion trigger connector degradation/quarantine.

## Implementation guidance
Extend connector-router/provider registry and secrets boundary.
