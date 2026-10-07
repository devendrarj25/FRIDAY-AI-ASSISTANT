# Agent Harness Patterns

### Long-horizon loop
`goal → plan → act → inspect → verify → update plan → continue`

### Subagent loop
`parent → bounded delegation → isolated context → artifact/evidence → parent synthesis`

### Checkpoint loop
`before mutation → snapshot → execute → verify → commit or rewind`

### Hook loop
`before_tool → policy/validation → tool → after_tool → telemetry/evidence`

### Context loop
`compact state → retrieve only relevant memories/skills/files → execute → persist useful state`

### FRIDAY synthesis
Implement these as runtime middleware rather than bespoke logic inside each agent.
