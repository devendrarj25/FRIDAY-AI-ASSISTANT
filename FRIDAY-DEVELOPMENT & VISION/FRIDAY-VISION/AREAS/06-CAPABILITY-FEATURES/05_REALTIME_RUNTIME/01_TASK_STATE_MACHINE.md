# Task State Machine

`created → queued → planning → awaiting_approval → ready → running → paused → verifying → completed`

Alternate:
`cancel_requested → cancelling → cancelled`
`running → retrying → running`
`running → failed`
`failed → recoverable → queued`
`running → checkpointed → paused`

State is persisted independently from UI.
