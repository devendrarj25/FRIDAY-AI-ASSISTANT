# Source vs Runtime vs User State

## Source-controlled
- TypeScript/React/Electron source
- Python kernel source
- configuration schemas
- official skills/tools/agents/plugins/workflows when they are part of the repository
- build scripts
- installer/update code
- docs and release contracts

## Generated release payload
- compiled renderer
- packaged Electron application
- generated release manifests
- SBOM/evidence
- signed installer artifacts

## Machine runtime
- required Node/Python/runtime payload actually needed by FRIDAY
- native libraries
- downloaded package caches used by the installer

## User-owned state
- manually imported components
- optional runtimes
- models
- projects
- memory/knowledge
- user settings
- user downloads
- custom workflows

Never solve a source-update problem by copying a live user directory into a new release package. Keep ownership explicit.
