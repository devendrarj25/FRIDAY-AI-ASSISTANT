# Model Card 2.0 — evidence-first model intelligence

A model card is not just `name + context`.

## Required groups

### Identity

- stable internal ID
- provider-native ID
- publisher
- family
- version
- alias
- deployment ID
- endpoint ID

### Lifecycle

- stable / preview / experimental / deprecated / retired / unknown
- announced retirement date
- end-of-life date
- replacement candidates
- source URL

### Capability

- text input/output
- image input/output
- audio input/output
- video input/output
- embeddings
- reranking
- transcription
- speech synthesis
- reasoning
- coding
- tool calling
- structured output
- JSON schema
- computer-use
- research/search
- streaming

Each capability has:

`value + evidence_source + confidence + observed_at + expires_at`

### Limits

- context window
- max output
- input size
- image/audio/video constraints
- concurrency
- rate limit
- timeout
- request size

### Economics

- input price
- output price
- cached-input price
- reasoning/token surcharge if applicable
- provider free-tier state
- account-specific quota if known
- pricing source + timestamp

### Performance

- cold-start latency
- p50/p95 latency
- tokens/sec
- time-to-first-token
- error rate
- success rate
- cancellation rate
- local memory footprint
- VRAM/RAM fit

### Runtime

- local/cloud
- runtime
- quantization
- parameter count
- model file size
- architecture/family
- GPU/CPU requirements
- context configuration
- loaded/unloaded state

## Evidence hierarchy

1. direct official runtime/model metadata
2. official provider API response
3. official provider docs
4. official model card/repository
5. FRIDAY verified probe
6. curated internal registry
7. heuristic inference

The UI must show the evidence tier when useful.
