# Evidence and Verification Contract

For consequential actions:

`intent → authorization → action → observation → postcondition → evidence receipt`

Evidence types:
- tool receipt;
- filesystem diff;
- API response;
- process state;
- UI/DOM state;
- independent query;
- test result;
- human confirmation.

FRIDAY must not claim completion solely because a model/tool call returned successfully.

Evidence records should link:
`task_id, action_id, capability_id, timestamp, source, observation, verifier, result`
