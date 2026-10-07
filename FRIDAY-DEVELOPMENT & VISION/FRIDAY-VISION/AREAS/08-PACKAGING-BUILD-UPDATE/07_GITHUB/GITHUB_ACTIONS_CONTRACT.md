# GitHub Actions Contract

CI is a second invocation of the same release/build contracts.

Recommended stages:
1. source checkout
2. clean dependency installation
3. static/tests
4. build
5. package
6. verify artifacts
7. generate SBOM/provenance evidence
8. sign where configured
9. publish draft release assets
10. verify assets
11. publish immutable release

GitHub artifact attestations and immutable releases should be enabled where repository permissions/policy allow. They improve provenance and prevent silent post-publication asset replacement.
