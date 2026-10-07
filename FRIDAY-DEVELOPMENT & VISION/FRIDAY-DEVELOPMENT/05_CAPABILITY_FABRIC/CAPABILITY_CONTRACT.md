# Capability Fabric Contract

Skills, tools, agents, modules, connectors and workflows are capability classes.

A capability record must expose:
- stable id/version;
- owner;
- provenance;
- availability/health;
- permissions;
- privacy/data classes;
- input/output schema;
- risk;
- verification strategy.

Lifecycle:
`discovered → qualified → installed → registered → healthy → authorized → available`

Registration does not imply health.
Health does not imply authorization.
Authorization does not imply successful execution.
