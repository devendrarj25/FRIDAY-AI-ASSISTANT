# Mobile Remote Task Continuity

A mobile client can observe a task for minutes or hours without owning it. The task persists on the FRIDAY runtime.

For long-running work, the client may use realtime streaming while connected and a durable notification/retrieval mechanism when disconnected. A2A's current task/artifact/streaming/push model is a useful interoperability reference, but FRIDAY keeps its own task ledger as the internal authority.

When reconnecting, the client asks for current task version and cursor, then obtains missing events or a fresh snapshot. It never reconstructs authority from local cached UI state.
