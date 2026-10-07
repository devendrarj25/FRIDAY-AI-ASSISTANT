# Capability graph

FRIDAY should model capabilities as a graph, not a boolean flat map.

```text
Model
 ├─ input modality ── text/image/audio/video/document
 ├─ output modality ── text/image/audio/video
 ├─ cognitive ── reasoning/coding/planning/summarization
 ├─ agentic ── tools/function-calling/computer-use
 ├─ retrieval ── embeddings/rerank/search
 ├─ generation ── image/video/audio
 └─ constraints ── context/max-output/rate-limit/latency
```

## Why graph form matters

A model may support image input but not image output. A model may support tools only on one API surface. A provider may expose the same model with different capabilities on different deployments. A local quantization may have different context limits from a cloud deployment.

Therefore capability is a property of:

`Model + Version + Deployment + Endpoint + Configuration`

not merely the model family.
