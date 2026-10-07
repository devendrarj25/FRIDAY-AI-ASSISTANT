# Mobile Remote Access, Control and Security

## Threat model
Assume stolen device, replayed command, expired session, compromised network, malicious connector output, prompt injection and an attacker attempting to turn remote observation into privileged execution.

## Control layers
1. device identity/authentication
2. private network authorization
3. application session authorization
4. FRIDAY capability scope
5. policy/action-risk evaluation
6. approval gate where required
7. execution authority
8. audit/evidence

Network access is not equivalent to action permission.

## Private overlay
A Tailscale-style deny-by-default policy is a useful reference because modern access control can express both network and application capabilities. Current Tailscale documentation recommends grants for new policies and emphasizes least privilege/zero trust. FRIDAY should adopt the principle, not vendor-lock the architecture.

## Remote desktop control
Remote control is capability-scoped, rate-limited and observable. Screen/control channels never inherit arbitrary filesystem/shell authority. High-risk actions still use the central governance gate.

## Revocation
Revoking a device/session invalidates its session and capability grants immediately. Existing task execution continues or pauses according to task policy; revocation never silently transfers authority to the revoked client.
