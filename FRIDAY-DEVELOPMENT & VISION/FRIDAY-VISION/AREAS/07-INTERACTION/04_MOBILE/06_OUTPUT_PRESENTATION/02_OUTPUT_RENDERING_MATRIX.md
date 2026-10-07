# Output Rendering Matrix

| Result type | Chat | Voice | Mobile | Notification |
|---|---|---|---|---|
| Simple answer | full text | spoken | text card | optional |
| Long research | rich sections + sources | concise spoken summary + offer detail | summary + sources/artifact | completion only |
| Table/data | table/chart | summarized key values | scrollable data card | key result only |
| Image/diagram | inline preview | describe + indicate visual | preview | thumbnail/deep link if useful |
| Generated file | artifact card + preview | announce completion | artifact card/download | completion link |
| Long-running task | live progress | concise milestone speech | live task timeline | significant milestones |
| Approval required | approval card | explicit spoken request | approval card | approval alert |
| Error | actionable explanation | concise recovery message | error/recovery card | important failure only |
| Device action | result + evidence | concise confirmation | result + device state | only if important |
| Streaming answer | incremental text | streaming audio | incremental card/text | never raw stream |

## Rules
- Never force visual-only data into speech verbatim.
- Never hide a critical approval request in a passive visual indicator.
- Never expose raw internal chain-of-thought as an output requirement; expose concise rationale/evidence appropriate to the product.
- Preserve citations/provenance when the result depends on external evidence.
- Preserve artifact identity/version across every surface.
