# Security Invariants

1. Renderer is untrusted.
2. Privileged operations stay behind trusted boundaries.
3. Tool arguments are validated before execution.
4. Approvals bind to exact action scope and lifetime.
5. Secrets do not enter ordinary model context.
6. External content is untrusted input.
7. MCP/A2A peers do not gain FRIDAY authority merely by connecting.
8. Model output is data, not a permission.
9. Self-improvement cannot bypass governance.
10. Updates are integrity-verified before activation.

Use existing Electron isolation/sandbox/IPC protections rather than inventing a second security layer.
