# Remote and Device Trust

Mobile/remote sessions use short-lived authenticated sessions, device identity, scoped capabilities, replay protection, sequence/cursor handling and immediate revocation.

Screen, camera, microphone and home/device control are separate capability scopes. Possession of a valid companion session does not imply access to all of them.

Remote actions are logged with actor/device/session/task/action identifiers. Sensitive values are redacted from routine events and only exposed to explicitly authorized diagnostics.
