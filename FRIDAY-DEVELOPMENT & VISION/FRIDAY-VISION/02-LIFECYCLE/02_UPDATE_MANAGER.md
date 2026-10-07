# Update Manager — Transactional Architecture

## Official update
`check → download → verify → compatibility → snapshot → stage → migrate → health-check → activate → commit`.

## Preservation
The updater never treats the entire FRIDAY directory as disposable.

It replaces only the official application payload and official component payloads.

User-installed:
- agents
- skills
- tools
- plugins
- workflows
- runtimes
- models
- projects
- memory
- knowledge
remain preserved.

## Failure
`download fail → discard stage`
`migration fail → restore checkpoint`
`health fail → switch previous version`
`activation fail → recovery mode`

## Journal
Persist:
- transaction ID
- old version
- target version
- stages
- file manifests
- migration checkpoints
- health results
- final status

The journal must be recoverable after power loss.
