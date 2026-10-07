# Rollback Contract

Rollback is for application/runtime transaction failure, not for deleting user state.

Keep at least one known-good official application state while an update is being validated.

Rollback must restore:
- active official application payload
- official runtime payload if changed
- updater transaction state

Rollback must not revert/delete:
- user components
- user models
- projects
- downloads
- memory/knowledge
- user settings

After rollback, FRIDAY should run the same health/readiness checks used for activation.
