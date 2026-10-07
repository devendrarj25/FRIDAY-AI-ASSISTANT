# Release Gates

Hard gates:
- typecheck/build success
- tests
- dependency consistency
- manifest validation
- version consistency
- artifact hash generation
- installer verification
- boot verification
- readiness test
- clean-machine scenario where available
- update preservation test
- rollback test
- uninstall cleanup test

No release should be published merely because the EXE was created.
