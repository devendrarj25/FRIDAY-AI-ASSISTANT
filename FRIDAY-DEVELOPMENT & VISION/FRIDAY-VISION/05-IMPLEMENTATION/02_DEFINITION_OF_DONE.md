# Definition of Done — AI OS Lifecycle

A lifecycle upgrade is complete only when:

- [ ] One canonical owner exists for each responsibility.
- [ ] User and official ownership are separated.
- [ ] Every installable component has a manifest.
- [ ] Dependencies resolve deterministically.
- [ ] Downloads are integrity-verified.
- [ ] Installation is staged/transactional.
- [ ] Update preserves user-owned resources.
- [ ] Migration has checkpoints.
- [ ] Rollback is tested.
- [ ] Recovery works without the main UI.
- [ ] CMD and GitHub produce equivalent release outputs.
- [ ] Version format is `Extreme.Major.Minor.Patch`.
- [ ] Rebuild keeps the same public version.
- [ ] Uninstall supports Keep Data and Remove All.
- [ ] Remove All is scoped to verified FRIDAY-owned state.
- [ ] Realtime health reflects actual state.
- [ ] Clean-machine tests pass.
- [ ] Documentation/manifests are synchronized.
