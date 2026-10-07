# Failure injection matrix

Inject at least:

- DNS failure
- connection refused
- TLS failure
- timeout
- 429 with Retry-After
- 500
- 502/503/504
- invalid key
- expired credential
- invalid model ID
- model retired
- capability mismatch
- context overflow
- malformed tool call
- malformed structured output
- local runtime crash
- local model missing
- corrupted model artifact
- interrupted download
- provider catalogue stale
- provider returns empty model list
- provider returns malformed metadata
- two providers report the same model with different capability sets
- gateway available but downstream provider unavailable

For every injection verify:

`classify → retry/fallback/quarantine → recover → trace`
