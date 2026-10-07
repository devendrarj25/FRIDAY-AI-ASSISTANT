# Migration and Compatibility Strategy

Use additive compatibility adapters first. Existing callers continue using their current APIs while new canonical envelopes are emitted alongside them. Once all consumers use the canonical contract and regression evidence is complete, old duplicate fields can be deprecated in a separate controlled change.

Never perform a big-bang rewrite of `brain-engine`, task runtime, model registry or Electron authority. These are high-centrality components.

For storage migrations: write new records, backfill in a bounded job, verify counts/checksums, switch readers, then retain a rollback window. For event schema migrations: support old and new versions concurrently until all producers/consumers converge.
