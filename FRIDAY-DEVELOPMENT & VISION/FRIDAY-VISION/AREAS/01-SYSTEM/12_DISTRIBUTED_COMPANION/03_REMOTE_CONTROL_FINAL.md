# Companion — Final Remote Control

Mobile is another shell over FRIDAY, not a second assistant.

Remote operations support:
- send a new turn;
- continue an existing run;
- observe live state;
- receive notifications;
- approve/deny gated actions;
- pause/resume/cancel;
- inspect artifacts/evidence;
- request safe computer-use takeover.

Preferred off-network path is a private overlay such as Tailscale/WireGuard-style networking. Do not expose FRIDAY's privileged control plane directly to the public internet. Pairing, device identity, least privilege, session expiry, audit and revocation are mandatory.
