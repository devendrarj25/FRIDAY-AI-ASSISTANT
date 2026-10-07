# Production Test Matrix

## Install
- clean Windows machine
- existing Windows machine
- low disk space
- interrupted download
- corrupted package
- no network
- restricted permissions

## Update
- patch/minor/major/extreme
- same-version rebuild
- update with user components
- update with incompatible user component
- interrupted update
- failed migration
- failed health check
- rollback
- power loss during staging

## Components
- install agent/skill/tool/plugin/workflow
- dependency conflict
- repair
- disable
- uninstall
- shared dependency retention

## Runtime
- missing runtime
- wrong version
- corrupted runtime
- architecture mismatch
- repair/reinstall
- multiple runtime versions

## Uninstall
- keep data
- remove all
- locked files
- user-created files under FRIDAY root
- verify no unrelated OS paths are removed
