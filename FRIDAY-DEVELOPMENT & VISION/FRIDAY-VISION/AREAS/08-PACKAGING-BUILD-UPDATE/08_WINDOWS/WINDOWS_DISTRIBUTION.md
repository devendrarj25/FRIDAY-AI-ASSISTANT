# Windows Distribution

## Immediate implementation
Keep Electron + electron-builder + NSIS for the primary FRIDAY installer/update path because it aligns with the current repository and electron-updater's documented Windows NSIS support.

## Future option
MSIX may be added as a parallel distribution channel after the self-contained FRIDAY root/component lifecycle is proven. MSIX offers strong clean install/uninstall/update semantics, but the mutable user-component ecosystem must be modeled carefully before making MSIX the primary format.

## Architecture requirement
Regardless of installer format, FRIDAY's managed root, ownership registry, component preservation and data migration contracts remain the source of truth.
