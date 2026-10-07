# Remote Session Security Model

## Security layers
1. Network/transport security.
2. Device/user identity.
3. FRIDAY session authentication.
4. Capability scope.
5. Action-risk governance.
6. Artifact/data authorization.
7. Audit/observability.

## Pairing
Pairing should establish a device identity and scoped trust record. Prefer short-lived pairing codes/QR flows and explicit confirmation. Never place long-lived master secrets in URLs, QR codes or client-visible source.

## Session
Sessions have issuance, expiry/renewal, revocation, device identity, owner identity, policy version, capability scope and traceability. Reconnect requires validation; it does not inherit authority merely because the device was previously connected.

## Least privilege
The preferred remote-network model is deny-by-default and least privilege, with application-level capability restrictions layered above network access. Tailscale's current Grants model is a useful reference pattern: network and application capabilities can be scoped separately. FRIDAY remains vendor-neutral.

## Revocation
Revocation blocks new commands immediately. Already-running work follows FRIDAY's task/governance policy and remains observable through other authorized surfaces; it is not silently killed unless policy requires cancellation.

## Sensitive controls
Credentials, system/destructive actions, security changes and other high-risk operations remain behind FRIDAY's existing governance gate. Mobile cannot create an alternate approval authority.
