# Core vs Optional Payload Policy

## Core installer payload
Only include components needed for FRIDAY to start and provide its promised baseline capabilities, plus reasonably sized dependencies required for those capabilities.

Examples can include:
- Electron runtime
- required Node/Python runtime payload
- required native libraries
- FRIDAY kernel and baseline UI
- baseline official skills/agents/tools/plugins/workflows
- updater/install manager/recovery

The exact list must be machine-readable in a core payload manifest.

## Optional/heavy payload
Install through the FRIDAY Install Manager:
- large AI models
- GPU/CUDA-class packages when optional
- large embeddings
- extra agents/skills/tools/plugins/workflows
- alternative runtimes
- large developer toolchains
- optional language/runtime packs

Do not classify by file size alone. Classify by whether FRIDAY can start and deliver its baseline contract without it, and by installation/storage cost.
