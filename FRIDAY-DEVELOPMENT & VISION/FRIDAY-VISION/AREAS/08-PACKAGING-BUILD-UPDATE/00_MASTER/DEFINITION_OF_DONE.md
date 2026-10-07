# Definition of Done

A packaging/update implementation is complete only when all gates pass:

- [ ] Canonical version is exactly `Extreme.Major.Minor.Patch`.
- [ ] No revision/build number exists in the public FRIDAY version.
- [ ] UPDATE and REBUILD are distinct operations.
- [ ] REBUILD keeps the exact same public version.
- [ ] CMD and GitHub use the same release engine and release contract.
- [ ] Package-lock is authoritative for Node dependency installation; `npm ci` is used for clean CI/local release builds.
- [ ] Required core runtimes/libraries are explicitly declared, hashed, staged and verified.
- [ ] Heavy/optional resources are not silently bundled into the core installer.
- [ ] Every installed component has identity, type, owner, version, source, compatibility, path, hash and lifecycle state.
- [ ] Official and user-owned components are physically and logically separated.
- [ ] User components survive official updates.
- [ ] User data, projects, downloads, memory and knowledge are outside replaceable application payload.
- [ ] Update never deletes user-owned components/data.
- [ ] Data migrations are versioned, checkpointed and rollback-aware.
- [ ] Update downloads are staged and verified before activation.
- [ ] Update transaction has a durable journal and last-known-good state.
- [ ] Failed update returns to the last-known-good application/runtime state.
- [ ] Rebuild artifacts are immutable and traceable to a source commit and build evidence even though the public version is unchanged.
- [ ] Release artifacts have checksums and provenance evidence.
- [ ] Published releases are immutable where the repository platform supports it.
- [ ] Installer/uninstaller can verify FRIDAY ownership before deleting anything.
- [ ] “Remove All FRIDAY Data” deletes only the verified FRIDAY root plus FRIDAY-created OS integration artifacts.
- [ ] Clean-machine install, update, rollback, uninstall-keep-data and uninstall-all tests pass.
- [ ] Documentation and machine-readable manifests agree.
