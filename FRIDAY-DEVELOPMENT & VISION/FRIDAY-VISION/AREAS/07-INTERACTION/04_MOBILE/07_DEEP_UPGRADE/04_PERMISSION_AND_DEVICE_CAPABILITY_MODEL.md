# Mobile Browser Permission and Device Capability Model

## Principle

FRIDAY must work with browser security, never around it.

A mobile browser cannot be treated as a privileged desktop shell. Camera, microphone, notifications and other browser APIs are controlled by the browser/OS and may require user permission, secure context, user gesture, origin restrictions, or browser-specific support.

## Permission layers

### Layer A — browser/OS permission
Examples:
- microphone
- camera
- notifications
- local/network-related browser permissions where applicable
- media/device access

### Layer B — FRIDAY session permission
Examples:
- voice input enabled for this session
- camera sharing enabled
- remote control enabled
- artifact upload/download enabled

### Layer C — FRIDAY capability authorization
Examples:
- PC screen observation
- remote application control
- task execution
- device control

### Layer D — action-risk governance
High-risk/destructive/system actions retain the existing FRIDAY approval gate.

Granting a browser microphone permission does not grant PC shell authority.

## Permission UX

The mobile UI should expose a permission center showing:
- capability
- browser support
- current browser permission state
- FRIDAY session state
- why access is needed
- user action to request access
- denied state
- recovery instructions
- active-use indicator
- stop/release control

Request sensitive browser permissions only from a direct user action when the platform requires it. Do not request camera/microphone merely on page load.

## Camera and microphone

Use feature detection first. Then check/query permission where supported. Then request access through the relevant browser API from an explicit user gesture.

If permission is:
- granted → initialize media
- prompt → explain and request
- denied → show recovery path without looping prompts
- unsupported → show unsupported state and fallback

## Secure context

Production remote voice/camera use must use a secure origin/transport appropriate to the deployment. Browser media capture requires a secure context and user permission.

Local development may use localhost-specific secure-context behavior, but this must not be confused with production remote access.

## Permissions Policy

If camera/microphone are embedded or composed through frames, the deployment must configure Permissions Policy correctly; otherwise the browser may deny access without presenting the expected prompt.

## Audio output

Browser autoplay policies may require user interaction before audio playback. Voice start/resume flows must have a user-gesture-safe activation path and must not claim speech output is active until playback is actually confirmed.

## Mobile browser differences

Do not promise identical hardware API behavior across every phone/browser. Maintain a capability matrix and graceful degradation.

Examples:
- full realtime voice
- voice with manual start
- text-only fallback
- camera unavailable
- notifications unavailable
- push available only under supported conditions
- installed/PWA experience available or browser-only

## Stop/revoke

When the user stops microphone/camera use, release tracks and clear the active-use state. FRIDAY session permissions and browser permissions are distinct; revocation of one must not be misrepresented as revocation of the other.
