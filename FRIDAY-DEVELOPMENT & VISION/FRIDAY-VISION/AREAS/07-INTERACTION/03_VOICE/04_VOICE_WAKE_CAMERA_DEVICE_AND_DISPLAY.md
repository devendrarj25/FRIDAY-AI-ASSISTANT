# Voice Wake, Camera, Device and Display Integration

## Wake
Wake-word detection is an activation mechanism, not an authorization mechanism. It may create a voice session, but privileged actions still require the normal policy/approval chain.

## Camera/screen
Camera and screen access are explicit capabilities with privacy state, device ownership and event/audit records. Voice cannot silently escalate into camera/screen access.

## Home/device control
Voice can request existing device capabilities through the same capability registry and governance. Device commands are verified against reported device state when possible.

## Multi-display
Display selection is a presentation concern based on active surface, device availability and user policy. The underlying task/artifact remains device-independent.
