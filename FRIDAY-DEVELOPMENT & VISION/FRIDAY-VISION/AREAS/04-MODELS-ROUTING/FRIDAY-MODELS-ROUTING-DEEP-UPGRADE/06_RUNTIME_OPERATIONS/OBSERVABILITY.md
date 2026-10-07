# Model observability

Each invocation gets an internal `model_execution_trace`:

- task class
- selected mode
- candidate set size
- filtered reasons
- chosen endpoint
- route plan
- start/end time
- TTFT
- tokens/sec if available
- input/output token counts if provider exposes them
- retry count
- fallback count
- error category
- validation result
- estimated cost

## User-facing explanation

Do not expose raw internal traces by default. A concise explanation can say:

> “I used a fast local model first and escalated to a stronger cloud model because the task required long-context reasoning.”

When the user asks “why this model?”, expose the relevant decision factors without exposing secrets or hidden chain-of-thought.
