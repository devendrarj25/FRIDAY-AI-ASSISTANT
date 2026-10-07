# Voice Runtime Installation, Health, Repair and License Controls

Voice dependencies must integrate with the existing Install Manager rather than adding a second installer.

Runtime catalog entries describe artifact identity, version, platform, architecture, dependencies, checksum, license metadata, storage path and health probe. Activation is atomic where possible; failed activation rolls back to the last verified runtime.

Health states distinguish missing, installed, usable, degraded and failed. “Installed” is not claimed without a real probe. “Working” requires a runtime health check appropriate to the component.

License records must distinguish application code from model/runtime assets and preserve the existing project's license policy. Never silently package an asset whose license/redistribution status is unknown.
