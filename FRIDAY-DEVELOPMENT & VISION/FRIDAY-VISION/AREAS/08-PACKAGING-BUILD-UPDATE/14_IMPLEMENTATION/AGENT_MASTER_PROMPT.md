# Coding-agent master implementation prompt

Implement the FRIDAY Packaging/Build/Install/Update Future-Proof V2 contract in the existing repository.

Hard requirements:

1. Preserve existing architecture and extend existing owners. Do not create duplicate release/version/update/runtime systems.
2. Public version is exactly `Extreme.Major.Minor.Patch`; no revision/build suffix.
3. Implement UPDATE and REBUILD as distinct release intents. REBUILD keeps the exact same public version.
4. CMD and GitHub Actions must invoke the same release/build scripts and manifests.
5. Required core dependencies/runtimes must be declared, pinned, downloaded, verified and installed at controlled FRIDAY paths during build/bootstrap.
6. Heavy/optional resources must be Install Manager resources.
7. Implement ownership-aware component/runtime registry: official vs user vs generated vs cache vs recovery vs external.
8. Never let an official update delete or overwrite user-owned components, runtimes, models, projects, memory, knowledge or downloads.
9. Implement staged update transaction + durable journal + health/readiness + rollback.
10. Implement safe data migration checkpoints.
11. Keep FRIDAY-managed downloads and installations inside the FRIDAY root wherever technically possible.
12. Implement uninstall modes: keep data and remove all FRIDAY data. Verify ownership before recursive deletion.
13. Add release manifest, checksums, SBOM/provenance evidence and artifact verification.
14. Use npm ci for clean Node dependency installation and fail on lockfile drift.
15. Preserve x64-first Windows support and keep architecture extensible for ARM64; do not make ia32 a future dependency.
16. Do not use PNG or Mermaid for architecture diagrams; SVG only.
17. Update tests/docs/manifests together. A stale documentation/version manifest is a release failure.
18. After implementation, run all relevant tests and produce a concise implementation report with files changed, tests run, and known limitations.

Before editing, inspect existing files and determine the current owner of every responsibility. Do not overwrite blindly.
