# Clean Machine Test Matrix

Test at minimum:

| Scenario | Expected |
|---|---|
| Fresh install | starts and reaches ready state |
| Fresh install without network after cached prerequisites | documented behavior; no partial activation |
| Update | official payload updates, user state survives |
| Update interrupted mid-download | old version remains healthy |
| Update interrupted mid-activation | recovery restores known-good state |
| Rebuild same version | same public version; new artifact evidence |
| User component before update | preserved |
| User component incompatible after update | preserved but marked incompatible |
| Optional runtime installed | remains after update |
| Heavy model installed | remains after update |
| Uninstall keep data | application removed; retained data policy honored |
| Uninstall all | FRIDAY root and FRIDAY-owned integration cleaned |
| Reinstall after keep-data | existing ecosystem discovered and restored |
