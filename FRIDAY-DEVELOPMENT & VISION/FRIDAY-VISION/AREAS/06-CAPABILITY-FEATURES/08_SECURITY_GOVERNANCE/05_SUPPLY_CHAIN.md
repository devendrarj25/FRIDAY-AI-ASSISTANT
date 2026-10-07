# Agent Supply Chain Security

Treat skills, MCP servers, plugins, hooks and agent configs as executable dependencies.

Checks:
- pinned version/commit
- signature/provenance
- permission diff
- network behavior
- executable commands
- dependency scan
- policy compatibility
- sandbox smoke test
- regression tests

Recent research shows agent harness configurations themselves can contain security defects; FRIDAY should scan before activation.
