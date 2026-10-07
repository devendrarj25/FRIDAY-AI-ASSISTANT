# Build Contract

## One pipeline, two launchers

CMD and GitHub Actions are two entry points into the same build contract. Neither is allowed to implement a second release algorithm.

```text
CMD ------------------+
                      +--> preflight --> dependency freeze --> build --> package --> verify --> evidence
GitHub Actions -------+
```

## Build stages
1. Clean workspace/preflight.
2. Validate canonical version and release intent.
3. Validate lockfiles and manifests.
4. Install Node dependencies with `npm ci`.
5. Prepare required Python/runtime dependencies.
6. Build renderer and Electron main process.
7. Validate official component manifests.
8. Package Windows installer/portable/dir targets as configured.
9. Sign when signing credentials are available/required.
10. Generate checksums, SBOM/provenance evidence and release manifest.
11. Run boot/readiness/install verification.
12. Produce immutable release evidence.

A build fails closed when a required dependency, manifest, version, signature, hash or test is missing.
