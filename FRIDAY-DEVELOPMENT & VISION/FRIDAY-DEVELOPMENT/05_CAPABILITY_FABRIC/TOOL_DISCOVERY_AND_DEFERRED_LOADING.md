# Tool Discovery / Deferred Loading

Do not expose every tool to every model turn.

Pipeline:
`task intent → capability search → schema shortlist → policy filter → load selected tools → execute → unload`

Tool schemas should be compact and machine-readable.

If a tool is unavailable, return a typed recoverable error so the planner can choose an alternative.

High-risk tools require approval/authority before execution.
