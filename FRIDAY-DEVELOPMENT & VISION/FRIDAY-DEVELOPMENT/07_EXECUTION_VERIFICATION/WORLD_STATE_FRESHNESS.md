# World-State Freshness

Screen/browser/device/application observations are snapshots, not permanent truth.

Each observation has:
- observed_at;
- source;
- freshness TTL;
- confidence;
- scope;
- hash/version when useful.

Before consequential action:
- re-check stale state;
- verify target identity;
- confirm postcondition after action.

Never reuse an old UI observation as if it were current.
