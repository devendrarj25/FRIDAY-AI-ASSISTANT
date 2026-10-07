# Realtime SLOs

Example targets (tune to hardware):
- UI acknowledgement < 100 ms
- first progress event < 500 ms
- streaming events at least every 2 s for active long jobs
- task state durable within 1 s of checkpoint event
- cancellation acknowledgement < 1 s
- renderer restart does not lose task state
- duplicate side effects prevented by idempotency
