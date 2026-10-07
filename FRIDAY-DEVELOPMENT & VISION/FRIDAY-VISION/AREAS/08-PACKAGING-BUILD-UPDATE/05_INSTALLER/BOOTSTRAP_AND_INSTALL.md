# Bootstrap and Installation

Installer responsibilities:

1. Select/confirm FRIDAY root.
2. Create directory layout.
3. Install application payload.
4. Provision required core runtimes/dependencies.
5. Verify hashes and executable readiness.
6. Create initial registry and manifests.
7. Create only necessary Windows integration entries.
8. Run first-boot verification.
9. Mark installation healthy.

The installer must not download arbitrary optional heavy assets without explicit user choice or a declared core manifest requirement.
