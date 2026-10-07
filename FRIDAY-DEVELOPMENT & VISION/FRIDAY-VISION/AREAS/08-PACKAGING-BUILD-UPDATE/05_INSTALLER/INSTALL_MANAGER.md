# Install Manager Contract

The Install Manager is the owner for optional/user component lifecycle.

Flow:

`discover -> resolve -> download -> hash verify -> stage -> dependency check -> install -> register -> health check -> activate -> refresh`

It supports:
- agent/skill/tool/plugin/workflow packages
- optional runtimes
- models
- packages/libraries intended for managed runtime use

Each package must have a manifest. Manual ZIP upload follows the same validation path as online download.

Manual upload must never directly extract into the official component tree.

Install Manager must expose realtime state and resumable/cancellable downloads where practical.
